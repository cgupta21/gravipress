# Gravipress — Engineered to be smaller.

A responsive frontend for a future local-first file compression utility. Uses the approved olive (#2b2d21), silver (#d9dadc) and yellow (#ffc93c) palette. Built with plain HTML, CSS and JavaScript, with Vite for development/build. No database, backend, APIs or external fonts.

## Run locally

Requires Node.js 18+ (Node 22 recommended).

```sh
npm install
npm run dev
```

Open the URL printed by Vite. Select a file or click **Try sample file**, choose a preset and click **Compress file** to see the press animation.

## Build

```sh
npm run build
npm run preview
```

Deploy `dist/` to a static host. On Vercel select Vite, build command `npm run build`, output directory `dist`.

## Scope and limitations

This is UI only. Progress is explicitly simulated; no compression or compressed download is implemented. Image previews use local object URLs. PDF and other formats use an illustrative document graphic, not a real page preview. Presets select UI state only. The next phase should integrate actual compression engines and bind the press to real progress. No uploaded file leaves the browser through this code.

## Structure

- `index.html`: semantic interface and dialog
- `src/style.css`: palette, responsive layout and mechanical animation
- `src/main.js`: file selection, local image previews, presets, animation and dialogs

## Brand assets

- `public/brand/approved-logo.png`: original approved artwork.
- `public/brand/icon.svg` and `icon-dark.svg`: scalable simplified press mark for light and dark surfaces.
- `public/brand/logo-horizontal-light.png` and `logo-horizontal-dark.png`: transparent header/wordmark lockups.
- `public/brand/wordmark.png`: extracted approved lettering.
- `public/favicon.ico`, `favicon.svg`, `icon-16.png`, `icon-32.png`, `icon-48.png`: browser icons.
- `public/icon-192.png`, `icon-512.png`, `maskable-icon-512.png`, `apple-touch-icon.png`: app and home-screen icons.
- `public/social-preview.png`: 1200 × 630 sharing artwork.
- `public/site.webmanifest`: application identity metadata; offline/install behavior is not implemented.

Before public deployment, update the Open Graph and Twitter image URLs in index.html to absolute URLs on your final domain. The logo symbol is a simplified vector adaptation of the approved artwork for small sizes. All assets are local; no external font or image requests.
