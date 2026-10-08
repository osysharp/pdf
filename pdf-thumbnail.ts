// PdfThumbnail@1 — the shim behind `control PdfThumbnail` (pdf-thumbnail.osy).
//
// It draws one page and stops. No scroller, no observers, no text layer, no commands: everything the viewer needs
// in order to be READ is exactly what a picture does not need, which is why this is its own control rather than a
// mode of that one.
//
// The text layer's absence is deliberate and worth stating. A thumbnail is decorative — it is 128 pixels wide and
// nobody selects text in it — so the element is given an accessible NAME instead, and the document's words stay
// where they can be read: in the viewer.
import type { PdfThumbnailProps, PdfThumbnailHost, PdfThumbnailHandle } from './pdf-thumbnail.control';
import { loadPdfJs, openDocument, type PdfJs, type PdfDoc } from './pdf-open';

export function mount(el: HTMLElement, props: PdfThumbnailProps, host: PdfThumbnailHost): PdfThumbnailHandle {
  let fileAsset = props.fileAsset;
  let pageNo = props.page ?? 1;
  let width = props.width ?? 128;

  let pdfjs: PdfJs | null = null;
  let doc: PdfDoc | null = null;
  let pageCount = 0;
  let rendered = false;
  let failure: string | null = null;
  let destroyed = false;
  // Stamped like the viewer's: a thumbnail whose row is re-pointed while the first document is still in flight must
  // not have the older result paint over the newer one.
  let generation = 0;
  let task: { cancel(): void } | null = null;

  el.textContent = '';
  const frame = document.createElement('div');
  frame.style.cssText = `position:relative;display:inline-block;overflow:hidden;`
    + `background:${host.tokens.cssVar('colors.bg')};box-shadow:${host.tokens.cssVar('shadow.raised')}`;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block';
  // A picture of a document is an image, and it needs a name — `role="img"` plus a label, because there is no text
  // in it for anyone who cannot see it. The name is set again once the length is known.
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Document preview');
  frame.append(canvas);
  el.append(frame);

  async function draw() {
    const mine = ++generation;
    rendered = false; failure = null;
    try {
      pdfjs ??= await loadPdfJs(host);
      if (destroyed || mine !== generation) return;

      if (!doc) {
        doc = await openDocument(pdfjs, host, fileAsset);
        if (destroyed || mine !== generation) { void doc.destroy(); doc = null; return; }
        pageCount = doc.numPages;
        host.emit('loaded', pageCount);
      }

      const page = await doc.getPage(Math.min(Math.max(pageNo, 1), pageCount));
      if (destroyed || mine !== generation) return;

      // Clear any placeholder a previous attempt left, or a document that fails once and then loads keeps the
      // failed shape behind a perfectly good picture.
      frame.style.width = ''; frame.style.height = ''; frame.style.background = host.tokens.cssVar('colors.bg');

      // Scale from the page's own width, so the drawn width is the width that was asked for rather than whatever
      // this document's page size happens to imply.
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / natural.width });
      const ratio = window.devicePixelRatio || 1;   // or a thumbnail is soft on exactly the screens people notice
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(ratio, ratio);

      const running = page.render({ canvasContext: ctx, viewport });
      task = running;
      await running.promise;
      if (destroyed || mine !== generation) return;
      page.cleanup();
      task = null;
      canvas.setAttribute('aria-label',
        pageCount === 1 ? 'Document preview, 1 page' : `Document preview, page ${pageNo} of ${pageCount}`);
      rendered = true;
    } catch (err) {
      if (destroyed || mine !== generation) return;
      // Said once per distinct reason: `failed` reaching the app re-renders it, so repeating an identical reason
      // would create a feedback loop.
      const reason = (err as Error).message;
      // A failed thumbnail must look failed. An untouched canvas is 0×0, so the row would simply lose its picture with
      // nothing saying why, indistinguishable from a document whose first page is blank. So the frame keeps a
      // page-shaped placeholder and carries the reason as its accessible name; the app also gets `failed` and may
      // render something better.
      canvas.width = 0; canvas.height = 0;
      frame.style.width = `${width}px`;
      frame.style.height = `${Math.round(width * 1.3)}px`;
      frame.style.background = host.tokens.cssVar('colors.muted');
      canvas.setAttribute('aria-label', `No preview: ${reason}`);
      if (failure !== reason) { failure = reason; host.emit('failed', reason); }
      failure = reason;
    }
  }

  void draw();

  return {
    update(next: PdfThumbnailProps) {
      const wasWidth = width, wasPage = pageNo;
      width = next.width ?? 128;
      pageNo = next.page ?? 1;
      if (next.fileAsset !== fileAsset) {          // a different document: drop the old one and start over
        fileAsset = next.fileAsset;
        task?.cancel();
        void doc?.destroy(); doc = null; pageCount = 0;
        void draw();
        return;
      }
      // Only a change that changes the PICTURE redraws. Without this, every re-render of the app repaints every
      // thumbnail on screen — which in a file list is the whole list, on every keystroke in a filter box.
      if (width !== wasWidth || pageNo !== wasPage) { task?.cancel(); void draw(); }
    },
    probe: () => ({ rendered, pageCount, failure }),
    destroy() {
      destroyed = true;
      task?.cancel();
      void doc?.destroy();
      el.textContent = '';
    },
  };
}
