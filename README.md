# Gravipress — Engineered to be smaller.

A local-first, client-side PDF compression utility. Uses the approved olive (`#2b2d21`), silver (`#d9dadc`), and yellow (`#ffc93c`) palette with a mechanical hydraulic press interface synchronized to real compression progress. Built with plain HTML, CSS, JavaScript, `pdf-lib`, `pdfjs-dist`, and Vite.

## Run locally

Requires Node.js 18+ (Node 22 recommended) and a modern browser with ES modules, Web Workers, and HTML5 Canvas support.

```sh
npm install
npm run dev
```

Open the URL printed by Vite. Select a PDF or click **Try sample PDF**, choose a compression preset, and click **Compress PDF**.

## Build & test

```sh
npm test
npm run format:check
npm run build
npm run preview
```

Deploy `dist/` to any static host. On Vercel select Vite, build command `npm run build`, output directory `dist`.

## Compression methods

- **Light (structural optimization)**: Uses `pdf-lib` with compressed object streams (`useObjectStreams: true`) to compact PDF structure without rasterization. Preserves selectable text, hyperlinks, and interactive forms where supported.
- **Balanced (adaptive ~144 DPI, JPEG 0.75)**: Always attempts structural optimization first so text-only PDFs keep selectable text and structure without unnecessary rasterization. For image-heavy or scanned PDFs, renders pages sequentially via `pdfjs-dist` at ~144 DPI (JPEG `0.75`), with a bounded adaptive step (`115 DPI`, JPEG `0.65`) if needed, and selects the smallest valid candidate.
- **Maximum (adaptive ~96 DPI, JPEG 0.50)**: Attempts structural optimization first, then rasterizes image-heavy documents at ~96 DPI (JPEG `0.50`) with a bounded adaptive step (`72 DPI`, JPEG `0.45`) to prioritize smallest file size.

If no smaller valid output can be produced, Gravipress retains the original PDF, reports zero savings (`0 B / 0.0%`), and preserves the original filename on download rather than appending `-compressed.pdf`.

## Supported formats & privacy

- **Supported now**: PDF (`.pdf`, validated by file header).
- **Not yet supported**: JPG, PNG, WebP, MP4, MP3, and ZIP (clearly blocked with a status message).
- **Privacy**: All parsing, preview rendering, and compression execute 100% locally in your browser. No files are uploaded to external servers, and no uploaded files are persisted in `localStorage` or `IndexedDB`. All PDF.js worker, CMap, and standard font assets are bundled locally.

## Known limitations

- Rasterized modes (`Balanced` and `Maximum`) convert pages to JPEG images, removing selectable text, links, forms, and accessibility structure.
- Password-protected or encrypted PDFs are rejected; encryption is never bypassed.
- Processing a digitally signed PDF can invalidate existing signatures (a warning is shown when signature markers are detected).
- Browser memory limits apply (default limits: 100 MB file size, 200 pages, and 24 MP per rendered page).

## Structure

- `index.html`: Semantic workspace, warnings, metrics, and dialogs
- `src/style.css`: Industrial palette, layout, and `--press`-synchronized hydraulic press
- `src/main.js`: Application orchestration, cancellation, preview, and download flow
- `src/config/compression-presets.js`: Preset parameters, warnings, and safety limits
- `src/engines/pdf-loader.js`: Lazy loaders for `pdf-lib` and local `pdfjs-dist` worker
- `src/engines/pdf-preview.js`: First-page PDF preview renderer and local sample PDF generator
- `src/engines/pdf-compressor.js`: Real Light, Balanced, and Maximum compression pipelines
- `src/utils/file-utils.js`: PDF header validation, signature detection, and size/savings math
- `src/utils/download-utils.js`: Safe PDF Blob download and object URL cleanup
- `tests/pdf-engine.test.js`: Automated unit and integration tests
