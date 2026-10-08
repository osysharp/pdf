// Builds this control's chunk assets from the installed pdfjs-dist: the parts a viewer only pays for when a
// particular document needs them.
//
// pdf.js is unusual among the libraries a kit might wrap in the way that matters here: it names every asset root
// explicitly rather than resolving it relative to itself. `GlobalWorkerOptions.workerSrc`, and `standardFontDataUrl`
// / `wasmUrl` / `cMapUrl` on `getDocument`, are all plain URLs the caller supplies. That is what lets four assets
// with no directory relationship to each other, which is what four content addresses are, work together.
//
//   Core    — one file. pdf.min.mjs, the main-thread API. Already an ESM bundle; nothing to build.
//   Worker  — one file. pdf.worker.min.mjs, the parsing engine. Its own file because it is loaded as a Worker by
//             URL, never imported, so it needs an address rather than a module, and a package would add nothing.
//   Fonts   — a package. The base-14 substitutes for a PDF that does not embed its fonts. pdf.js requests them one
//             file at a time relative to a directory root, so the whole directory must be addressable.
//   Wasm    — a package. JBIG2 and JPEG2000 decoders plus the qcms colour transform, addressed the same way.
//
// Wasm is not optional for scanned documents. A scanned page is usually JBIG2 or JPEG2000, and without these the
// page renders blank where the scan should be: not an error, an absence. pdf.js ships `*_nowasm_fallback.js` beside
// them, so the failure is quiet by design.
//
// cmaps/ (1.6 MB) is deliberately not built. It holds the CJK character-encoding tables, needed only by a document
// with CJK text in a non-Unicode encoding. Adding it is one entry here plus one in the control declaration; do that
// when a document needs it.
import { cpSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const dist = join(app, 'node_modules', 'pdfjs-dist');
// Straight into the directory the chunks are PINNED at — the kit root — so there is exactly one copy of each asset
// in the tree. Building anywhere else leaves a second 1.2 MB worker and no way to tell which one is real.
const out = app;

// ── Core and Worker: shipped pre-minified, so this is a copy, not a build ─────────────────────────────────────
// Deliberately not re-bundled: esbuild over an already-minified ESM bundle would add nothing, and would become one
// more thing to re-verify against every pdf.js release.
// Named `pdfjs-*`, not `pdf.js`. The kit's own bundled shim is `pdf.js` (the sibling of `pdf.osy`, which is what
// `osy control add` reads), so copying pdf.js's core here under its upstream name would overwrite the shim with the
// library: a kit that still builds and pins, but mounts the wrong thing.
copyFileSync(join(dist, 'build', 'pdf.min.mjs'), join(out, 'pdfjs-core.js'));
copyFileSync(join(dist, 'build', 'pdf.worker.min.mjs'), join(out, 'pdfjs-worker.js'));

// ── Fonts and Wasm: whole directories, copied as package chunks ───────────────────────────────────────────────
// A package is its whole file set: remove first, never merge a stale build into a fresh one.
//
// The licence files go beside the package, not in it. Both directories ship extensionless `LICENSE_*` files, and a
// control asset can only be served as a type the platform's allowlist names, so an extensionless file would fail
// registration. They cannot be dropped either, since they are the upstream licences these files are redistributed
// under. So they are copied to `licenses/`, which is kept in the repository but in no chunk: the obligation is met by
// shipping the text, not by serving it to a browser.
const licenses = join(out, 'licenses');
rmSync(licenses, { recursive: true, force: true });
mkdirSync(licenses, { recursive: true });
for (const [name, src] of [['fonts', join(dist, 'standard_fonts')], ['wasm', join(dist, 'wasm')]]) {
  const dir = join(out, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(src)) {
    copyFileSync(join(src, f), join(f.startsWith('LICENSE') ? licenses : dir, f));
  }
}

const kb = (p) => (statSync(p).size / 1024).toFixed(1);
const dirKb = (d) => readdirSync(d).reduce((n, f) => n + statSync(join(out, d, f)).size, 0) / 1024;
console.log(`Core    ${kb(join(out, 'pdfjs-core.js'))} KB  (pdfjs-core.js)`);
console.log(`Worker  ${kb(join(out, 'pdfjs-worker.js'))} KB  (pdfjs-worker.js)`);
console.log(`Fonts   ${dirKb('fonts').toFixed(1)} KB across ${readdirSync(join(out, 'fonts')).length} files  (fonts/)`);
console.log(`Wasm    ${dirKb('wasm').toFixed(1)} KB across ${readdirSync(join(out, 'wasm')).length} files  (wasm/)`);
