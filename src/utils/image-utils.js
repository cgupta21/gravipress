import { IMAGE_FORMAT_META, IMAGE_LIMITS } from '../config/image-presets.js';

function matchesAscii(bytes, offset, text) {
  if (bytes.length < offset + text.length) {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

export function detectImageFormat(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) {
    return null;
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'JPEG';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'PNG';
  }

  // WebP: RIFF....WEBP
  if (matchesAscii(bytes, 0, 'RIFF') && matchesAscii(bytes, 8, 'WEBP')) {
    return 'WEBP';
  }

  // AVIF: ....ftypavif / ....ftypavis
  if (matchesAscii(bytes, 4, 'ftyp')) {
    const brandWindow = new TextDecoder('ascii').decode(
      bytes.subarray(8, Math.min(bytes.length, 32))
    );
    if (brandWindow.includes('avif') || brandWindow.includes('avis')) {
      return 'AVIF';
    }
  }

  // GIF: GIF87a / GIF89a
  if (matchesAscii(bytes, 0, 'GIF87a') || matchesAscii(bytes, 0, 'GIF89a')) {
    return 'GIF';
  }

  return null;
}

export function isAnimatedImage(bytes, format) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) {
    return false;
  }

  if (format === 'PNG') {
    // APNG includes an acTL chunk before IDAT
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length =
        ((bytes[offset] << 24) |
          (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) |
          bytes[offset + 3]) >>>
        0;
      const type = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7]
      );
      if (type === 'acTL') {
        return true;
      }
      if (type === 'IDAT' || type === 'IEND') {
        break;
      }
      offset += 12 + length;
    }
    return false;
  }

  if (format === 'WEBP') {
    // Check VP8X animation flag (bit 1) or ANIM chunk
    if (matchesAscii(bytes, 12, 'VP8X') && bytes.length >= 21) {
      if ((bytes[20] & 0x02) !== 0) {
        return true;
      }
    }
    const scanLimit = Math.min(bytes.length, 2048);
    for (let i = 12; i + 4 <= scanLimit; i += 1) {
      if (matchesAscii(bytes, i, 'ANIM')) {
        return true;
      }
    }
    return false;
  }

  if (format === 'AVIF') {
    const brand = new TextDecoder('ascii').decode(
      bytes.subarray(8, Math.min(bytes.length, 32))
    );
    return brand.includes('avis');
  }

  if (format === 'GIF') {
    let imageDescriptors = 0;
    for (let i = 13; i < bytes.length - 1; i += 1) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) {
        imageDescriptors += 1;
        if (imageDescriptors > 1) {
          return true;
        }
      }
    }
    return false;
  }

  return false;
}

export function readHeaderDimensions(bytes, format) {
  if (format === 'PNG' && bytes.length >= 24) {
    const width =
      ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>>
      0;
    const height =
      ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>>
      0;
    return { width, height };
  }

  if (format === 'JPEG') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        break;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        return { width, height };
      }
      const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (segmentLength < 2) {
        break;
      }
      offset += 2 + segmentLength;
    }
  }

  if (format === 'WEBP' && bytes.length >= 30) {
    // VP8X extended header stores 24-bit (width - 1) and (height - 1) at 24..29
    if (matchesAscii(bytes, 12, 'VP8X')) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width, height };
    }
    // VP8L lossless header stores 14-bit (width - 1) and (height - 1) at 21..24
    if (matchesAscii(bytes, 12, 'VP8L') && bytes[20] === 0x2f) {
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      const width = 1 + (b0 | ((b1 & 0x3f) << 8));
      const height = 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
      return { width, height };
    }
  }

  return null;
}

export function validateImageSignatureAndLimits(file, bytes) {
  if (!file || !(bytes instanceof Uint8Array) || bytes.length === 0) {
    return {
      valid: false,
      error: 'The selected image file is empty (0 bytes).',
    };
  }

  if (bytes.length > IMAGE_LIMITS.maxFileSizeBytes) {
    return {
      valid: false,
      error: `Image exceeds the ${Math.round(IMAGE_LIMITS.maxFileSizeBytes / 1048576)} MB browser processing limit.`,
    };
  }

  const format = detectImageFormat(bytes);
  if (!format) {
    return {
      valid: false,
      error:
        'Invalid or unsupported image file. File contents do not match JPEG, PNG, WebP, or AVIF signatures.',
    };
  }

  if (format === 'GIF') {
    return {
      valid: false,
      error: 'GIF compression is not supported in Phase 3.',
    };
  }

  if (isAnimatedImage(bytes, format)) {
    return {
      valid: false,
      error: `Animated ${format} files are not supported because re-encoding would drop animation frames.`,
    };
  }

  const headerDims = readHeaderDimensions(bytes, format);
  if (headerDims) {
    const { width, height } = headerDims;
    if (
      width === 0 ||
      height === 0 ||
      width > IMAGE_LIMITS.maxDimensionPx ||
      height > IMAGE_LIMITS.maxDimensionPx ||
      width * height > IMAGE_LIMITS.maxDecodedPixels
    ) {
      return {
        valid: false,
        error: `Image dimensions (${width}×${height}) exceed safe browser decoding limits.`,
      };
    }
  }

  return {
    valid: true,
    format,
    meta: IMAGE_FORMAT_META[format],
    error: null,
  };
}

export function hasAlphaChannel(rgbaBytes) {
  for (let i = 3; i < rgbaBytes.length; i += 4) {
    if (rgbaBytes[i] < 255) {
      return true;
    }
  }
  return false;
}

export function computeScaledDimensions(width, height, maxDimension) {
  if (!maxDimension || maxDimension <= 0) {
    return { width, height, resized: false };
  }
  const largestSide = Math.max(width, height);
  if (largestSide <= maxDimension) {
    return { width, height, resized: false };
  }
  const scale = maxDimension / largestSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

export function buildCompressedImageFilename(originalName, extension) {
  const safeName = (originalName || `image.${extension}`).trim();
  const baseName = safeName.replace(/\.[^.]+$/, '');
  return `${baseName}-compressed.${extension}`;
}
