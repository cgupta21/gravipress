import { IMAGE_LIMITS, IMAGE_PRESETS } from '../config/image-presets.js';
import { calculateSavings } from '../utils/file-utils.js';
import {
  computeScaledDimensions,
  detectImageFormat,
  hasAlphaChannel,
  validateImageSignatureAndLimits,
} from '../utils/image-utils.js';
import { loadUpng, supportsImageMimeType } from './image-loader.js';
import { decodeImageBitmap } from './image-preview.js';

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Compression cancelled by user.', 'AbortError');
  }
}

async function encodeCanvasLossy(bitmap, width, height, mimeType, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: mimeType !== 'image/jpeg' });

  if (mimeType === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);

  try {
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => {
          if (result && result.size > 0 && result.type === mimeType) {
            resolve(result);
          } else {
            reject(
              new Error(
                `Browser failed to encode ${mimeType} without format fallback.`
              )
            );
          }
        },
        mimeType,
        quality
      );
    });
    const outBytes = new Uint8Array(await blob.arrayBuffer());
    const expectedFormat =
      mimeType === 'image/jpeg'
        ? 'JPEG'
        : mimeType === 'image/webp'
          ? 'WEBP'
          : mimeType === 'image/avif'
            ? 'AVIF'
            : null;
    if (expectedFormat && detectImageFormat(outBytes) !== expectedFormat) {
      throw new Error(
        `Browser encoder did not produce valid ${expectedFormat} output.`
      );
    }
    return outBytes;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function encodePngWithUpng(bitmap, width, height, colorCount) {
  const upng = await loadUpng();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.drawImage(bitmap, 0, 0, width, height);

  let rgbaBuffer;
  try {
    const rgba = ctx.getImageData(0, 0, width, height).data;
    rgbaBuffer = rgba.buffer.slice(
      rgba.byteOffset,
      rgba.byteOffset + rgba.byteLength
    );
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }

  const encodedBuffer = upng.encode([rgbaBuffer], width, height, colorCount);
  return new Uint8Array(encodedBuffer);
}

async function verifyOutputImage(bytes, mimeType) {
  const verifiedBitmap = await decodeImageBitmap(bytes, mimeType);
  const dims = { width: verifiedBitmap.width, height: verifiedBitmap.height };
  verifiedBitmap.close();
  return dims;
}

