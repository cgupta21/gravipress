export const IMAGE_PRESETS = {
  Light: {
    id: 'Light',
    label: 'Light',
    description:
      'Prioritizes visual quality. Lossless optimization for PNG; ~90% quality for JPEG/WebP/AVIF.',
    lossyQuality: 0.9,
    pngColors: 0,
    minQuality: 0.72,
  },
  Balanced: {
    id: 'Balanced',
    label: 'Balanced',
    description:
      'Balances clarity and size. ~78% quality for lossy formats; adaptive palette optimization for PNG.',
    lossyQuality: 0.78,
    pngColors: 256,
    minQuality: 0.55,
  },
  Maximum: {
    id: 'Maximum',
    label: 'Maximum',
    description:
      'Prioritizes smallest file size. ~55% quality with bounded adaptive optimization.',
    lossyQuality: 0.55,
    pngColors: 128,
    minQuality: 0.35,
  },
};

export const IMAGE_TARGET_PRESETS_KB = [50, 100, 200, 500, 1024, 2048];

export const IMAGE_LIMITS = {
  maxFileSizeBytes: 50 * 1024 * 1024,
  maxDimensionPx: 8192,
  maxDecodedPixels: 32_000_000,
  maxAdaptiveAttempts: 6,
  minSettlingDurationMs: 400,
};

export const IMAGE_FORMAT_META = {
  JPEG: {
    format: 'JPEG',
    mimeType: 'image/jpeg',
    extension: 'jpg',
    supportsQuality: true,
  },
  PNG: {
    format: 'PNG',
    mimeType: 'image/png',
    extension: 'png',
    supportsQuality: false,
  },
  WEBP: {
    format: 'WEBP',
    mimeType: 'image/webp',
    extension: 'webp',
    supportsQuality: true,
  },
  AVIF: {
    format: 'AVIF',
    mimeType: 'image/avif',
    extension: 'avif',
    supportsQuality: true,
  },
};
