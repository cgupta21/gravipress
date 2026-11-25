import {
  ALREADY_COMPRESSED_EXT_PATTERN,
  ARCHIVE_LIMITS,
  ARCHIVE_PRESETS,
  validateCompressionLevel,
} from '../config/archive-presets.js';
import {
  resolveUniqueArchivePath,
  sanitizeArchiveSegment,
} from '../utils/archive-path-utils.js';
import { calculateSavings, formatFileSize } from '../utils/file-utils.js';

function runZipInWorker(entries, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Archive compression cancelled.', 'AbortError'));
      return;
    }

    const worker = new Worker(
      new URL('../workers/archive.worker.js', import.meta.url),
      { type: 'module' }
    );
    const id = `zip-${Date.now()}`;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Archive compression cancelled.', 'AbortError'));
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
      reject(new Error(err?.message || 'Archive worker failed.'));
    };

    const transferList = entries.map((e) => e.buffer);
    worker.postMessage({ id, type: 'zip', entries }, transferList);
  });
}

async function runZipFallback(entries) {
  const { zipSync } = await import('fflate');
  const zipInput = Object.create(null);
  for (const entry of entries) {
    zipInput[entry.path] = [
      new Uint8Array(entry.buffer),
      { level: entry.level },
    ];
  }
  return zipSync(zipInput);
}

export async function compressFilesToZip(items, options = {}) {
  const {
    presetId = 'Balanced',
    archiveName = ARCHIVE_LIMITS.defaultZipName,
    signal,
    onProgress = () => {},
  } = options;

  const preset = ARCHIVE_PRESETS[presetId] || ARCHIVE_PRESETS.Balanced;
  const level = validateCompressionLevel(preset.level);

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Select at least one file or folder to archive.');
  }

  if (items.length > ARCHIVE_LIMITS.maxFiles) {
    throw new Error(
      `Archive exceeds the ${ARCHIVE_LIMITS.maxFiles}-file limit (${items.length} selected).`
    );
  }

  let totalOriginalBytes = 0;
  for (const entry of items) {
    const size = Number(entry.file?.size || 0);
    if (size > ARCHIVE_LIMITS.maxSingleFileBytes) {
      throw new Error(
        `"${entry.file.name}" exceeds the ${formatFileSize(ARCHIVE_LIMITS.maxSingleFileBytes)} single-file limit.`
      );
    }
    totalOriginalBytes += size;
  }

  if (totalOriginalBytes > ARCHIVE_LIMITS.maxTotalInputBytes) {
    throw new Error(
      `Combined input (${formatFileSize(totalOriginalBytes)}) exceeds the ${formatFileSize(ARCHIVE_LIMITS.maxTotalInputBytes)} archive limit.`
    );
  }

  const startTime = performance.now();
  const usedPaths = new Set();
  const usedDirs = new Set();
  const workerEntries = [];
  const archivedPaths = [];

  for (let i = 0; i < items.length; i += 1) {
    if (signal?.aborted) {
      throw new DOMException('Archive compression cancelled.', 'AbortError');
    }

    const item = items[i];
    onProgress({
      progress: ((i + 1) / (items.length + 1)) * 60,
      label: `READING ${i + 1} OF ${items.length}`,
      indeterminate: false,
    });

    const buffer = await item.file.arrayBuffer();
    const safePath = resolveUniqueArchivePath(
      item.relativePath || item.file.name,
      usedPaths,
      usedDirs
    );

    const entryLevel =
      level > 0 && ALREADY_COMPRESSED_EXT_PATTERN.test(safePath) ? 0 : level;

    workerEntries.push({
      path: safePath,
      buffer,
      level: entryLevel,
    });
    archivedPaths.push(safePath);
  }

  if (signal?.aborted) {
    throw new DOMException('Archive compression cancelled.', 'AbortError');
  }

  onProgress({
    progress: 75,
    label: level === 0 ? 'PACKAGING STORE ZIP' : `DEFLATE LEVEL ${level}`,
    indeterminate: true,
  });

  const zipBytes =
    typeof Worker !== 'undefined'
      ? await runZipInWorker(workerEntries, signal)
      : await runZipFallback(workerEntries);

  if (signal?.aborted) {
    throw new DOMException('Archive compression cancelled.', 'AbortError');
  }

  if (
    !(zipBytes instanceof Uint8Array) ||
    zipBytes.length < 22 ||
    zipBytes[0] !== 0x50 ||
    zipBytes[1] !== 0x4b
  ) {
    throw new Error('Generated ZIP archive failed signature verification.');
  }

  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const compressedSize = blob.size;
  const savings = calculateSavings(totalOriginalBytes, compressedSize);
  const safeArchiveName = sanitizeArchiveSegment(
    archiveName.endsWith('.zip') ? archiveName : `${archiveName}.zip`,
    true
  );
  const durationMs = Math.round(performance.now() - startTime);

  return {
    kind: 'zip',
    blob,
    originalSize: totalOriginalBytes,
    compressedSize,
    bytesSaved: savings.bytesSaved,
    percentageSaved: savings.percentage,
    wasReduced: savings.reduced,
    increasedSize: compressedSize > totalOriginalBytes,
    fileCount: archivedPaths.length,
    archivedPaths,
    level,
    preset: preset.id,
    methodUsed:
      level === 0 ? 'ZIP STORE (level 0)' : `ZIP DEFLATE (level ${level})`,
    outputFilename: safeArchiveName,
    durationMs,
  };
}
