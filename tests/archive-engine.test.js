import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { gunzipSync, unzipSync } from 'fflate';

import {
  ARCHIVE_LIMITS,
  ARCHIVE_PRESETS,
  validateCompressionLevel,
} from '../src/config/archive-presets.js';
import { compressFilesToZip } from '../src/engines/general-compressor.js';
import { compressFileToGzip } from '../src/engines/gzip-compressor.js';
import {
  resolveUniqueArchivePath,
  sanitizeRelativeArchivePath,
} from '../src/utils/archive-path-utils.js';

function makeMockFile(name, bytes) {
  const buf =
    bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  return {
    name,
    size: buf.byteLength,
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

test('archive-presets validates DEFLATE levels 0..9', () => {
  assert.equal(ARCHIVE_PRESETS.Fast.level, 1);
  assert.equal(ARCHIVE_PRESETS.Balanced.level, 6);
  assert.equal(ARCHIVE_PRESETS.Maximum.level, 9);
  assert.equal(ARCHIVE_PRESETS.Store.level, 0);

  for (const lvl of [0, 1, 6, 9]) {
    assert.equal(validateCompressionLevel(lvl), lvl);
  }
  assert.throws(() => validateCompressionLevel(-1));
  assert.throws(() => validateCompressionLevel(10));
  assert.throws(() => validateCompressionLevel(1.5));
});

test('archive-path-utils sanitizes unsafe paths, Windows reserved names, and file/dir conflicts', () => {
  assert.equal(sanitizeRelativeArchivePath('/etc/passwd'), 'etc/passwd');
  assert.equal(
    sanitizeRelativeArchivePath('C:\\Users\\admin\\data.csv'),
    'Users/admin/data.csv'
  );
  assert.equal(
    sanitizeRelativeArchivePath('\\\\server\\share\\folder\\notes.txt'),
    'folder/notes.txt'
  );
  assert.equal(
    sanitizeRelativeArchivePath('../../secret\x00/CON.txt '),
    'secret_/_CON.txt'
  );
  assert.equal(
    sanitizeRelativeArchivePath('folder/résumé-📄.json'),
    'folder/résumé-📄.json'
  );
  assert.equal(
    sanitizeRelativeArchivePath('__proto__/constructor.json'),
    '___proto__/_constructor.json'
  );

  const deepPath =
    Array.from(
      { length: ARCHIVE_LIMITS.maxPathDepth + 2 },
      (_, i) => `d${i}`
    ).join('/') + '/a.txt';
  assert.throws(() => sanitizeRelativeArchivePath(deepPath), /maximum depth/i);

  const usedFiles = new Set();
  const usedDirs = new Set();
  assert.equal(resolveUniqueArchivePath('docs', usedFiles, usedDirs), 'docs');
  assert.equal(
    resolveUniqueArchivePath('docs/readme.md', usedFiles, usedDirs),
    'docs (dir)/readme.md'
  );
  assert.equal(
    resolveUniqueArchivePath('docs/README.md', usedFiles, usedDirs),
    'docs (dir)/README (1).md'
  );
});

test('compressFilesToZip compresses mixed files and nested folders with exact byte-for-byte restoration', async () => {
  const textData = new TextEncoder().encode(
    'Gravipress lossless line\n'.repeat(200)
  );
  const jsonData = new TextEncoder().encode(
    JSON.stringify({
      rows: Array.from({ length: 50 }, (_, i) => ({
        id: i,
        tag: 'gravipress',
      })),
    })
  );
  const emptyData = new Uint8Array(0);
  const randomData = crypto.randomBytes(2048);

  const items = [
    {
      file: makeMockFile('notes.txt', textData),
      relativePath: 'project/docs/notes.txt',
    },
    {
      file: makeMockFile('data.json', jsonData),
      relativePath: 'project/data.json',
    },
    {
      file: makeMockFile('empty.txt', emptyData),
      relativePath: 'project/empty.txt',
    },
    {
      file: makeMockFile('blob.bin', randomData),
      relativePath: 'project/blob.bin',
    },
    {
      file: makeMockFile('notes.txt', textData),
      relativePath: 'project/docs/NOTES.txt',
    },
  ];

  const fast = await compressFilesToZip(items, { presetId: 'Fast' });
  const balanced = await compressFilesToZip(items, { presetId: 'Balanced' });
  const maximum = await compressFilesToZip(items, { presetId: 'Maximum' });
  const store = await compressFilesToZip(items, { presetId: 'Store' });

  assert.ok(fast.compressedSize < store.compressedSize);
  assert.ok(balanced.compressedSize < store.compressedSize);
  assert.ok(maximum.compressedSize < store.compressedSize);

  const extracted = unzipSync(
    new Uint8Array(await balanced.blob.arrayBuffer())
  );
  assert.deepEqual(Object.keys(extracted), [
    'project/docs/notes.txt',
    'project/data.json',
    'project/empty.txt',
    'project/blob.bin',
    'project/docs/NOTES (1).txt',
  ]);
  assert.deepEqual(extracted['project/docs/notes.txt'], textData);
  assert.deepEqual(extracted['project/data.json'], jsonData);
  assert.deepEqual(extracted['project/empty.txt'], emptyData);
  assert.deepEqual(extracted['project/blob.bin'], new Uint8Array(randomData));

  // Independent verification via system bsdtar/tar
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gravipress-zip-test-')
  );
  try {
    const zipFilePath = path.join(tempDir, 'balanced.zip');
    const extractDir = path.join(tempDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(
      zipFilePath,
      Buffer.from(await balanced.blob.arrayBuffer())
    );

    // List and extract with tar.exe (independent libarchive)
    const listOut = execFileSync('tar.exe', ['-tf', zipFilePath], {
      encoding: 'utf8',
    });
    const listedFiles = listOut
      .trim()
      .split(/\r?\n/)
      .map((s) => s.replace(/\\/g, '/'))
      .sort();
    assert.deepEqual(listedFiles, [
      'project/blob.bin',
      'project/data.json',
      'project/docs/NOTES (1).txt',
      'project/docs/notes.txt',
      'project/empty.txt',
    ]);

    execFileSync('tar.exe', ['-xf', zipFilePath, '-C', extractDir]);
    assert.deepEqual(
      fs.readFileSync(path.join(extractDir, 'project/docs/notes.txt')),
      Buffer.from(textData)
    );
    assert.deepEqual(
      fs.readFileSync(path.join(extractDir, 'project/data.json')),
      Buffer.from(jsonData)
    );
    assert.deepEqual(
      fs.readFileSync(path.join(extractDir, 'project/empty.txt')),
      Buffer.from(emptyData)
    );
    assert.deepEqual(
      fs.readFileSync(path.join(extractDir, 'project/blob.bin')),
      Buffer.from(randomData)
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('compressFileToGzip produces valid .gz streams with exact byte restoration and overhead awareness', async () => {
  const csv = 'id,name,score\n'.repeat(500);
  const csvFile = makeMockFile('dataset.csv', csv);

  const gz = await compressFileToGzip(csvFile, { presetId: 'Maximum' });
  assert.equal(gz.outputFilename, 'dataset.csv.gz');
  assert.equal(gz.wasReduced, true);

  const gzBytes = new Uint8Array(await gz.blob.arrayBuffer());
  assert.equal(gzBytes[0], 0x1f);
  assert.equal(gzBytes[1], 0x8b);
  assert.equal(new TextDecoder().decode(gunzipSync(gzBytes)), csv);
  // Independent Node zlib gunzip verification
  assert.equal(zlib.gunzipSync(Buffer.from(gzBytes)).toString('utf8'), csv);

  // Tiny incompressible input should report overhead accurately
  const tinyFile = makeMockFile('tiny.bin', new Uint8Array([1, 2, 3]));
  const tinyGz = await compressFileToGzip(tinyFile, { presetId: 'Balanced' });
  assert.equal(tinyGz.wasReduced, false);
  assert.equal(tinyGz.increasedSize, true);
});

test('general-compressor and gzip-compressor enforce limits and cancellation', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      compressFilesToZip(
        [{ file: makeMockFile('a.txt', 'hello'), relativePath: 'a.txt' }],
        { signal: controller.signal }
      ),
    { name: 'AbortError' }
  );

  await assert.rejects(
    () =>
      compressFileToGzip(makeMockFile('a.txt', 'hello'), {
        signal: controller.signal,
      }),
    { name: 'AbortError' }
  );

  await assert.rejects(
    () =>
      compressFilesToZip([
        {
          file: {
            name: 'huge.bin',
            size: ARCHIVE_LIMITS.maxSingleFileBytes + 1,
          },
          relativePath: 'huge.bin',
        },
      ]),
    /single-file limit/i
  );
});
