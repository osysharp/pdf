// PdfViewer@1: the shim behind `control PdfViewer` (pdf.osy).
//
// It owns four things and no more: getting the bytes, getting pdf.js, painting a page, and knowing which page is
// showing. Everything a reader presses (page numbers, zoom controls, a download link) is the app's, rendered into the
// `Toolbar` slot and driven through the commands below.
//
// The bytes are fetched whole, once (see `openDocument` in pdf-open.ts). pdf.js prefers to range-request a document,
// but the platform's file endpoint does not serve byte ranges, so a range request would receive the entire body
// anyway. Fetching once and handing pdf.js a buffer is the same number of bytes in one request, and it takes the
// signed URL out of the picture as soon as the document is open, so nothing can expire underneath a reader.
import type { PdfViewerProps, PdfViewerHost, PdfViewerHandle } from './pdf.control';
import { loadPdfJs, openDocument, type PdfJs, type PdfDoc } from './pdf-open';

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300, 400];

// The text layer's CSS is part of its contract, not decoration. pdf.js positions each text run with custom
// properties this stylesheet consumes (`--total-scale-factor`, `--font-height`, `--scale-x`, `--rotate`) and relies
// on it to paint the runs `color: transparent`. Without it every run renders as visible black text at the wrong
// size, over the page it is supposed to be invisible on.
//
// Inlined rather than shipped as a CSS chunk because it is a few hundred bytes, not worth a round trip of its own.
// Scoped to the kit's own class, so an app that styles `.textLayer` cannot reach it, and vice versa.
const TEXT_LAYER_CSS = `
.osy-pdf-text{position:absolute;text-align:initial;inset:0;overflow:clip;opacity:1;line-height:1;
  text-size-adjust:none;-webkit-text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;
  caret-color:CanvasText;z-index:0;--min-font-size:1;
  --text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv:calc(1 / var(--min-font-size));}
.osy-pdf-text :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;}
.osy-pdf-text > :not(.markedContent),.osy-pdf-text .markedContent span:not(.markedContent){
  z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));
  --scale-x:1;--rotate:0deg;
  transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));}
.osy-pdf-text .markedContent{display:contents;}
.osy-pdf-text span[role="img"]{user-select:none;-webkit-user-select:none;cursor:default;}
`;

let stylesInstalled = false;
function ensureStyles() {
  // Once per DOCUMENT, not per control: two viewers on a page share one stylesheet, and re-adding it per mount
  // would leave a copy behind on every destroy.
  if (stylesInstalled || document.querySelector('style[data-osy-pdf]')) { stylesInstalled = true; return; }
  const style = document.createElement('style');
  style.setAttribute('data-osy-pdf', '');
  style.textContent = TEXT_LAYER_CSS;
  document.head.append(style);
  stylesInstalled = true;
}

