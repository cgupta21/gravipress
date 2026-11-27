# Third-Party Licenses & Notices (Gravipress v1.2.2)

Gravipress v1.2.2 performs client-side PDF, image, native WebCodecs audio/video, batch, and ZIP/GZIP archive compression directly inside the user's browser. Current production releases (`v1.0.0`–`v1.2.2`) do **not** bundle FFmpeg or any GPL-licensed multimedia binaries.

---

### Runtime Dependencies

| Package | Version | License | Copyright / Notice | Full License Text |
| :--- | :--- | :--- | :--- | :--- |
| **`pdf-lib`** | `1.17.1` | MIT | Copyright (c) 2019 Andrew Dillon | [`public/licenses/pdf-lib-MIT.txt`](public/licenses/pdf-lib-MIT.txt) |
| **`pdfjs-dist`** | `6.5.438` | Apache-2.0 | Copyright (c) 2011-present Mozilla Foundation and contributors | [`public/licenses/pdfjs-dist-Apache-2.0.txt`](public/licenses/pdfjs-dist-Apache-2.0.txt) |
| **`fflate`** | `0.8.3` | MIT | Copyright (c) 2023 Arjun Barrett | [`public/licenses/fflate-MIT.txt`](public/licenses/fflate-MIT.txt) |
| **`upng-js`** | `2.1.0` | MIT | Copyright (c) 2017 Photopea | [`public/licenses/upng-js-MIT.txt`](public/licenses/upng-js-MIT.txt) |
| **`mediabunny`** | `1.66.5` | MPL-2.0 | Vanilagy ([Source v1.66.5](https://github.com/Vanilagy/mediabunny/tree/v1.66.5)) | [`public/licenses/mediabunny-MPL-2.0.txt`](public/licenses/mediabunny-MPL-2.0.txt) |
| **`pako`** *(transitive)* | `1.0.11` | MIT | Copyright (c) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn | [`public/licenses/pako-MIT.txt`](public/licenses/pako-MIT.txt) |
| **`tslib`** *(transitive)* | `1.14.1` | 0BSD | Copyright (c) Microsoft Corporation | [`public/licenses/tslib-0BSD.txt`](public/licenses/tslib-0BSD.txt) |

### Bundled PDF.js Asset Notices
- **PDF.js CMaps**: `dist/pdfjs/cmaps/LICENSE` (Apache-2.0 / Adobe CMaps notices)
- **PDF.js Standard Fonts**: `dist/pdfjs/standard_fonts/LICENSE_FOXIT` and `dist/pdfjs/standard_fonts/LICENSE_LIBERATION`

### Historical Non-Production FFmpeg Source Archive
- Earlier non-production experimental builds on branch `experimental/ffmpeg-wasm-core` generated FFmpeg 5.1.10 WebAssembly artifacts (`GPL-2.0-or-later`). Those binaries are not part of current Gravipress production releases.
- Archival corresponding source packages, build scripts, manifests, checksums, and full license texts are hosted separately at: https://github.com/cgupta21/gravipress/releases/tag/ffmpeg-5.1.10-source-archive (technical archival record only; does not constitute formal legal clearance).
