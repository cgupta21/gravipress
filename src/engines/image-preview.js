import { IMAGE_LIMITS } from '../config/image-presets.js';
import {
  hasAlphaChannel,
  validateImageSignatureAndLimits,
} from '../utils/image-utils.js';

export async function decodeImageBitmap(bytes, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(
      'Unable to decode image. The file may be corrupted or use an unsupported encoding.'
    );
  }
}

export async function renderImagePreview(file, bytes, signal) {
  if (signal?.aborted) {
    throw new DOMException('Preview cancelled.', 'AbortError');
  }

  const validation = validateImageSignatureAndLimits(file, bytes);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const bitmap = await decodeImageBitmap(bytes, validation.meta.mimeType);
  try {
    if (signal?.aborted) {
      throw new DOMException('Preview cancelled.', 'AbortError');
    }

    const { width, height } = bitmap;
    if (
      width <= 0 ||
      height <= 0 ||
      width > IMAGE_LIMITS.maxDimensionPx ||
      height > IMAGE_LIMITS.maxDimensionPx ||
      width * height > IMAGE_LIMITS.maxDecodedPixels
    ) {
      throw new Error(
        `Image dimensions (${width}×${height}) exceed safe browser limits.`
      );
    }

    // Sample pixel alpha on a bounded canvas to detect transparency safely
    const sampleScale = Math.min(1, 512 / Math.max(width, height));
    const sampleW = Math.max(1, Math.round(width * sampleScale));
    const sampleH = Math.max(1, Math.round(height * sampleScale));
    const canvas = document.createElement('canvas');
    canvas.width = sampleW;
    canvas.height = sampleH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, sampleW, sampleH);
    const rgba = ctx.getImageData(0, 0, sampleW, sampleH).data;
    const hasAlpha = hasAlphaChannel(rgba);
    canvas.width = 0;
    canvas.height = 0;

    const previewBlob = new Blob([bytes], { type: validation.meta.mimeType });
    const previewUrl = URL.createObjectURL(previewBlob);

    return {
      previewUrl,
      width,
      height,
      format: validation.format,
      mimeType: validation.meta.mimeType,
      extension: validation.meta.extension,
      hasAlpha,
    };
  } finally {
    bitmap.close();
  }
}
