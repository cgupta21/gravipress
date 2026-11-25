# Third-Party Licenses & Software Redistribution Notices

Gravipress utilizes open-source libraries to perform client-side file compression directly within your web browser.

---

### 1. FFmpeg & FFmpeg.wasm

- **JavaScript Wrappers:** `@ffmpeg/ffmpeg` and `@ffmpeg/util`
  - **License:** MIT License
  - **Copyright:** (c) 2019-present Jerome Wu, FFmpeg.wasm Contributors
- **Compiled WebAssembly Core:** `@ffmpeg/core` (`0.12.10`)
  - **License:** GNU General Public License v2.0 or later (GPL-2.0-or-later) / GNU Lesser General Public License (LGPL v2.1 or later) depending on compiled codecs.
  - **Included Codecs:** Includes FFmpeg multimedia libraries (libavcodec, libavformat, libavutil, libswscale, libswresample) compiled with `libx264` (GPL) and `libvpx` (BSD).
  - **Source Code Availability:** In accordance with the GNU General Public License v2.0, the corresponding source code for the exact FFmpeg build used to generate the WebAssembly binaries can be obtained from:
    - Upstream repository: `https://github.com/ffmpegwasm/ffmpeg.wasm`
    - Build recipes & core source: `https://github.com/ffmpegwasm/ffmpeg.wasm-core`
    - FFmpeg core project: `https://ffmpeg.org`

---

### 2. PDF Processing: pdf-lib & pdfjs-dist

- **`pdf-lib`**
  - **License:** MIT License
  - **Copyright:** (c) 2019 Andrew Dillon
- **`pdfjs-dist`**
  - **License:** Apache License, Version 2.0
  - **Copyright:** (c) 2011-present Mozilla Foundation and contributors

---

### 3. Image Compression: upng-js & pako

- **`upng-js`**
  - **License:** MIT License
  - **Copyright:** (c) 2017 Photopea
- **`pako`**
  - **License:** MIT License
  - **Copyright:** (c) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn

---

### 4. Archive Engine: fflate

- **`fflate`**
  - **License:** MIT License
  - **Copyright:** (c) 2020 Arjun Barrett
