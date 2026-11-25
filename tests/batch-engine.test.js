import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync } from 'fflate';

import { BATCH_LIMITS, QUEUE_STATUS } from '../src/config/batch-limits.js';
import {
  buildBatchZip,
  resolveUniqueArchiveName,
  sanitizeArchiveFilename,
} from '../src/engines/archive-builder.js';
import { createProcessingQueue } from '../src/state/processing-queue.js';

test('processing-queue manages items, reordering, overrides, limits, and byte-based summaries', () => {
  const queue = createProcessingQueue('Balanced');
  const { added, rejected } = queue.addFiles([
    { name: 'a.pdf', size: 1000 },
    { name: 'b.png', size: 2000 },
    { name: 'c.jpg', size: 3000 },
  ]);

  assert.equal(added.length, 3);
  assert.equal(rejected.length, 0);
  assert.equal(queue.moveItem(added[2].id, -1), true);
  assert.equal(queue.getItems()[1].name, 'c.jpg');

  queue.setItemPresetOverride(added[0].id, 'Light');
  assert.equal(queue.getEffectivePreset(added[0]), 'Light');
  assert.equal(queue.getEffectivePreset(added[1]), 'Balanced');

  queue.updateItem(added[0].id, {
    status: QUEUE_STATUS.COMPLETED,
    outputSize: 600,
    wasReduced: true,
  });
  queue.updateItem(added[1].id, {
    status: QUEUE_STATUS.UNCHANGED,
    outputSize: 2000,
    wasReduced: false,
  });
  queue.updateItem(added[2].id, {
    status: QUEUE_STATUS.FAILED,
    error: 'Corrupted',
  });

  const summary = queue.getAggregateSummary();
  assert.equal(summary.totalFiles, 3);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.unchangedCount, 1);
  assert.equal(summary.failedCount, 1);
  // Failed file (3000 B) must not be counted in successful byte totals
  assert.equal(summary.successfulOriginalBytes, 3000);
  assert.equal(summary.successfulOutputBytes, 2600);
  assert.equal(summary.totalBytesSaved, 400);

  assert.equal(queue.retryAllFailed(), 1);
  assert.equal(queue.getItem(added[2].id).status, QUEUE_STATUS.QUEUED);
});

test('processing-queue enforces maxFiles and maxTotalInputBytes limits', () => {
  const queue = createProcessingQueue();
  const manyFiles = Array.from(
    { length: BATCH_LIMITS.maxFiles + 3 },
    (_, i) => ({
      name: `file-${i}.pdf`,
      size: 100,
    })
  );
  const res = queue.addFiles(manyFiles);
  assert.equal(res.added.length, BATCH_LIMITS.maxFiles);
  assert.equal(res.rejected.length, 3);

  const sizeQueue = createProcessingQueue();
  const huge = sizeQueue.addFiles([
    { name: 'big1.pdf', size: BATCH_LIMITS.maxTotalInputBytes - 10 },
    { name: 'big2.pdf', size: 100 },
  ]);
  assert.equal(huge.added.length, 1);
  assert.equal(huge.rejected.length, 1);
});

test('archive-builder sanitizes paths, resolves duplicates, and builds verifiable ZIPs', async () => {
  assert.equal(sanitizeArchiveFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeArchiveFilename('C:\\temp\\doc.pdf'), 'doc.pdf');
  assert.equal(sanitizeArchiveFilename('..\\.hidden'), 'hidden');

  const used = new Set();
  assert.equal(
    resolveUniqueArchiveName('doc-compressed.pdf', used),
    'doc-compressed.pdf'
  );
  assert.equal(
    resolveUniqueArchiveName('doc-compressed.pdf', used),
    'doc-compressed (1).pdf'
  );
  assert.equal(
    resolveUniqueArchiveName('doc-compressed.pdf', used),
    'doc-compressed (2).pdf'
  );

  const pdfBytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\nendobj');
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  const items = [
    {
      name: 'doc.pdf',
      status: QUEUE_STATUS.COMPLETED,
      outputFilename: 'doc-compressed.pdf',
      outputBlob: new Blob([pdfBytes], { type: 'application/pdf' }),
    },
    {
      name: 'doc.pdf',
      status: QUEUE_STATUS.UNCHANGED,
      outputFilename: 'doc.pdf',
      outputBlob: new Blob([pdfBytes], { type: 'application/pdf' }),
    },
    {
      name: 'dup.pdf',
      status: QUEUE_STATUS.COMPLETED,
      outputFilename: 'doc-compressed.pdf',
      outputBlob: new Blob([pngBytes], { type: 'image/png' }),
    },
    {
      name: 'bad.pdf',
      status: QUEUE_STATUS.FAILED,
      outputBlob: null,
    },
  ];

  const archive = await buildBatchZip(items);
  assert.equal(archive.entryCount, 3);
  assert.deepEqual(archive.entryNames, [
    'doc-compressed.pdf',
    'doc.pdf',
    'doc-compressed (1).pdf',
  ]);

  const zipBuffer = new Uint8Array(await archive.blob.arrayBuffer());
  const extracted = unzipSync(zipBuffer);
  assert.deepEqual(Object.keys(extracted), [
    'doc-compressed.pdf',
    'doc.pdf',
    'doc-compressed (1).pdf',
  ]);
  assert.deepEqual(extracted['doc-compressed.pdf'], pdfBytes);
  assert.deepEqual(extracted['doc-compressed (1).pdf'], pngBytes);
});

test('archive-builder hardens reserved names, long names, Unicode/emoji, script text, and case-insensitive collisions', () => {
  assert.equal(sanitizeArchiveFilename('CON.pdf'), '_CON.pdf');
  assert.equal(sanitizeArchiveFilename('nul.png'), '_nul.png');
  assert.equal(
    sanitizeArchiveFilename('<script>alert(1)</script>.pdf'),
    'script_.pdf'
  );
  assert.equal(sanitizeArchiveFilename('résumé-📄.pdf'), 'résumé-📄.pdf');

  const longName = `${'a'.repeat(240)}.pdf`;
  const sanitizedLong = sanitizeArchiveFilename(longName);
  assert.ok(sanitizedLong.length <= 180);
  assert.ok(sanitizedLong.endsWith('.pdf'));

  const used = new Set();
  assert.equal(resolveUniqueArchiveName('Report.pdf', used), 'Report.pdf');
  assert.equal(resolveUniqueArchiveName('report.pdf', used), 'report (1).pdf');
});

test('processing-queue prevents removing active items and handles empty queue safely', () => {
  const queue = createProcessingQueue();
  const emptySummary = queue.getAggregateSummary();
  assert.equal(emptySummary.totalFiles, 0);
  assert.equal(emptySummary.overallPercentageSaved, 0);
  assert.equal(emptySummary.hasDownloadableOutputs, false);

  const { added } = queue.addFiles([{ name: 'active.pdf', size: 1000 }]);
  queue.updateItem(added[0].id, { status: QUEUE_STATUS.PROCESSING });
  assert.equal(queue.removeItem(added[0].id), false);
});
