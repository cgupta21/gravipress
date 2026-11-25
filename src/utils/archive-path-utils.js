import { ARCHIVE_LIMITS } from '../config/archive-presets.js';

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const PROTOTYPE_POLLUTION_KEY = /^(__proto__|constructor|prototype)$/i;
const MAX_SEGMENT_LENGTH = 120;

export function sanitizeArchiveSegment(segment, isLeaf = true) {
  let cleaned = String(segment || '')
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');

  if (!cleaned || cleaned === '.' || cleaned === '..') {
    cleaned = isLeaf ? 'file' : 'folder';
  }

  if (isLeaf) {
    const dotIdx = cleaned.lastIndexOf('.');
    let base = dotIdx > 0 ? cleaned.slice(0, dotIdx) : cleaned;
    const ext = dotIdx > 0 ? cleaned.slice(dotIdx) : '';

    if (
      WINDOWS_RESERVED_NAME.test(base) ||
      PROTOTYPE_POLLUTION_KEY.test(base)
    ) {
      base = `_${base}`;
    }

    const maxBase = Math.max(12, MAX_SEGMENT_LENGTH - ext.length);
    if (base.length > maxBase) {
      base = base.slice(0, maxBase);
    }
    return `${base}${ext}`;
  }

  if (
    WINDOWS_RESERVED_NAME.test(cleaned) ||
    PROTOTYPE_POLLUTION_KEY.test(cleaned)
  ) {
    cleaned = `_${cleaned}`;
  }
  if (cleaned.length > MAX_SEGMENT_LENGTH) {
    cleaned = cleaned.slice(0, MAX_SEGMENT_LENGTH);
  }
  return cleaned;
}

export function sanitizeRelativeArchivePath(rawPath) {
  let normalized = String(rawPath || 'file').replace(/\\/g, '/');

  // Strip UNC prefixes (//server/share) and Windows drive letters (C:/)
  normalized = normalized.replace(/^\/\/+[^/]+\/[^/]+\/?/, '');
  normalized = normalized.replace(/^[a-zA-Z]:/, '');

  const rawSegments = normalized
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');

  if (rawSegments.length === 0) {
    return 'file';
  }

  if (rawSegments.length > ARCHIVE_LIMITS.maxPathDepth) {
    throw new Error(
      `Archive path exceeds maximum depth of ${ARCHIVE_LIMITS.maxPathDepth} directories.`
    );
  }

  const sanitizedSegments = rawSegments.map((seg, idx) =>
    sanitizeArchiveSegment(seg, idx === rawSegments.length - 1)
  );

  let joined = sanitizedSegments.join('/');
  if (joined.length > ARCHIVE_LIMITS.maxArchivePathLength) {
    const leaf = sanitizedSegments[sanitizedSegments.length - 1];
    const dirSegments = sanitizedSegments.slice(0, -1);
    while (
      dirSegments.length > 0 &&
      `${dirSegments.join('/')}/${leaf}`.length >
        ARCHIVE_LIMITS.maxArchivePathLength
    ) {
      dirSegments.pop();
    }
    joined = dirSegments.length > 0 ? `${dirSegments.join('/')}/${leaf}` : leaf;
  }

  return joined;
}

export function resolveUniqueArchivePath(
  rawPath,
  usedFilePaths,
  usedDirPaths = new Set()
) {
  const safePath = sanitizeRelativeArchivePath(rawPath);
  const parts = safePath.split('/');
  const dirParts = parts.slice(0, -1);
  let leaf = parts[parts.length - 1];

  // Register parent directories and detect file-vs-directory conflicts
  let prefix = '';
  for (const dir of dirParts) {
    prefix = prefix ? `${prefix}/${dir}` : dir;
    const lowerPrefix = prefix.toLowerCase();
    if (usedFilePaths.has(lowerPrefix)) {
      // Directory collides with an existing file; rename parent segment
      prefix = `${prefix} (dir)`;
    }
    usedDirPaths.add(prefix.toLowerCase());
  }

  const buildCandidate = (name) => (prefix ? `${prefix}/${name}` : name);
  let candidate = buildCandidate(leaf);
  let lowerCandidate = candidate.toLowerCase();

  if (!usedFilePaths.has(lowerCandidate) && !usedDirPaths.has(lowerCandidate)) {
    usedFilePaths.add(lowerCandidate);
    return candidate;
  }

  const dotIdx = leaf.lastIndexOf('.');
  const base = dotIdx > 0 ? leaf.slice(0, dotIdx) : leaf;
  const ext = dotIdx > 0 ? leaf.slice(dotIdx) : '';

  let counter = 1;
  while (true) {
    const numberedLeaf = `${base} (${counter})${ext}`;
    candidate = buildCandidate(numberedLeaf);
    lowerCandidate = candidate.toLowerCase();
    if (
      !usedFilePaths.has(lowerCandidate) &&
      !usedDirPaths.has(lowerCandidate)
    ) {
      usedFilePaths.add(lowerCandidate);
      return candidate;
    }
    counter += 1;
  }
}
