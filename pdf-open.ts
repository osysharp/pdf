// What both controls in this kit need before they can draw anything: pdf.js itself, and an open document.
//
// ONE IMPLEMENTATION, deliberately. The viewer and the thumbnail differ entirely in what they PAINT and not at all
// in how they get the bytes — so the signing round trip, the four asset roots and the failure wording live here.
// Two copies would drift on the part that is security-shaped (which endpoint, under whose authority) and nobody
// would notice until one of them was wrong.
//
// Each control bundles its own copy of this file, which is the right trade: it is a few hundred bytes, and the
// alternative is a shared chunk with a load order to get wrong. The heavy assets are content-addressed, so both
// bundles name the same hashes and the browser fetches each exactly once.

/** The pdf.js surface this kit uses — narrow on purpose. It is the list of things a pdfjs upgrade could break, and
 *  a wider `any` would let a rename through to a browser. */
export interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data?: ArrayBuffer; standardFontDataUrl?: string; wasmUrl?: string }): { promise: Promise<PdfDoc> };
  TextLayer: new (opts: { textContentSource: unknown; container: HTMLElement; viewport: unknown }) => { render(): Promise<void> };
}
export interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
export interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel(): void };
  getTextContent(): Promise<unknown>;
  cleanup(): void;
}

/** The minimum of the control ABI this module touches. Each control's generated host is narrower than this (its
 *  `chunkUrl` takes a union of the names IT declared), and assignable to it — which is the direction that is safe. */
export interface OpeningHost {
  // Method syntax on purpose: a generated host's `chunkUrl` takes a UNION of the names that control declared, and
  // method parameters are bivariant, so the narrower generated shape is assignable here without a cast.
  chunkUrl(name: string): string;
  data?: { request(path: string, init?: { method?: string; body?: unknown }): Promise<OpeningResponse> };
}
interface OpeningResponse { readonly ok: boolean; readonly status: number; json(): Promise<unknown> }

/** The directory a package chunk's entry sits in: what pdf.js wants for an asset root, where `chunkUrl` answers
 *  with the entry file. `chunkUrl` returns an absolute URL, which `new URL('.', …)` requires as its base. */
export const dirOf = (entryUrl: string) => new URL('.', entryUrl).href;

let pdfjsOnce: Promise<PdfJs> | null = null;

/** Load pdf.js and point it at its worker. Once per bundle: two viewers on one page share the module and the
 *  `workerSrc` assignment, rather than racing to set the same global. */
export function loadPdfJs(host: OpeningHost): Promise<PdfJs> {
  pdfjsOnce ??= import(/* @vite-ignore */ host.chunkUrl('Core')).then((m) => {
    const pdfjs = m as unknown as PdfJs;
    // Every asset root named EXPLICITLY. pdf.js resolves none of these relative to itself, which is the whole
    // reason four content-addressed chunks with no directory relationship to each other can work together.
    pdfjs.GlobalWorkerOptions.workerSrc = host.chunkUrl('Worker');
    return pdfjs;
  });
  return pdfjsOnce;
}

/** Sign, fetch and open one `FileAsset`. Throws an Error whose message is already fit to show a person.
 *
 *  The bytes are fetched whole, once. pdf.js prefers to range-request a document, pulling only the pages a reader
 *  reaches, but the platform's file endpoint does not serve byte ranges and answers a range request with the entire
 *  body anyway. So it is one request for the same bytes, and the signed URL is no longer needed once the document
 *  is open, so nothing can expire underneath a reader. */
export async function openDocument(pdfjs: PdfJs, host: OpeningHost, fileAsset: string): Promise<PdfDoc> {
  if (!host.data) throw new Error('This control needs the app data channel and the host supplied none.');

  // Authorized by READING the asset through the caller's own secured context — so the app's declared `FileAsset`
  // security is the entire access rule, and an asset this user may not read is simply refused here.
  const res = await host.data.request(`/api/files/${fileAsset}/sign`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(res.status === 404
      ? 'That document is not available.'
      : `The document could not be opened (${res.status}).`);
  }
  const { url } = await res.json() as { url: string };

  const response = await fetch(url);
  if (!response.ok) throw new Error(`The document could not be fetched (${response.status}).`);
  const data = await response.arrayBuffer();

  return pdfjs.getDocument({
    data,
    standardFontDataUrl: dirOf(host.chunkUrl('Fonts')),
    wasmUrl: dirOf(host.chunkUrl('Wasm')),
  }).promise;
}
