import { ARCHIVE_LIMITS } from '../config/archive-presets.js';

export function isFolderPickerSupported(inputElement) {
  return Boolean(
    inputElement &&
    ('webkitdirectory' in inputElement || 'directory' in inputElement)
  );
}

export function normalizeSelectedFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  return files.map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    function readNext() {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all);
          } else {
            all.push(...batch);
            readNext();
          }
        },
        (err) => reject(err)
      );
    }
    readNext();
  });
}

function readEntryAsFile(fileEntry) {
  return new Promise((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });
}

async function traverseEntry(entry, prefix, results, depth, signal) {
  if (signal?.aborted) {
    throw new DOMException('Folder traversal cancelled.', 'AbortError');
  }

  if (results.length > ARCHIVE_LIMITS.maxFiles) {
    throw new Error(
      `Folder contains more than ${ARCHIVE_LIMITS.maxFiles} files.`
    );
  }

  if (depth > ARCHIVE_LIMITS.maxPathDepth) {
    throw new Error(
      `Folder exceeds maximum nesting depth of ${ARCHIVE_LIMITS.maxPathDepth}.`
    );
  }

  const nextPath = prefix ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await readEntryAsFile(entry);
    results.push({ file, relativePath: nextPath });
    return;
  }

  if (entry.isDirectory) {
    const reader = entry.createReader();
    const children = await readDirectoryEntries(reader);
    for (const child of children) {
      await traverseEntry(child, nextPath, results, depth + 1, signal);
    }
  }
}

export async function extractDroppedItems(dataTransfer, signal) {
  const items = Array.from(dataTransfer?.items || []);
  const entries = items
    .map((item) =>
      typeof item.webkitGetAsEntry === 'function'
        ? item.webkitGetAsEntry()
        : null
    )
    .filter(Boolean);

  if (entries.length === 0) {
    return normalizeSelectedFiles(dataTransfer?.files);
  }

  const hasDirectory = entries.some((entry) => entry.isDirectory);
  if (!hasDirectory) {
    return normalizeSelectedFiles(dataTransfer?.files);
  }

  const results = [];
  for (const entry of entries) {
    await traverseEntry(entry, '', results, 1, signal);
  }
  return results;
}
