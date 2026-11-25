import { QUEUE_STATUS } from '../config/batch-limits.js';

let fflatePromise = null;

async function loadFflate() {
  if (!fflatePromise) {
    fflatePromise = import('fflate');
  }
  return fflatePromise;
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_ARCHIVE_FILENAME_LENGTH = 180;

export function sanitizeArchiveFilename(filename) {
  const raw = String(filename || 'file').replace(/\\/g, '/');
  const segments = raw
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..');
  const leaf = segments.length > 0 ? segments[segments.length - 1] : 'file';
  let cleaned = leaf
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');

  if (!cleaned) {
    cleaned = 'file';
  }

  const dotIdx = cleaned.lastIndexOf('.');
  let base = dotIdx > 0 ? cleaned.slice(0, dotIdx) : cleaned;
  const ext = dotIdx > 0 ? cleaned.slice(dotIdx) : '';

  if (WINDOWS_RESERVED_NAME.test(base)) {
    base = `_${base}`;
  }

  const maxBaseLen = Math.max(16, MAX_ARCHIVE_FILENAME_LENGTH - ext.length);
  if (base.length > maxBaseLen) {
    base = base.slice(0, maxBaseLen);
  }

  return `${base}${ext}`;
}

export function resolveUniqueArchiveName(desiredName, usedNames) {
  const safe = sanitizeArchiveFilename(desiredName);
  const lower = safe.toLowerCase();
  if (!usedNames.has(lower)) {
    usedNames.add(lower);
    return safe;
  }

  const dotIdx = safe.lastIndexOf('.');
  const base = dotIdx > 0 ? safe.slice(0, dotIdx) : safe;
  const ext = dotIdx > 0 ? safe.slice(dotIdx) : '';

  let counter = 1;
  while (true) {
    const candidate = `${base} (${counter})${ext}`;
    const candidateLower = candidate.toLowerCase();
    if (!usedNames.has(candidateLower)) {
      usedNames.add(candidateLower);
      return candidate;
    }
    counter += 1;
  }
}

export async function buildBatchZip(items, options = {}) {
  const { signal, onProgress = () => {} } = options;
  const startTime = performance.now();

  if (signal?.aborted) {
    throw new DOMException('ZIP generation cancelled.', 'AbortError');
  }

  const eligible = items.filter(
    (item) =>
      (item.status === QUEUE_STATUS.COMPLETED ||
        item.status === QUEUE_STATUS.UNCHANGED) &&
      item.outputBlob instanceof Blob
  );

  if (eligible.length === 0) {
    throw new Error('No successful outputs are available to archive.');
  }

  const { zip } = await loadFflate();
  const usedNames = new Set();
  const entries = {};
  const entryNames = [];

  for (let i = 0; i < eligible.length; i += 1) {
    if (signal?.aborted) {
      throw new DOMException('ZIP generation cancelled.', 'AbortError');
    }

    const item = eligible[i];
    onProgress({
      progress: ((i + 1) / (eligible.length + 1)) * 80,
      label: `PACKAGING ${i + 1} OF ${eligible.length}`,
    });

    const entryName = resolveUniqueArchiveName(
      item.outputFilename || item.name,
      usedNames
    );
    const bytes = new Uint8Array(await item.outputBlob.arrayBuffer());
    // Use STORE (level 0) to avoid wasting CPU/memory recompressing PDFs and media.
    entries[entryName] = [bytes, { level: 0 }];
    entryNames.push(entryName);
  }

  if (signal?.aborted) {
    throw new DOMException('ZIP generation cancelled.', 'AbortError');
  }

  onProgress({ progress: 90, label: 'FINALIZING ZIP' });

  const zipBytes = await new Promise((resolve, reject) => {
    zip(entries, { level: 0 }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });

  if (signal?.aborted) {
    throw new DOMException('ZIP generation cancelled.', 'AbortError');
  }

  const hasEocd =
    zipBytes.length >= 22 &&
    (() => {
      const scanStart = Math.max(0, zipBytes.length - 65558);
      for (let i = zipBytes.length - 22; i >= scanStart; i -= 1) {
        if (
          zipBytes[i] === 0x50 &&
          zipBytes[i + 1] === 0x4b &&
          zipBytes[i + 2] === 0x05 &&
          zipBytes[i + 3] === 0x06
        ) {
          return true;
        }
      }
      return false;
    })();

  if (
    !(zipBytes instanceof Uint8Array) ||
    zipBytes.length < 22 ||
    zipBytes[0] !== 0x50 ||
    zipBytes[1] !== 0x4b ||
    !hasEocd
  ) {
    throw new Error('Generated ZIP archive failed structure verification.');
  }

  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const durationMs = Math.round(performance.now() - startTime);

  return {
    blob,
    archiveSize: blob.size,
    entryCount: entryNames.length,
    entryNames,
    durationMs,
  };
}
