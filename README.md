# Gravipress v1.0 — Engineered to be smaller.

**Live app:** [https://gravipress.pages.dev](https://gravipress.pages.dev)

A local-first, client-side file compression utility for **PDF documents, raster images, batch queues, and lossless ZIP/GZIP archives**. Uses the approved olive (`#2b2d21`), silver (`#d9dadc`), and yellow (`#ffc93c`) palette with a mechanical hydraulic press interface synchronized to real compression progress. Built with plain HTML, CSS, JavaScript, `pdf-lib`, `pdfjs-dist`, `upng-js`, `fflate`, and Vite.

## Run locally

Requires Node.js 18+ (Node 22 recommended) and a modern browser with ES modules, Web Workers, and HTML5 Canvas support.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. Drop or select a PDF, image, batch of files, or archive folder, choose a preset, and click **Compress**.

## Build & test

```sh
npm test
npm run format:check
npm run build
npm run preview
```

Deploy `dist/` to any static host. On Cloudflare Pages, connect the repository, set the framework preset to **Vite** (or **None**), build command `npm run build`, build output directory `dist`, and environment variable `NODE_VERSION=22`. Security headers and Content Security Policy are configured in `public/_headers`.

## Compression methods

- **Light (structural optimization)**: Uses `pdf-lib` with compressed object streams (`useObjectStreams: true`) to compact PDF structure without rasterization. Preserves selectable text, hyperlinks, and interactive forms where supported.
- **Balanced (adaptive ~144 DPI, JPEG 0.75)**: Always attempts structural optimization first so text-only PDFs keep selectable text and structure without unnecessary rasterization. For image-heavy or scanned PDFs, renders pages sequentially via `pdfjs-dist` at ~144 DPI (JPEG `0.75`), with a bounded adaptive step (`115 DPI`, JPEG `0.65`) if needed, and selects the smallest valid candidate.
- **Maximum (adaptive ~96 DPI, JPEG 0.50)**: Attempts structural optimization first, then rasterizes image-heavy documents at ~96 DPI (JPEG `0.50`) with a bounded adaptive step (`72 DPI`, JPEG `0.45`) to prioritize smallest file size.

If no smaller valid output can be produced, Gravipress retains the original PDF, reports zero savings (`0 B / 0.0%`), and preserves the original filename on download rather than appending `-compressed.pdf`.

## Supported formats & privacy

- **Supported PDF**: `.pdf` (validated by `%PDF-` header).
- **Supported Images**: `.jpg` / `.jpeg`, `.png`, `.webp`, and `.avif` (where browser-native AVIF encoding is supported), validated by binary file signatures and actual decoding.
- **Supported General Files & Folders (ZIP / GZIP)**: Arbitrary files (text, CSV, JSON, XML, source code, documents, binary files) and nested folders (`webkitdirectory` or directory drag-and-drop) compressed in a Web Worker using `fflate`:
  - **ZIP**: `Fast` (DEFLATE level 1), `Balanced` (DEFLATE level 6), `Maximum` (DEFLATE level 9), and `Store only` (level 0). Already-compressed formats (`.zip`, `.jpg`, `.png`, `.docx`, etc.) automatically use `STORE` inside DEFLATE archives to avoid wasted CPU/memory.
  - **GZIP (`.gz`)**: Single-file stream compression (`1f 8b`). Disabled when multiple files or folders are selected.
- **Supported Formats (v1.0)**: PDF (`.pdf`), raster images (`.jpg`/`.jpeg`, `.png`, `.webp`, `.avif`), batch queues, and lossless ZIP/GZIP archives. (Animated `.gif`/APNG/animated WebP/AVIF are rejected; multimedia codecs are not included in v1.0.)
- **Image compression methods**:
  - **PNG**: Uses `upng-js` for lossless deflate re-encoding (`Light`) and indexed palette quantization (`Balanced` / `Maximum`) while preserving alpha transparency.
  - **JPEG / WebP / AVIF**: Uses browser-native Canvas encoding (`0.90` / `0.78` / `0.55` defaults), custom quality slider, optional aspect-ratio-preserving max-dimension resizing, and bounded binary-search target size optimization.
  - **Metadata**: Browser Canvas/UPNG re-encoding removes EXIF/IPTC/XMP metadata and normalizes output to sRGB.
- **Privacy**: All parsing, preview rendering, and compression execute 100% locally in your browser. No files are uploaded to external servers, and no uploaded files are persisted in `localStorage` or `IndexedDB`. All PDF.js worker, CMap, and standard font assets are bundled locally.

## Known limitations & browser compatibility

- **Rasterized PDF modes (`Balanced` / `Maximum`)**: When applied to image-heavy PDFs, pages are converted to JPEG images, removing selectable text, links, forms, and accessibility structure.
- **Encrypted PDFs**: Password-protected or encrypted PDFs are rejected; encryption is never bypassed.
- **Digital signatures**: Processing a digitally signed PDF can invalidate existing signatures (a warning is shown when signature markers are detected).
- **AVIF encoding**: AVIF compression relies on browser-native `canvas.toBlob('image/avif')` support (available in modern desktop Chromium/Firefox builds, but not all headless or Safari environments). Unsupported browsers receive an explicit error rather than a silent format fallback.
- **Image metadata & color space**: Browser Canvas and `upng-js` encoding strips EXIF/IPTC/XMP metadata and normalizes output to sRGB.
- **Target size mode**: Target sizes are approached via bounded adaptive quality/palette search (`6` attempts max). If a target cannot be reached within permitted quality/dimension bounds, Gravipress returns the best smaller candidate and reports that the target was not met.
- **Safety & memory limits**:
  - **PDF**: `100 MB` max file size, `200` pages, `8192 px` max page side, `24 MP` max rendered page pixels.
  - **Images**: `50 MB` max file size, `8192 px` max dimension, `32 MP` max decoded pixels (`~128 MB` RGBA) to protect desktop and mobile browser tabs.
  - **Batch Queue**: Up to `20` files per batch and `100 MB` combined input size, processed sequentially to prevent memory spikes. Supports per-file preset overrides, reordering, individual/batch cancellation, and retry of failed/cancelled items. Failed or cancelled files are excluded from aggregate savings and ZIP archives.
- **General Archive & Folder Limits**: Up to `250` files, `100 MB` combined input, `50 MB` single file, and `12` directory levels. Empty directories are not included by browser `webkitdirectory` pickers. All archive paths are sanitized against traversal (`..`), drive/UNC prefixes, control characters, and Windows reserved device names.
- **Browser Compatibility**: Automated E2E verified in Playwright Chromium (`7/7` suites), Firefox (`3/3` critical suites), and WebKit (`3/3` critical suites). Note that WebKit automation provides useful Safari-engine coverage but does not guarantee identical behavior on every iOS/macOS Safari release.

## Phase 5 General File & Folder Compression Benchmarks

Automated benchmarks measured across realistic, non-repetitive datasets in headless Chromium, Firefox, and WebKit (Safari engine) using DEFLATE Web Workers via `fflate`:

| Dataset / Fixture                                       | Uncompressed            | Preset / Level    | Output Archive  | Space Saved (%)          | Processing Duration | Engine Mode            |
| ------------------------------------------------------- | ----------------------- | ----------------- | --------------- | ------------------------ | ------------------- | ---------------------- |
| **1 MB Text Document** (realistic technical prose)      | 1,048,665 B (1.00 MB)   | **Fast** (L1)     | 177.3 KB        | 82.7%                    | 68 ms               | ZIP DEFLATE            |
| **1 MB Text Document**                                  | 1,048,665 B (1.00 MB)   | **Balanced** (L6) | 118.1 KB        | 88.5%                    | 110 ms              | ZIP DEFLATE            |
| **1 MB Text Document**                                  | 1,048,665 B (1.00 MB)   | **Maximum** (L9)  | 117.2 KB        | 88.6%                    | 116 ms              | ZIP DEFLATE            |
| **5 MB Telemetry CSV** (realistic metrics & timestamps) | 5,242,952 B (5.00 MB)   | **Fast** (L1)     | 1,000.8 KB      | 80.5%                    | 183 ms              | ZIP DEFLATE            |
| **5 MB Telemetry CSV**                                  | 5,242,952 B (5.00 MB)   | **Balanced** (L6) | 770.3 KB        | 85.0%                    | 276 ms              | ZIP DEFLATE            |
| **5 MB Telemetry CSV**                                  | 5,242,952 B (5.00 MB)   | **Maximum** (L9)  | 770.0 KB        | 85.0%                    | 337 ms              | ZIP DEFLATE            |
| **10 MB Machine JSON** (deeply nested records & arrays) | 10,485,938 B (10.00 MB) | **Balanced** (L6) | 536.3 KB        | 94.8%                    | 287 ms              | ZIP DEFLATE            |
| **10 MB Machine JSON**                                  | 10,485,938 B (10.00 MB) | **Maximum** (L9)  | 536.1 KB        | 94.8%                    | 322 ms              | ZIP DEFLATE            |
| **256 KB Random Binary**                                | 262,144 B (256 KB)      | **Balanced** (L6) | 262.3 KB        | 0.0% (overhead reported) | 12 ms               | ZIP (Incompressible)   |
| **Nested Folder Hierarchy** (multi-level tree)          | Variable                | **Balanced** (L6) | Exact hierarchy | Restored byte-for-byte   | < 50 ms             | ZIP / tar.exe verified |

## Licenses

- **Application License**: MIT License — see [LICENSE](LICENSE).
- **Third-Party Runtime Dependencies**: `pdf-lib` (MIT), `pdfjs-dist` (Apache-2.0), `upng-js` (MIT), `pako` (MIT), `fflate` (MIT), `tslib` (0BSD). See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) and `public/licenses/`.

## Structure

- `index.html`: Semantic workspace, warnings, metrics, and dialogs (`#licenses-dialog`, `#dialog`)
- `src/style.css`: Industrial palette, layout, and `--press`-synchronized hydraulic press
- `src/main.js`: Application orchestration, cancellation, preview, and download flow
- `src/engines/`: PDF (`pdf-loader.js`, `pdf-preview.js`, `pdf-compressor.js`), image (`image-compressor.js`), batch (`batch-compressor.js`), and archive (`general-compressor.js`, `gzip-compressor.js`) pipelines
- `src/workers/archive.worker.js`: Off-main-thread ZIP/GZIP worker via `fflate`
- `public/_headers`: Cloudflare Pages security headers and Content Security Policy
- `THIRD_PARTY_LICENSES.md` & `public/licenses/`: Third-party copyright notices and full license texts
- `tests/`: Unit tests (`npm test`) and Playwright E2E smoke/audit suites
