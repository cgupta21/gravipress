export const ARCHIVE_PRESETS = {
  Fast: {
    id: 'Fast',
    label: 'Fast',
    level: 1,
    description: 'DEFLATE level 1. Prioritizes compression speed.',
  },
  Balanced: {
    id: 'Balanced',
    label: 'Balanced',
    level: 6,
    description: 'DEFLATE level 6. Balances speed and archive size.',
  },
  Maximum: {
    id: 'Maximum',
    label: 'Maximum',
    level: 9,
    description: 'DEFLATE level 9. Prioritizes smallest archive size.',
  },
  Store: {
    id: 'Store',
    label: 'Store only',
    level: 0,
    description: 'Level 0 (STORE). Packages files without compression.',
  },
};

export const ARCHIVE_LIMITS = {
  maxFiles: 250,
  maxTotalInputBytes: 100 * 1024 * 1024,
  maxSingleFileBytes: 50 * 1024 * 1024,
  maxPathDepth: 12,
  maxArchivePathLength: 220,
  defaultZipName: 'gravipress-archive.zip',
};

export const ALREADY_COMPRESSED_EXT_PATTERN =
  /\.(zip|gz|bz2|xz|7z|rar|jpe?g|png|webp|avif|mp4|mp3|docx|xlsx|pptx)$/i;

export function validateCompressionLevel(level) {
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new Error(
      `Invalid compression level (${level}). Expected integer 0 through 9.`
    );
  }
  return level;
}
