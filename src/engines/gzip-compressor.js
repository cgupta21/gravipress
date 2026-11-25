import {
  ARCHIVE_LIMITS,
  ARCHIVE_PRESETS,
  validateCompressionLevel,
} from '../config/archive-presets.js';
import { sanitizeArchiveSegment } from '../utils/archive-path-utils.js';
import { calculateSavings } from '../utils/file-utils.js';

function runGzipInWorker(bytes, level, filename, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('GZIP compression cancelled.', 'AbortError'));
      return;
    }

    const worker = new Worker(
      new URL('../workers/archive.worker.js', import.meta.url),
      { type: 'module' }
    );
    const id = `gz-${Date.now()}`;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('GZIP compression cancelled.', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event) => {
      cleanup();
      if (event.data.error) {
        reject(new Error(event.data.error));
      } else {
        resolve(new Uint8Array(event.data.buffer));
      }
    };

    worker.onerror = (err) => {
      cleanup();
      reject(new Error(err?.message || 'GZIP worker failed.'));
    };

    const transferable = bytes.slice().buffer;
    worker.postMessage(
      { id, type: 'gzip', data: transferable, level, filename },
      [transferable]
    );
  });
}

async function runGzipFallback(bytes, level, filename) {
  const { gzipSync } = await import('fflate');
  return gzipSync(bytes, { level, filename: filename || undefined });
}

export async function compressFileToGzip(file, options = {}) {
  const { presetId = 'Balanced', signal, onProgress = () => {} } = options;

  const preset = ARCHIVE_PRESETS[presetId] || ARCHIVE_PRESETS.Balanced;
  const level = validateCompressionLevel(preset.level === 0 ? 6 : preset.level);

  if (!file) {
    throw new Error('Select a single file to compress with GZIP.');
  }

  if (file.size > ARCHIVE_LIMITS.maxSingleFileBytes) {
    throw new Error(
      `File exceeds the ${Math.round(ARCHIVE_LIMITS.maxSingleFileBytes / 1048576)} MB GZIP limit.`
    );
  }

  const startTime = performance.now();
  onProgress({ progress: 15, label: 'READING FILE', indeterminate: true });

  const buffer = await file.arrayBuffer();
  if (signal?.aborted) {
    throw new DOMException('GZIP compression cancelled.', 'AbortError');
  }

  const bytes = new Uint8Array(buffer);
  const safeName = sanitizeArchiveSegment(file.name, true);

  onProgress({
    progress: 50,
    label: `GZIP LEVEL ${level}`,
    indeterminate: true,
  });

  const gzBytes =
    typeof Worker !== 'undefined'
      ? await runGzipInWorker(bytes, level, safeName, signal)
      : await runGzipFallback(bytes, level, safeName);

  if (signal?.aborted) {
    throw new DOMException('GZIP compression cancelled.', 'AbortError');
  }

  if (gzBytes.length < 10 || gzBytes[0] !== 0x1f || gzBytes[1] !== 0x8b) {
    throw new Error('Generated GZIP stream failed header verification.');
  }

  const blob = new Blob([gzBytes], { type: 'application/gzip' });
  const originalSize = bytes.byteLength;
  const compressedSize = blob.size;
  const savings = calculateSavings(originalSize, compressedSize);
  const durationMs = Math.round(performance.now() - startTime);

  return {
    kind: 'gzip',
    blob,
    originalSize,
    compressedSize,
    bytesSaved: savings.bytesSaved,
    percentageSaved: savings.percentage,
    wasReduced: savings.reduced,
    increasedSize: compressedSize > originalSize,
    fileCount: 1,
    level,
    preset: preset.id,
    methodUsed: `GZIP (DEFLATE level ${level})`,
    outputFilename: `${safeName}.gz`,
    durationMs,
  };
}
