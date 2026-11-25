export const COMPRESSION_PRESETS = {
  Light: {
    id: 'Light',
    label: 'Light',
    description:
      'Structural optimization. Preserves selectable text, links, and forms where supported.',
    isLossy: false,
    warning: null,
  },
  Balanced: {
    id: 'Balanced',
    label: 'Balanced',
    description:
      'Tries structural optimization first, then ~144 DPI (JPEG 0.75) with bounded adaptive tuning if needed.',
    isLossy: true,
    dpi: 144,
    jpegQuality: 0.75,
    adaptiveSteps: [
      { dpi: 144, jpegQuality: 0.75, label: 'Balanced (144 DPI / 0.75)' },
      {
        dpi: 115,
        jpegQuality: 0.65,
        label: 'Balanced adaptive (115 DPI / 0.65)',
      },
    ],
    warning:
      'Balanced mode may rasterize image-heavy pages. When rasterized, selectable text, forms, hyperlinks, and accessibility tags are removed.',
  },
  Maximum: {
    id: 'Maximum',
    label: 'Maximum',
    description:
      'Tries structural optimization, then ~96 DPI (JPEG 0.50) with bounded adaptive tuning for smallest size.',
    isLossy: true,
    dpi: 96,
    jpegQuality: 0.5,
    adaptiveSteps: [
      { dpi: 96, jpegQuality: 0.5, label: 'Maximum (96 DPI / 0.50)' },
      { dpi: 72, jpegQuality: 0.45, label: 'Maximum adaptive (72 DPI / 0.45)' },
    ],
    warning:
      'Maximum mode rasterizes pages at lower resolution. Selectable text, forms, hyperlinks, and accessibility tags will be removed, and fine details may soften.',
  },
};

export const PDF_LIMITS = {
  maxFileSizeBytes: 100 * 1024 * 1024,
  maxPageCount: 200,
  maxPageDimensionPx: 8192,
  maxPagePixels: 24_000_000,
  minSettlingDurationMs: 450,
};

export const UNSUPPORTED_FORMAT_PATTERN = /\.(jpe?g|png|webp|mp4|mp3|zip)$/i;