export async function compressImage(file, originalBytes, options = {}) {
  const {
    mode = 'Balanced',
    customQuality = null,
    targetSizeBytes = null,
    maxDimension = null,
    onProgress = () => {},
    signal,
  } = options;

  const preset = IMAGE_PRESETS[mode] || IMAGE_PRESETS.Balanced;
  const startTime = performance.now();

  throwIfAborted(signal);
  onProgress({
    stage: 'validate',
    label: 'VALIDATING IMAGE',
    progress: 10,
    indeterminate: true,
  });

  const validation = validateImageSignatureAndLimits(file, originalBytes);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { format, meta } = validation;
  const encoderSupported = await supportsImageMimeType(meta.mimeType);
  if (!encoderSupported) {
    throw new Error(
      `${format} encoding is not supported by this browser. Try JPEG, PNG, or WebP.`
    );
  }

  throwIfAborted(signal);
  onProgress({
    stage: 'decode',
    label: 'DECODING IMAGE',
    progress: 24,
    indeterminate: true,
  });

  const bitmap = await decodeImageBitmap(originalBytes, meta.mimeType);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;

  try {
    if (
      originalWidth > IMAGE_LIMITS.maxDimensionPx ||
      originalHeight > IMAGE_LIMITS.maxDimensionPx ||
      originalWidth * originalHeight > IMAGE_LIMITS.maxDecodedPixels
    ) {
      throw new Error(
        `Image dimensions (${originalWidth}×${originalHeight}) exceed safe browser limits.`
      );
    }

    const originalSize = originalBytes.byteLength;
    const candidates = [];

    const initialDims = computeScaledDimensions(
      originalWidth,
      originalHeight,
      maxDimension
    );

    if (format === 'PNG') {
      const colorOptions = targetSizeBytes
        ? [0, 256, 128, 64, 32]
        : mode === 'Light'
          ? [0]
          : mode === 'Balanced'
            ? [0, 256]
            : [0, 128, 64];

      for (let i = 0; i < colorOptions.length; i += 1) {
        throwIfAborted(signal);
        const cnum = colorOptions[i];
        onProgress({
          stage: 'compress',
          label:
            cnum === 0
              ? 'OPTIMIZING PNG LOSSLESS'
              : `QUANTIZING PNG (${cnum} COLORS)`,
          progress: 35 + ((i + 1) / colorOptions.length) * 45,
          indeterminate: false,
        });

        const outBytes = await encodePngWithUpng(
          bitmap,
          initialDims.width,
          initialDims.height,
          cnum
        );
        candidates.push({
          bytes: outBytes,
          width: initialDims.width,
          height: initialDims.height,
          methodUsed:
            cnum === 0
              ? 'Lossless PNG optimization (UPNG)'
              : `Indexed PNG optimization (${cnum} colors)`,
        });

        if (targetSizeBytes && outBytes.byteLength <= targetSizeBytes) {
          break;
        }
      }
    } else {
      const startQuality =
        typeof customQuality === 'number' && customQuality > 0
          ? Math.max(0.1, Math.min(1, customQuality))
          : preset.lossyQuality;

      if (targetSizeBytes && targetSizeBytes > 0) {
        let low = preset.minQuality;
        let high = 0.95;
        for (
          let attempt = 0;
          attempt < IMAGE_LIMITS.maxAdaptiveAttempts;
          attempt += 1
        ) {
          throwIfAborted(signal);
          const q =
            attempt === 0
              ? startQuality
              : Number(((low + high) / 2).toFixed(2));
          onProgress({
            stage: 'compress',
            label: `TARGET SEARCH (${Math.round(q * 100)}% QUALITY)`,
            progress:
              35 + ((attempt + 1) / IMAGE_LIMITS.maxAdaptiveAttempts) * 45,
            indeterminate: false,
          });

          const outBytes = await encodeCanvasLossy(
            bitmap,
            initialDims.width,
            initialDims.height,
            meta.mimeType,
            q
          );
          candidates.push({
            bytes: outBytes,
            width: initialDims.width,
            height: initialDims.height,
            methodUsed: `${format} adaptive target (${Math.round(q * 100)}% quality)`,
          });

          if (outBytes.byteLength <= targetSizeBytes) {
            low = q;
          } else {
            high = q;
          }
          if (Math.abs(high - low) < 0.04) {
            break;
          }
        }
      } else {
        const qualitySteps =
          typeof customQuality === 'number'
            ? [startQuality]
            : mode === 'Maximum'
              ? [startQuality, Math.max(0.4, startQuality - 0.1)]
              : [startQuality];

        for (let i = 0; i < qualitySteps.length; i += 1) {
          throwIfAborted(signal);
          const q = qualitySteps[i];
          onProgress({
            stage: 'compress',
            label: `ENCODING ${format} (${Math.round(q * 100)}%)`,
            progress: 45 + i * 25,
            indeterminate: false,
          });

          const outBytes = await encodeCanvasLossy(
            bitmap,
            initialDims.width,
            initialDims.height,
            meta.mimeType,
            q
          );
          candidates.push({
            bytes: outBytes,
            width: initialDims.width,
            height: initialDims.height,
            methodUsed: `${format} (${Math.round(q * 100)}% quality)`,
          });

          if (outBytes.byteLength < originalSize * 0.95) {
            break;
          }
        }
      }
    }

    throwIfAborted(signal);
    onProgress({
      stage: 'verify',
      label: 'VERIFYING OUTPUT',
      progress: 92,
      indeterminate: false,
    });

    let bestCandidate = null;
    if (targetSizeBytes && targetSizeBytes > 0) {
      const underTarget = candidates.filter(
        (c) => c.bytes.byteLength <= targetSizeBytes
      );
      if (underTarget.length > 0) {
        bestCandidate = underTarget.reduce((best, cur) =>
          cur.bytes.byteLength > best.bytes.byteLength ? cur : best
        );
      }
    }

    if (!bestCandidate) {
      bestCandidate = candidates.reduce((best, cur) =>
        cur.bytes.byteLength < best.bytes.byteLength ? cur : best
      );
    }

    const candidateSize = bestCandidate.bytes.byteLength;
    const savings = calculateSavings(originalSize, candidateSize);
    const verifiedDims = savings.reduced
      ? await verifyOutputImage(bestCandidate.bytes, meta.mimeType)
      : { width: originalWidth, height: originalHeight };
    const finalBytes = savings.reduced ? bestCandidate.bytes : originalBytes;
    const finalSize = finalBytes.byteLength;
    const finalSavings = calculateSavings(originalSize, finalSize);
    const durationMs = Math.round(performance.now() - startTime);

    return {
      kind: 'image',
      format,
      mimeType: meta.mimeType,
      extension: meta.extension,
      bytes: finalBytes,
      originalSize,
      compressedSize: finalSize,
      bytesSaved: finalSavings.bytesSaved,
      percentageSaved: finalSavings.percentage,
      wasReduced: savings.reduced,
      originalWidth,
      originalHeight,
      outputWidth: savings.reduced ? verifiedDims.width : originalWidth,
      outputHeight: savings.reduced ? verifiedDims.height : originalHeight,
      targetSizeBytes,
      targetAchieved:
        targetSizeBytes && targetSizeBytes > 0
          ? finalSize <= targetSizeBytes
          : null,
      methodUsed: savings.reduced
        ? bestCandidate.methodUsed
        : 'Unchanged (original retained)',
      durationMs,
      mode: preset.id,
    };
  } finally {
    bitmap.close();
  }
}

export function detectRgbaTransparency(rgbaBytes) {
  return hasAlphaChannel(rgbaBytes);
}