export function mount(el: HTMLElement, props: PdfViewerProps, host: PdfViewerHost): PdfViewerHandle {
  // ── live state ────────────────────────────────────────────────────────────────────────────────────────────────
  let fileAsset = props.fileAsset;
  let page = props.page ?? 1;
  let fit = props.fit ?? 'width';
  let zoom = props.zoom ?? 100;
  let layout = props.layout ?? 'continuous';

  let pdfjs: PdfJs | null = null;
  let doc: PdfDoc | null = null;
  let pageCount = 0;
  let rendered = false;
  let failure: string | null = null;
  let destroyed = false;
  // Every load is stamped, so a document opened while a previous one is still in flight cannot have the older
  // result land on top of it. Without this, changing `fileAsset` twice quickly shows whichever finished last.
  let generation = 0;

  ensureStyles();

  // ── DOM the shim owns ─────────────────────────────────────────────────────────────────────────────────────────
  el.textContent = '';
  const root = document.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;'
    + `background:${host.tokens.cssVar('colors.bg')};color:${host.tokens.cssVar('colors.onbg')}`;

  // The app's toolbar, if it wrote one. Rendered ONCE — re-rendering into the same element leaks the instance.
  const chrome = document.createElement('div');
  const toolbarSlot = host.slots?.Toolbar?.render(chrome);
  if (toolbarSlot) root.append(chrome);

  const scroller = document.createElement('div');
  scroller.style.cssText = 'flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;'
    + `align-items:center;gap:${host.tokens.cssVar('space.gutter')};padding:${host.tokens.cssVar('space.gutter')}`;
  // The document is a document: name it so, or a screen reader meets an unlabelled scrolling region.
  scroller.setAttribute('role', 'document');
  root.append(scroller);
  el.append(root);

  const status = document.createElement('div');
  status.style.cssText = `padding:${host.tokens.cssVar('space.pagepad')};color:${host.tokens.cssVar('colors.textmuted')}`;
  status.textContent = 'Loading…';
  scroller.append(status);

  // ── one page's DOM ────────────────────────────────────────────────────────────────────────────────────────────
  // A canvas is painted only when the page comes near the viewport, so a 200-page document costs 200 empty frames
  // rather than 200 rasters.
  interface Slot {
    frame: HTMLElement; canvas: HTMLCanvasElement; text: HTMLElement;
    n: number; drawn: boolean; task: { cancel(): void } | null;
  }
  const slots: Slot[] = [];
  // Two observers, because they answer different questions.
  //
  //   `drawAhead` wants a generous margin: paint a screen ahead of the reader, so scrolling meets a painted page
  //   rather than a white one.
  //   `current` wants no margin at all: "which page am I looking at" is about the actual viewport.
  //
  // One observer with `rootMargin: '100% 0px'` cannot serve both, because `intersectionRatio` is computed against the
  // expanded root: in a short document every page would read as more than half visible at mount, `page` would walk to
  // the last page before the reader did anything, and each step would emit `pageChanged`. In a real app every emit
  // re-renders, which re-enters the control and fires the observer again, and the page can stop responding.
  let drawAhead: IntersectionObserver | null = null;
  let current: IntersectionObserver | null = null;

  // Measured, never assumed. The padding comes from the app's `Space.Gutter` theme token, which an app may set to
  // anything, so a hard-coded value would overflow or under-fill every theme but one.
  const inner = () => {
    const cs = getComputedStyle(scroller);
    const px = (v: string) => parseFloat(v) || 0;
    return {
      w: scroller.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
      h: scroller.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
    };
  };

  const scaleFor = (v: { width: number; height: number }) => {
    const { w, h } = inner();
    const base = fit === 'width' ? w / v.width
      : fit === 'page' ? Math.min(w / v.width, h / v.height)
        : 1;
    // A zero-width container (a viewer mounted into a hidden tab, or measured before layout) would scale every page
    // to nothing and paint a 0×0 canvas that never repairs itself. Fall back to 1:1 and let the next rescale fix it.
    return (base > 0 ? base : 1) * (zoom / 100);
  };

  async function drawSlot(slot: Slot) {
    if (!doc || slot.drawn || destroyed) return;
    const mine = generation;
    slot.drawn = true;                                 // claim it before awaiting, or a fast scroll draws it twice
    try {
      const pdfPage = await doc.getPage(slot.n);
      if (destroyed || mine !== generation) return;
      const scale = scaleFor(pdfPage.getViewport({ scale: 1 }));
      const viewport = pdfPage.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;      // draw at device resolution or text is soft on a retina panel
      slot.canvas.width = Math.floor(viewport.width * ratio);
      slot.canvas.height = Math.floor(viewport.height * ratio);
      slot.canvas.style.width = `${Math.floor(viewport.width)}px`;
      slot.canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = slot.canvas.getContext('2d')!;
      ctx.scale(ratio, ratio);
      const task = pdfPage.render({ canvasContext: ctx, viewport });
      slot.task = task;
      await task.promise;
      if (destroyed || mine !== generation) return;

      // The text layer is not decoration. Without it the document is an image: nothing to select, nothing to find, and
      // nothing for a screen reader, which is an accessibility failure, not a missing nicety. It is transparent text
      // positioned over the raster.
      slot.text.textContent = '';
      slot.text.className = 'osy-pdf-text';
      // `--total-scale-factor` is how the stylesheet turns each run's intrinsic height into a rendered font size.
      // Missing, every `font-size: calc(…)` resolves to nothing and the runs collapse to the inherited size — the
      // text lands in roughly the right places at entirely the wrong scale, which reads as a broken document.
      slot.text.style.cssText = `width:${Math.floor(viewport.width)}px;height:${Math.floor(viewport.height)}px;`
        + `--total-scale-factor:${scale}`;
      slot.text.setAttribute('aria-label', `Page ${slot.n}`);
      await new pdfjs!.TextLayer({
        textContentSource: await pdfPage.getTextContent(), container: slot.text, viewport,
      }).render();
      pdfPage.cleanup();
      if (!destroyed && mine === generation) { rendered = true; slot.task = null; }
    } catch (err) {
      // A failed draw must not be retried. If it were marked undrawn again, a page whose draw genuinely throws would
      // re-enter on the observer's next tick, throw again and emit `failed` again, which re-renders the app, which
      // fires the observer again: a tight loop that can hang the page.
      //
      // A cancelled draw is the opposite and must stay retryable: that is the normal path when a rescale supersedes a
      // render in flight, and refusing to redraw would leave the page blank at the new zoom.
      const cancelled = mine !== generation || (err as Error)?.name === 'RenderingCancelledException';
      slot.drawn = !cancelled;
      if (destroyed || cancelled) return;
      fail(`Page ${slot.n} could not be drawn: ${(err as Error).message}`);
    }
  }

  function buildSlots() {
    drawAhead?.disconnect();
    current?.disconnect();
    for (const s of slots) s.task?.cancel();
    slots.length = 0;
    scroller.textContent = '';
    if (!doc) return;

    const shown = layout === 'single' ? [page] : Array.from({ length: pageCount }, (_, i) => i + 1);
    for (const n of shown) {
      const frame = document.createElement('div');
      frame.style.cssText = 'position:relative;flex:none;'
        + `box-shadow:${host.tokens.cssVar('shadow.raised')};background:#fff`;
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block';
      const text = document.createElement('div');
      frame.append(canvas, text);
      scroller.append(frame);
      slots.push({ frame, canvas, text, n, drawn: false, task: null });
    }

    const slotFor = (el: Element) => slots.find(s => s.frame === el);

    drawAhead = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const slot = e.isIntersecting ? slotFor(e.target) : undefined;
        if (slot) void drawSlot(slot);
      }
    }, { root: scroller, rootMargin: '100% 0px', threshold: 0 });

    current = new IntersectionObserver((entries) => {
      // The MOST visible page wins, and only a real change is announced — an app that binds `page` would otherwise
      // re-render on every scroll frame. The READER moved this one, so it IS announced.
      const best = entries
        .filter(e => e.isIntersecting && e.intersectionRatio > 0.5)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const slot = best && slotFor(best.target);
      if (slot && slot.n !== page) { page = slot.n; host.emit('pageChanged', page); }
    }, { root: scroller, threshold: [0.5] });

    for (const s of slots) { drawAhead.observe(s.frame); current.observe(s.frame); }
  }

  function fail(reason: string) {
    // Say it ONCE. `failed` reaching the app is what makes it re-render, so repeating an unchanged reason is a
    // feedback loop dressed as diagnostics — and the second copy tells nobody anything the first did not.
    const repeat = failure === reason;
    failure = reason;
    rendered = false;
    status.textContent = reason;
    if (!status.isConnected) scroller.prepend(status);
    if (!repeat) host.emit('failed', reason);
  }

  // ── open ──────────────────────────────────────────────────────────────────────────────────────────────────────
  async function open() {
    const mine = ++generation;
    rendered = false; failure = null; pageCount = 0;
    status.textContent = 'Loading…';
    scroller.textContent = ''; scroller.append(status);

    try {
      pdfjs ??= await loadPdfJs(host);
      if (destroyed || mine !== generation) return;

      doc = await openDocument(pdfjs, host, fileAsset);
      if (destroyed || mine !== generation) { void doc.destroy(); doc = null; return; }

      pageCount = doc.numPages;
      if (page > pageCount) page = pageCount;
      status.remove();
      buildSlots();
      host.emit('loaded', pageCount);
    } catch (err) {
      if (destroyed || mine !== generation) return;
      fail((err as Error).message);
    }
  }

  void open();

  // Who moved the page decides whether to announce it. `page` is a two-way value: the app binds it, and scrolling
  // changes it. If a move the app asked for also emitted `pageChanged`, the app would write the value back as a prop,
  // `update` would move the viewer again, `scrollIntoView` would fire the observer, and the observer would announce
  // another change: a cycle with no exit.
  //
  // So a move the app asked for is silent (the app already knows), and a move the reader made is announced once. The
  // app echoing that value straight back is then a no-op, because it equals what the viewer already holds.
  const goTo = (n: number, announce: boolean) => {
    const next = Math.min(Math.max(n, 1), pageCount || 1);
    if (next === page) return;
    page = next;
    if (layout === 'single') buildSlots();
    else slots.find(s => s.n === next)?.frame.scrollIntoView({ block: 'start' });
    if (announce) host.emit('pageChanged', page);
  };
  const rescale = () => {
    for (const s of slots) { s.task?.cancel(); s.drawn = false; }
    for (const s of slots) void drawSlot(s);
  };
  const step = (dir: 1 | -1) => {
    const i = ZOOM_STEPS.findIndex(z => z >= zoom);
    const at = i === -1 ? ZOOM_STEPS.length - 1 : i;
    zoom = ZOOM_STEPS[Math.min(Math.max(at + dir, 0), ZOOM_STEPS.length - 1)];
    rescale();
  };

  return {
    update(next: PdfViewerProps) {
      const wasFit = fit, wasZoom = zoom, wasLayout = layout;
      fit = next.fit ?? 'width';
      zoom = next.zoom ?? 100;
      layout = next.layout ?? 'continuous';
      if (next.fileAsset !== fileAsset) {                 // a different document: start over
        fileAsset = next.fileAsset;
        page = next.page ?? 1;
        void doc?.destroy(); doc = null;
        void open();
        return;
      }
      if (layout !== wasLayout) buildSlots();
      else if (fit !== wasFit || zoom !== wasZoom) rescale();
      if (next.page !== undefined && next.page !== page) goTo(next.page, false);   // the app asked — it knows
    },
    commands: {
      nextPage: () => goTo(page + 1, true),
      previousPage: () => goTo(page - 1, true),
      zoomIn: () => step(1),
      zoomOut: () => step(-1),
      resetZoom: () => { zoom = 100; rescale(); },
    },
    // Answered from live state, never from a field set at mount — a probe that reported what was true at mount
    // would pass a test the moment the control stopped working.
    probe: () => ({ page, pageCount, zoom, rendered, failure }),
    destroy() {
      destroyed = true;
      drawAhead?.disconnect();
      current?.disconnect();
      for (const s of slots) s.task?.cancel();
      toolbarSlot?.destroy();
      void doc?.destroy();
      el.textContent = '';
    },
  };
}
