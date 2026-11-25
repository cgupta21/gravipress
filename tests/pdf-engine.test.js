import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

import { COMPRESSION_PRESETS } from '../src/config/compression-presets.js';
import { compressPdf } from '../src/engines/pdf-compressor.js';
import { generateSamplePdfBytes } from '../src/engines/pdf-preview.js';
import {
  buildCompressedFilename,
  calculateSavings,
  detectDigitalSignature,
  formatFileSize,
  hasPdfHeader,
  validatePdfFile,
} from '../src/utils/file-utils.js';

test('compression presets define expected defaults and warnings', () => {
  assert.equal(COMPRESSION_PRESETS.Light.isLossy, false);
  assert.equal(COMPRESSION_PRESETS.Light.warning, null);

  assert.equal(COMPRESSION_PRESETS.Balanced.isLossy, true);
  assert.equal(COMPRESSION_PRESETS.Balanced.dpi, 144);
  assert.equal(COMPRESSION_PRESETS.Balanced.jpegQuality, 0.75);
  assert.match(COMPRESSION_PRESETS.Balanced.warning, /rasterize/i);

  assert.equal(COMPRESSION_PRESETS.Maximum.isLossy, true);
  assert.equal(COMPRESSION_PRESETS.Maximum.dpi, 96);
  assert.equal(COMPRESSION_PRESETS.Maximum.jpegQuality, 0.5);
  assert.ok(COMPRESSION_PRESETS.Maximum.warning.includes('rasterizes'));
});

test('file-utils formats sizes, calculates savings, and builds filenames', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1048576), '1.00 MB');

  assert.deepEqual(calculateSavings(1000, 600), {
    bytesSaved: 400,
    percentage: 40,
    reduced: true,
  });
  assert.deepEqual(calculateSavings(1000, 1200), {
    bytesSaved: -200,
    percentage: -20,
    reduced: false,
  });
  assert.deepEqual(calculateSavings(0, 0), {
    bytesSaved: 0,
    percentage: 0,
    reduced: false,
  });

  assert.equal(buildCompressedFilename('report.pdf'), 'report-compressed.pdf');
  assert.equal(buildCompressedFilename('ANNUAL.PDF'), 'ANNUAL-compressed.pdf');
});

test('file-utils validates PDF headers, unsupported formats, and signatures', () => {
  const validBytes = new TextEncoder().encode('%PDF-1.7\n...');
  const invalidBytes = new TextEncoder().encode('<html>not a pdf</html>');

  assert.equal(hasPdfHeader(validBytes), true);
  assert.equal(hasPdfHeader(invalidBytes), false);
  assert.equal(hasPdfHeader(new Uint8Array(0)), false);

  assert.equal(
    validatePdfFile({ name: 'doc.pdf', size: validBytes.length }, validBytes)
      .valid,
    true
  );
  assert.equal(
    validatePdfFile(
      { name: 'fake.pdf', size: invalidBytes.length },
      invalidBytes
    ).valid,
    false
  );
  assert.equal(
    validatePdfFile({ name: 'empty.pdf', size: 0 }, new Uint8Array(0)).valid,
    false
  );

  for (const ext of ['mp4', 'mp3', 'zip']) {
    const check = validatePdfFile(
      { name: `file.${ext}`, size: 10 },
      new Uint8Array(10)
    );
    assert.equal(check.valid, false);
    assert.ok(check.error.includes('not yet supported'));
  }

  const signedBytes = new TextEncoder().encode(
    '%PDF-1.7 /Type /Sig /ByteRange [0 100 200 300]'
  );
  assert.equal(detectDigitalSignature(validBytes), false);
  assert.equal(detectDigitalSignature(signedBytes), true);
});

test('Light compression reduces sample PDF and preserves page count & dimensions', async () => {
  const sampleBytes = new Uint8Array(await generateSamplePdfBytes());
  const result = await compressPdf(sampleBytes, 'Light');

  assert.equal(result.mode, 'Light');
  assert.equal(result.methodUsed, 'Structural optimization');
  assert.equal(result.pageCount, 2);
  assert.equal(result.originalSize, sampleBytes.byteLength);
  assert.equal(result.wasReduced, true);
  assert.ok(result.compressedSize < result.originalSize);
  assert.ok(result.percentageSaved > 0);

  const reopened = await PDFDocument.load(result.bytes);
  assert.equal(reopened.getPageCount(), 2);
  const firstPageSize = reopened.getPage(0).getSize();
  assert.equal(firstPageSize.width, 595);
  assert.equal(firstPageSize.height, 842);
});

test('Light compression preserves landscape, rotated pages, and form fields', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const landscape = doc.addPage([842, 595]);
  landscape.drawText('Landscape page with form field', {
    x: 40,
    y: 520,
    size: 14,
    font,
  });

  const form = doc.getForm();
  const textField = form.createTextField('sample.field');
  textField.setText('Gravipress');
  textField.addToPage(landscape, { x: 40, y: 460, width: 200, height: 24 });

  const rotated = doc.addPage([595, 842]);
  rotated.setRotation(degrees(90));
  rotated.drawText('Rotated page', { x: 40, y: 760, size: 14, font });

  const rawBytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
  const result = await compressPdf(rawBytes, 'Light');

  const reopened = await PDFDocument.load(result.bytes);
  assert.equal(reopened.getPageCount(), 2);
  assert.deepEqual(reopened.getPage(0).getSize(), { width: 842, height: 595 });
  assert.equal(reopened.getPage(1).getRotation().angle, 90);
  assert.equal(
    reopened.getForm().getTextField('sample.field').getText(),
    'Gravipress'
  );
});

test('Retains original file when Light compression cannot reduce size further', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const alreadyOptimized = new Uint8Array(
    await doc.save({ useObjectStreams: true })
  );

  const result = await compressPdf(alreadyOptimized, 'Light');
  assert.equal(result.wasReduced, false);
  assert.equal(result.methodUsed, 'Unchanged (original retained)');
  assert.equal(result.compressedSize, alreadyOptimized.byteLength);
  assert.equal(result.bytesSaved, 0);
  assert.equal(result.percentageSaved, 0);
});

test('Rejects corrupted, encrypted, and cancelled PDF operations cleanly', async () => {
  const corrupted = new TextEncoder().encode('%PDF-1.7\ncorrupted-xref');
  await assert.rejects(() => compressPdf(corrupted, 'Light'), {
    message: /corrupted|unsupported/i,
  });

  const encryptedMock = new TextEncoder().encode(
    '%PDF-1.7\n1 0 obj\n<< /Encrypt 2 0 R >>\nendobj'
  );
  await assert.rejects(() => compressPdf(encryptedMock, 'Light'));

  const sampleBytes = new Uint8Array(await generateSamplePdfBytes());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => compressPdf(sampleBytes, 'Light', { signal: controller.signal }),
    { name: 'AbortError' }
  );
});
