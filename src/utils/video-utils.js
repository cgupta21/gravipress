import {
  VIDEO_CONTAINER_FORMATS,
  VIDEO_LIMITS,
} from '../config/video-presets.js';

export function detectVideoFormat(buffer) {
  if (!buffer || buffer.byteLength < 12) {
    return null;
  }
  const bytes = new Uint8Array(
    buffer.buffer || buffer,
    buffer.byteOffset || 0,
    Math.min(64, buffer.byteLength)
  );

  // Matroska / WebM signature: 1A 45 DF A3
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    // Check for 'webm' doc type in header
    for (let i = 4; i < bytes.length - 4; i += 1) {
      if (
        bytes[i] === 0x77 && // 'w'
        bytes[i + 1] === 0x65 && // 'e'
        bytes[i + 2] === 0x62 && // 'b'
        bytes[i + 3] === 0x6d // 'm'
      ) {
        return 'webm';
      }
    }
    return 'webm'; // EBML standard container
  }

  // MP4 / MOV signatures: bytes 4-7 are 'ftyp' (0x66 0x74 0x79 0x70)
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand.startsWith('qt')) {
      return 'mov';
    }
    return 'mp4';
  }

  // QuickTime 'moov' or 'mdat' at start (bytes 4-7)
  if (
    (bytes[4] === 0x6d &&
      bytes[5] === 0x6f &&
      bytes[6] === 0x6f &&
      bytes[7] === 0x76) ||
    (bytes[4] === 0x6d &&
      bytes[5] === 0x64 &&
      bytes[6] === 0x61 &&
      bytes[7] === 0x74)
  ) {
    return 'mov';
  }

  return null;
}

export function validateVideoLimits(metadata, fileSize) {
  if (fileSize > VIDEO_LIMITS.maxFileSizeBytes) {
    throw new Error(
      `Video exceeds maximum file size limit of ${Math.round(VIDEO_LIMITS.maxFileSizeBytes / (1024 * 1024))} MB.`
    );
  }
  if (
    metadata.duration &&
    metadata.duration > VIDEO_LIMITS.maxDurationSeconds
  ) {
    throw new Error(
      `Video duration (${metadata.duration.toFixed(1)}s) exceeds maximum limit of ${VIDEO_LIMITS.maxDurationSeconds} seconds.`
    );
  }
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (width * height > VIDEO_LIMITS.maxPixelsPerFrame) {
    throw new Error(
      `Video frame resolution (${width}×${height}) exceeds 1080p limit.`
    );
  }
}

export function computeScaledDimensions(width, height, maxDimension) {
  // Determine video orientation dimension: 720p means max height 720 for landscape (16:9), or max width 720 for portrait (9:16)
  // Or in standard video terminology: 1080p, 720p, 480p refers to the short dimension (or height for landscape)
  const isLandscape = width >= height;
  const currentShort = isLandscape ? height : width;

  if (!maxDimension || currentShort <= maxDimension) {
    return {
      width: width % 2 === 0 ? width : width - 1,
      height: height % 2 === 0 ? height : height - 1,
    };
  }

  const aspect = width / height;
  let targetWidth;
  let targetHeight;

  if (isLandscape) {
    targetHeight = maxDimension;
    targetWidth = Math.round(maxDimension * aspect);
  } else {
    // Portrait (e.g. 1080x1920, 480p target): short side (width) becomes 480, height scales to 480 * aspect = 480 * (1920/1080) = 853 -> 852
    targetWidth = maxDimension;
    targetHeight = Math.round(maxDimension / aspect);
  }

  // Ensure even dimensions
  targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth - 1;
  targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight - 1;

  return {
    width: Math.max(2, targetWidth),
    height: Math.max(2, targetHeight),
  };
}

export function buildCompressedVideoFilename(originalName, format = 'mp4') {
  const dotIdx = originalName.lastIndexOf('.');
  const base = dotIdx > 0 ? originalName.slice(0, dotIdx) : originalName;
  const ext = VIDEO_CONTAINER_FORMATS[format]?.extension || `.${format}`;
  return `${base}-compressed${ext}`;
}

export function estimateVideoBitrateKbps(
  targetSizeBytes,
  durationSeconds,
  audioBitrateKbps,
  format = 'mp4'
) {
  if (!durationSeconds || durationSeconds <= 0) {
    return null;
  }
  // Allow ~3-5% container and indexing overhead
  const usableBytes = targetSizeBytes * 0.96;
  const totalBits = usableBytes * 8;
  const totalBitrateKbps = totalBits / durationSeconds / 1000;
  const videoBitrateKbps = totalBitrateKbps - audioBitrateKbps;
  return Math.max(100, Math.floor(videoBitrateKbps));
}
