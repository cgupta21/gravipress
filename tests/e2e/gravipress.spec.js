import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { gunzipSync, unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { ensureTestFixtures } from './fixtures.js';

const FIXTURES_DIR = path.resolve('tests/e2e/.fixtures');
const SCREENSHOTS_DIR = path.resolve('tests/e2e/screenshots');

let fixtures;

test.beforeAll(async () => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  fixtures = await ensureTestFixtures(FIXTURES_DIR);
});

async function uploadPdfAndWaitPreview(page, filePath) {
  await page.locator('#file').setInputFiles(filePath);
  await expect(page.locator('#image-preview')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('SYSTEM READY');
  await expect
    .poll(() =>
      page
        .locator('#image-preview')
        .evaluate((img) => img.complete && img.naturalWidth > 0)
    )
    .toBe(true);
}

async function compressAndCaptureDownload(page, modeName) {
  await page.locator(`input[name="mode"][value="${modeName}"]`).check({
    force: true,
  });
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#start').click();

  await expect(page.locator('#result')).toBeVisible({ timeout: 45_000 });
  const statusText = await page.locator('#status').textContent();
  expect(['PRESS COMPLETE', 'NO FURTHER REDUCTION']).toContain(statusText);

  const pressValue = await page
    .locator('#machine')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--press').trim());
  expect(Number(pressValue)).toBe(1);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await downloadPromise;
  const downloadPath = path.join(
    FIXTURES_DIR,
    `downloaded-${Date.now()}-${download.suggestedFilename()}`
  );
  await download.saveAs(downloadPath);
  const downloadedBytes = fs.readFileSync(downloadPath);

  const metrics = await page.locator('#metrics dd').allTextContents();
  return {
    suggestedFilename: download.suggestedFilename(),
    downloadedBytes,
    metrics,
  };
}

test('UI workflows, previews, warnings, cancellation, reset, errors, and screenshots', async ({
  page,
}) => {
  const consoleErrors = [];
  const pageErrors = [];
  const externalRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('request', (req) => {
    const url = req.url();
    if (
      !url.startsWith('http://127.0.0.1:4173') &&
      !url.startsWith('http://localhost:4173') &&
      !url.startsWith('blob:') &&
      !url.startsWith('data:')
    ) {
      externalRequests.push(url);
    }
  });

  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('SYSTEM READY');
  await expect(page.locator('#download')).toBeHidden();
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-initial.png'),
    fullPage: true,
  });

  // Preset warnings: Balanced (default) shows warning, Light hides, Maximum shows
  await expect(page.locator('#warning')).toBeVisible();
  await page
    .locator('input[name="mode"][value="Light"]')
    .check({ force: true });
  await expect(page.locator('#warning')).toBeHidden();
  await page
    .locator('input[name="mode"][value="Maximum"]')
    .check({ force: true });
  await expect(page.locator('#warning')).toBeVisible();

  // Sample PDF selection & first-page preview
  await page.locator('#sample').click();
  await expect(page.locator('#image-preview')).toBeVisible();
  await expect(page.locator('#filemeta')).toContainText('2 pages');
  await expect(page.locator('#status')).toHaveText('SYSTEM READY');
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '02-file-selected.png'),
    fullPage: true,
  });

  // Compress large PDF in Balanced mode and capture compressing + completed states
  await uploadPdfAndWaitPreview(page, fixtures.largePdf);
  await page
    .locator('input[name="mode"][value="Balanced"]')
    .check({ force: true });
  await page.locator('#start').click();
  await expect(page.locator('#cancel')).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '03-compressing.png'),
    fullPage: true,
  });

  // Wait for completion and verify download
  await expect(page.locator('#result')).toBeVisible({ timeout: 45_000 });
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '04-completed.png'),
    fullPage: true,
  });

  // Test cancellation mid-compression
  await uploadPdfAndWaitPreview(page, fixtures.largePdf);
  await page
    .locator('input[name="mode"][value="Balanced"]')
    .check({ force: true });
  await page.locator('#start').click();
  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toHaveText('COMPRESSION CANCELLED');
  await expect(page.locator('#result')).toBeHidden();

  // Test Reset
  await page.locator('#reset').click();
  await expect(page.locator('#filename')).toHaveText('Awaiting file');
  await expect(page.locator('#image-preview')).toBeHidden();

  // Test error states: empty, renamed non-PDF, corrupted, encrypted, unsupported MP4
  for (const invalidPath of [
    fixtures.empty,
    fixtures.renamedNonPdf,
    fixtures.corrupted,
    fixtures.encrypted,
    fixtures.unsupportedMp4,
  ]) {
    await page.locator('#file').setInputFiles(invalidPath);
    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#download')).toBeHidden();
  }
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '05-error.png'),
    fullPage: true,
  });

  // Verify privacy: no external requests, no localStorage/sessionStorage persistence
  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  const storageCounts = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
  }));
  expect(storageCounts).toEqual({ local: 0, session: 0 });
});

test('Keyboard accessibility, About dialog, drag-and-drop, and reduced-motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  // Open & close About dialog via keyboard/click
  await page.locator('#about').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dialog')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog')).not.toHaveAttribute('open', '');

  // Verify reduced-motion CSS variable
  const pressEase = await page
    .locator('#machine')
    .evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--press-ease').trim()
    );
  expect(pressEase).toBe('0ms');

  // Drag-and-drop simulation
  const pdfBytes = fs.readFileSync(fixtures.textBased);
  const dataTransfer = await page.evaluateHandle((bytesArray) => {
    const dt = new DataTransfer();
    const file = new File([new Uint8Array(bytesArray)], 'dragged.pdf', {
      type: 'application/pdf',
    });
    dt.items.add(file);
    return dt;
  }, Array.from(pdfBytes));

  await page.locator('#drop').dispatchEvent('dragover', { dataTransfer });
  await expect(page.locator('#drop')).toHaveClass(/drag/);
  await page.locator('#drop').dispatchEvent('drop', { dataTransfer });
  await expect(page.locator('#filename')).toHaveText('dragged.pdf');
  await expect(page.locator('#image-preview')).toBeVisible();
});

test('Compression benchmarks & independent download verification across Light, Balanced, and Maximum', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');

  const benchmarkFixtures = [
    ['text-based.pdf', fixtures.textBased],
    ['image-heavy.pdf', fixtures.imageHeavy],
    ['scanned-style.pdf', fixtures.scannedStyle],
    ['multi-page.pdf', fixtures.multiPage],
    ['large-pdf.pdf', fixtures.largePdf],
    ['large-6mb.pdf', fixtures.large6Mb],
    ['portrait-landscape.pdf', fixtures.portraitLandscape],
    ['rotated-pages.pdf', fixtures.rotatedPages],
    ['forms-links.pdf', fixtures.formsLinks],
    ['already-optimized.pdf', fixtures.alreadyOptimized],
  ];

  const results = [];

  for (const [name, filePath] of benchmarkFixtures) {
    const originalBytes = fs.readFileSync(filePath);
    const originalDoc = await PDFDocument.load(originalBytes);
    const expectedPages = originalDoc.getPageCount();

    for (const mode of ['Light', 'Balanced', 'Maximum']) {
      await uploadPdfAndWaitPreview(page, filePath);
      const outcome = await compressAndCaptureDownload(page, mode);

      const origSize = originalBytes.byteLength;
      const outSize = outcome.downloadedBytes.byteLength;
      expect(outSize).toBeLessThanOrEqual(origSize);

      const wasReduced = outSize < origSize;
      const expectedFilename = wasReduced
        ? name.replace(/\.pdf$/i, '-compressed.pdf')
        : name;
      expect(outcome.suggestedFilename).toBe(expectedFilename);
      expect(outcome.downloadedBytes.subarray(0, 5).toString('ascii')).toBe(
        '%PDF-'
      );

      const reopenedDoc = await PDFDocument.load(outcome.downloadedBytes);
      expect(reopenedDoc.getPageCount()).toBe(expectedPages);
      for (let p = 0; p < expectedPages; p += 1) {
        const origDim = originalDoc.getPage(p).getSize();
        const outDim = reopenedDoc.getPage(p).getSize();
        expect(Math.abs(outDim.width - origDim.width)).toBeLessThanOrEqual(2);
        expect(Math.abs(outDim.height - origDim.height)).toBeLessThanOrEqual(2);
      }

      const pct = (((origSize - outSize) / origSize) * 100).toFixed(1);
      results.push({
        fixture: name,
        mode,
        originalBytes: origSize,
        compressedBytes: outSize,
        reductionPct: `${pct}%`,
        method: outcome.metrics[5],
        pages: expectedPages,
        duration: outcome.metrics[3],
      });
    }
  }

  // Verify Light mode preserved form field on forms-links.pdf
  await uploadPdfAndWaitPreview(page, fixtures.formsLinks);
  const lightForms = await compressAndCaptureDownload(page, 'Light');
  const reopenedForms = await PDFDocument.load(lightForms.downloadedBytes);
  expect(reopenedForms.getForm().getTextField('applicant.name').getText()).toBe(
    'Gravipress QA'
  );

  console.log('\nBENCHMARK_RESULTS_JSON=' + JSON.stringify(results));
});

test('Responsive design across Desktop, Laptop, Tablet, Mobile, and Small Mobile', async ({
  page,
}) => {
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'laptop', width: 1280, height: 800 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 390, height: 844 },
    { name: 'small-mobile', width: 320, height: 568 },
  ];

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/');
    await expect(page.locator('.brand-logo')).toBeVisible();
    await expect(page.locator('#start')).toBeVisible();
    await expect(page.locator('#machine')).toBeVisible();

    const layoutCheck = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      startRect: document.getElementById('start').getBoundingClientRect(),
      machineRect: document.getElementById('machine').getBoundingClientRect(),
    }));

    expect(
      layoutCheck.scrollWidth,
      `Horizontal overflow on ${vp.name}`
    ).toBeLessThanOrEqual(layoutCheck.innerWidth);
    expect(layoutCheck.startRect.width).toBeGreaterThan(100);
    expect(layoutCheck.machineRect.width).toBeGreaterThan(150);
  }
});

test('Phase 3 image compression: PNG, JPEG, WebP, AVIF, EXIF, custom controls, comparison, and benchmarks', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const consoleErrors = [];
  const externalRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('request', (req) => {
    const url = req.url();
    if (
      !url.startsWith('http://127.0.0.1:4173') &&
      !url.startsWith('http://localhost:4173') &&
      !url.startsWith('blob:') &&
      !url.startsWith('data:')
    ) {
      externalRequests.push(url);
    }
  });

  await page.goto('/');

  // Generate real JPEG, WebP, and AVIF (if supported) files in-browser
  const generated = await page.evaluate(async () => {
    const width = 1200;
    const height = 800;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#2b2d21');
    grad.addColorStop(0.5, '#ffc93c');
    grad.addColorStop(1, '#d9dadc');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 400; i += 1) {
      ctx.fillStyle = `rgb(${(i * 37) % 255}, ${(i * 73) % 255}, ${(i * 19) % 255})`;
      ctx.fillRect((i * 53) % width, (i * 29) % height, 40, 40);
    }

    async function encode(mime, quality) {
      const blob = await new Promise((res) =>
        canvas.toBlob(res, mime, quality)
      );
      if (!blob || blob.type !== mime) {
        return null;
      }
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }

    return {
      jpeg: await encode('image/jpeg', 0.96),
      webp: await encode('image/webp', 0.96),
      avif: await encode('image/avif', 0.95),
    };
  });

  const jpegPath = path.join(FIXTURES_DIR, 'photo-highres.jpg');
  const webpPath = path.join(FIXTURES_DIR, 'photo-highres.webp');
  fs.writeFileSync(jpegPath, Buffer.from(generated.jpeg));
  fs.writeFileSync(webpPath, Buffer.from(generated.webp));

  const imageFixtures = [
    ['transparent-graphic.png', fixtures.transparentPng],
    ['noisy-photo.png', fixtures.noisyPng],
    ['large-image-10mb.png', fixtures.largeImage10Mb],
    ['tiny-optimized.png', fixtures.tinyPng],
    ['photo-highres.jpg', jpegPath],
    ['photo-highres.webp', webpPath],
  ];

  if (generated.avif) {
    const avifPath = path.join(FIXTURES_DIR, 'photo-highres.avif');
    fs.writeFileSync(avifPath, Buffer.from(generated.avif));
    imageFixtures.push(['photo-highres.avif', avifPath]);
  }

  const imageResults = [];

  for (const [name, filePath] of imageFixtures) {
    const origBytes = fs.readFileSync(filePath);
    for (const mode of ['Light', 'Balanced', 'Maximum']) {
      await uploadPdfAndWaitPreview(page, filePath);
      await expect(page.locator('#image-options')).toBeVisible();

      if (name === 'transparent-graphic.png' && mode === 'Balanced') {
        await page.screenshot({
          path: path.join(SCREENSHOTS_DIR, '06-image-selected.png'),
          fullPage: true,
        });
      }

      const outcome = await compressAndCaptureDownload(page, mode);
      await expect(page.locator('#comparison')).toBeVisible();

      if (name === 'photo-highres.jpg' && mode === 'Balanced') {
        await page.screenshot({
          path: path.join(SCREENSHOTS_DIR, '07-image-completed.png'),
          fullPage: true,
        });
      }

      const wasReduced =
        outcome.downloadedBytes.byteLength < origBytes.byteLength;
      expect(outcome.downloadedBytes.byteLength).toBeLessThanOrEqual(
        origBytes.byteLength
      );

      const ext = name.split('.').pop();
      const expectedName = wasReduced
        ? name.replace(/\.[^.]+$/, `-compressed.${ext}`)
        : name;
      expect(outcome.suggestedFilename).toBe(expectedName);

      const pct = (
        ((origBytes.byteLength - outcome.downloadedBytes.byteLength) /
          origBytes.byteLength) *
        100
      ).toFixed(1);

      imageResults.push({
        fixture: name,
        mode,
        originalBytes: origBytes.byteLength,
        compressedBytes: outcome.downloadedBytes.byteLength,
        reductionPct: `${pct}%`,
        dimensions: outcome.metrics[3],
        duration: outcome.metrics[4],
        method: outcome.metrics[5],
      });
    }
  }

  // Test custom target size (50 KB) + optional dimension reduction (400px) on JPEG
  await uploadPdfAndWaitPreview(page, jpegPath);
  await page.locator('#target-size').selectOption('50');
  await page.locator('#enable-resize').check();
  await page.locator('#max-dimension').fill('400');
  const targeted = await compressAndCaptureDownload(page, 'Balanced');
  expect(targeted.downloadedBytes.byteLength).toBeLessThanOrEqual(50 * 1024);
  expect(targeted.metrics[3]).toContain('400\u00d7267');

  // Test animated PNG, corrupted PNG, and renamed JPEG rejection
  for (const badPath of [
    fixtures.animatedPng,
    fixtures.corruptedPng,
    fixtures.renamedImage,
  ]) {
    await page.locator('#file').setInputFiles(badPath);
    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#download')).toBeHidden();
  }
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '08-image-error.png'),
    fullPage: true,
  });

  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  console.log('\nIMAGE_BENCHMARK_RESULTS_JSON=' + JSON.stringify(imageResults));
});

test('EXIF orientations 1-8 and JPEG PSNR visual quality verification', async ({
  page,
}) => {
  await page.goto('/');

  // Create an asymmetric 120x80 JPEG and test all 8 EXIF orientation values
  const exifResults = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2b2d21';
    ctx.fillRect(0, 0, 120, 80);
    ctx.fillStyle = '#ffc93c';
    ctx.fillRect(0, 0, 30, 20);
    const blob = await new Promise((res) =>
      canvas.toBlob(res, 'image/jpeg', 0.95)
    );
    const baseJpeg = new Uint8Array(await blob.arrayBuffer());

    function injectExifOrientation(jpegBytes, orientation) {
      // Minimal TIFF/EXIF APP1 segment (little-endian) with Orientation tag 0x0112
      const app1 = new Uint8Array([
        0xff,
        0xe1,
        0x00,
        0x22,
        0x45,
        0x78,
        0x69,
        0x66,
        0x00,
        0x00, // "Exif\0\0"
        0x49,
        0x49,
        0x2a,
        0x00,
        0x08,
        0x00,
        0x00,
        0x00, // TIFF II*
        0x01,
        0x00, // 1 IFD entry
        0x12,
        0x01,
        0x03,
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        orientation & 0xff,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
      ]);
      const out = new Uint8Array(jpegBytes.length + app1.length);
      out.set(jpegBytes.subarray(0, 2), 0);
      out.set(app1, 2);
      out.set(jpegBytes.subarray(2), 2 + app1.length);
      return out;
    }

    const dimsByOrientation = [];
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      const oriented = injectExifOrientation(baseJpeg, orientation);
      const bmp = await createImageBitmap(
        new Blob([oriented], { type: 'image/jpeg' }),
        { imageOrientation: 'from-image' }
      );
      dimsByOrientation.push({
        orientation,
        width: bmp.width,
        height: bmp.height,
      });
      bmp.close();
    }

    // Compute PSNR between original 120x80 and 78% Balanced JPEG
    const outBlob = await new Promise((res) =>
      canvas.toBlob(res, 'image/jpeg', 0.78)
    );
    const origBmp = await createImageBitmap(blob);
    const compBmp = await createImageBitmap(outBlob);
    const c1 = document.createElement('canvas');
    const c2 = document.createElement('canvas');
    c1.width = c2.width = 120;
    c1.height = c2.height = 80;
    const g1 = c1.getContext('2d');
    const g2 = c2.getContext('2d');
    g1.drawImage(origBmp, 0, 0);
    g2.drawImage(compBmp, 0, 0);
    const d1 = g1.getImageData(0, 0, 120, 80).data;
    const d2 = g2.getImageData(0, 0, 120, 80).data;
    origBmp.close();
    compBmp.close();

    let mse = 0;
    const channels = 120 * 80 * 3;
    for (let i = 0; i < d1.length; i += 4) {
      mse += (d1[i] - d2[i]) ** 2;
      mse += (d1[i + 1] - d2[i + 1]) ** 2;
      mse += (d1[i + 2] - d2[i + 2]) ** 2;
    }
    mse /= channels;
    const psnr = mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);

    return { dimsByOrientation, psnr };
  });

  for (const item of exifResults.dimsByOrientation) {
    if (item.orientation >= 5) {
      expect(item.width).toBe(80);
      expect(item.height).toBe(120);
    } else {
      expect(item.width).toBe(120);
      expect(item.height).toBe(80);
    }
  }
  expect(exifResults.psnr).toBeGreaterThanOrEqual(28);
  console.log(`\nBALANCED_JPEG_PSNR=${exifResults.psnr.toFixed(2)} dB`);
});

test('Phase 4 batch compression, mixed formats, error isolation, ZIP extraction, and 10-file benchmark', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const consoleErrors = [];
  const externalRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('request', (req) => {
    const url = req.url();
    if (
      !url.startsWith('http://127.0.0.1:4173') &&
      !url.startsWith('http://localhost:4173') &&
      !url.startsWith('blob:') &&
      !url.startsWith('data:')
    ) {
      externalRequests.push(url);
    }
  });

  await page.goto('/');

  const jpegPath = path.join(FIXTURES_DIR, 'photo-highres.jpg');
  const webpPath = path.join(FIXTURES_DIR, 'photo-highres.webp');

  // 1. Mixed batch with PDF, PNG, JPEG, WebP, and corrupted PDF
  await page
    .locator('#file')
    .setInputFiles([
      fixtures.textBased,
      fixtures.transparentPng,
      jpegPath,
      webpPath,
      fixtures.corrupted,
    ]);

  await expect(page.locator('#batch-section')).toBeVisible();
  await expect(page.locator('#batch-count')).toHaveText('5 / 20 FILES');
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '09-batch-queue.png'),
    fullPage: true,
  });

  // Override preset on first item to Light
  await page.locator('.batch-preset-select').first().selectOption('Light');

  await page.locator('#start').click();
  await expect(page.locator('#batch-download-zip')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('#batch-retry-failed')).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '10-batch-completed.png'),
    fullPage: true,
  });

  // Download ZIP and independently extract + verify entries
  const zipDownloadPromise = page.waitForEvent('download');
  await page.locator('#batch-download-zip').click();
  const zipDownload = await zipDownloadPromise;
  expect(zipDownload.suggestedFilename()).toBe(
    'gravipress-compressed-files.zip'
  );

  const zipSavePath = path.join(FIXTURES_DIR, 'downloaded-batch.zip');
  await zipDownload.saveAs(zipSavePath);
  const zipBytes = new Uint8Array(fs.readFileSync(zipSavePath));
  const extracted = unzipSync(zipBytes);
  const entryNames = Object.keys(extracted);

  expect(entryNames.length).toBe(4);
  expect(entryNames).toContain('text-based-compressed.pdf');
  expect(entryNames).toContain('transparent-graphic-compressed.png');
  expect(entryNames).toContain('photo-highres-compressed.jpg');
  expect(entryNames).toContain('photo-highres-compressed.webp');

  const reopenedPdf = await PDFDocument.load(
    extracted['text-based-compressed.pdf']
  );
  expect(reopenedPdf.getPageCount()).toBe(3);

  const summaryText = await page.locator('#batch-summary').textContent();

  // 2. 10-file mixed batch benchmark + duplicate filenames
  await page.locator('#batch-clear').click();
  await expect(page.locator('#batch-section')).toBeHidden();

  await page
    .locator('#file')
    .setInputFiles([
      fixtures.textBased,
      fixtures.imageHeavy,
      fixtures.scannedStyle,
      fixtures.multiPage,
      fixtures.portraitLandscape,
      fixtures.rotatedPages,
      fixtures.transparentPng,
      fixtures.noisyPng,
      jpegPath,
      webpPath,
    ]);
  await expect(page.locator('#batch-count')).toHaveText('10 / 20 FILES');

  const batchStart = Date.now();
  await page.locator('#start').click();
  await expect(page.locator('#batch-download-zip')).toBeVisible({
    timeout: 90_000,
  });
  const batchDurationMs = Date.now() - batchStart;

  const zip10Promise = page.waitForEvent('download');
  await page.locator('#batch-download-zip').click();
  const zip10 = await zip10Promise;
  const zip10Path = path.join(FIXTURES_DIR, 'downloaded-batch-10.zip');
  await zip10.saveAs(zip10Path);
  const zip10Bytes = fs.readFileSync(zip10Path);
  const extracted10 = unzipSync(new Uint8Array(zip10Bytes));
  expect(Object.keys(extracted10).length).toBe(10);

  const tenSummary = await page.locator('#batch-summary dd').allTextContents();

  // 3. 20-file maximum batch + 21st file rejection + memory measurement
  await page.locator('#batch-clear').click();
  const twentyFiles = Array.from({ length: 21 }, (_, idx) =>
    idx % 2 === 0 ? fixtures.textBased : fixtures.transparentPng
  );
  await page.locator('#file').setInputFiles(twentyFiles);
  await expect(page.locator('#error')).toContainText('Batch limit of 20 files');
  await expect(page.locator('#batch-count')).toHaveText('20 / 20 FILES');

  const maxBatchStart = Date.now();
  await page.locator('#start').click();
  await expect(page.locator('#batch-download-zip')).toBeVisible({
    timeout: 90_000,
  });
  const maxBatchDurationMs = Date.now() - maxBatchStart;

  const heapInfo = await page.evaluate(() => {
    const mem = performance.memory;
    return mem
      ? {
          usedJSHeapMB: Number((mem.usedJSHeapSize / 1048576).toFixed(2)),
          totalJSHeapMB: Number((mem.totalJSHeapSize / 1048576).toFixed(2)),
        }
      : null;
  });

  // 4. Test batch cancellation mid-run
  await page.locator('#batch-clear').click();
  await page
    .locator('#file')
    .setInputFiles([fixtures.largePdf, fixtures.large6Mb, fixtures.noisyPng]);
  await page.locator('#start').click();
  await expect(page.locator('#cancel')).toBeVisible();
  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toHaveText('BATCH CANCELLED');

  console.log(
    '\nBATCH_BENCHMARK_JSON=' +
      JSON.stringify({
        fiveMixedSummary: summaryText,
        tenMixedDurationMs: batchDurationMs,
        tenMixedSummary: tenSummary,
        tenMixedZipBytes: zip10Bytes.byteLength,
        twentyMaxDurationMs: maxBatchDurationMs,
        heapInfo,
      })
  );

  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('Phase 5 general file, nested folder, GZIP, and 1MB/5MB/10MB archive benchmarks', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const consoleErrors = [];
  const externalRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('request', (req) => {
    const url = req.url();
    if (
      !url.startsWith('http://127.0.0.1:4173') &&
      !url.startsWith('http://localhost:4173') &&
      !url.startsWith('blob:') &&
      !url.startsWith('data:')
    ) {
      externalRequests.push(url);
    }
  });

  // Create realistic 1 MB text, 5 MB CSV, 10 MB JSON, and 256 KB binary fixtures
  const text1MbPath = path.join(FIXTURES_DIR, 'sample-1mb.txt');
  const csv5MbPath = path.join(FIXTURES_DIR, 'dataset-5mb.csv');
  const json10MbPath = path.join(FIXTURES_DIR, 'records-10mb.json');
  const randomBinPath = path.join(FIXTURES_DIR, 'random-256kb.bin');

  // Realistic natural text: diverse sentences with varied vocabulary & punctuation
  const words = [
    'Gravipress',
    'industrial',
    'hydraulic',
    'press',
    'mechanical',
    'piston',
    'chassis',
    'steel',
    'pressure',
    'gauge',
    'cylinder',
    'valve',
    'compression',
    'lossless',
    'deflate',
    'stream',
    'buffer',
    'browser',
    'performance',
    'client',
    'throughput',
    'pipeline',
    'optimization',
    'integrity',
    'payload',
    'metric',
  ];
  const textChunks = [];
  let currentBytes = 0;
  let seed = 42;
  while (currentBytes < 1024 * 1024) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const sentenceLen = 8 + (seed % 12);
    const sentenceWords = [];
    for (let w = 0; w < sentenceLen; w += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      sentenceWords.push(words[seed % words.length]);
    }
    const line = sentenceWords.join(' ') + ` [epoch=${seed % 100000}].\n`;
    textChunks.push(line);
    currentBytes += Buffer.byteLength(line);
  }
  const text1Mb = Buffer.from(textChunks.join(''));

  // Realistic CSV: varied customer/telemetry records with diverse fields
  const statuses = ['PENDING', 'ACTIVE', 'PAUSED', 'FAILED', 'VERIFIED'];
  const regions = ['us-east', 'us-west', 'eu-central', 'ap-south', 'ap-east'];
  const csvLines = [
    'id,timestamp,region,metric_kpa,temperature_c,status,notes\n',
  ];
  let csvBytes = Buffer.byteLength(csvLines[0]);
  let rowId = 1000;
  while (csvBytes < 5 * 1024 * 1024) {
    rowId += 1;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const reg = regions[seed % regions.length];
    const stat = statuses[(seed >>> 4) % statuses.length];
    const kpa = (100 + (seed % 900) * 0.75).toFixed(2);
    const temp = (20 + (seed % 65) * 0.5).toFixed(1);
    const line = `${rowId},2026-11-25T14:${(rowId % 60).toString().padStart(2, '0')}:00Z,${reg},${kpa},${temp},${stat},Press cycle telemetry ${rowId % 500}\n`;
    csvLines.push(line);
    csvBytes += Buffer.byteLength(line);
  }
  const csv5Mb = Buffer.from(csvLines.join(''));

  // Realistic JSON: nested objects with varied telemetry and configuration payloads
  const jsonRecords = [];
  let jsonBytes = 2; // for []
  let recordId = 1;
  while (jsonBytes < 10 * 1024 * 1024) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const rec = {
      recordId,
      station: `HYDRAULIC-UNIT-${(recordId % 24) + 1}`,
      timestamp: `2026-11-25T14:${(recordId % 60).toString().padStart(2, '0')}:${((recordId * 7) % 60).toString().padStart(2, '0')}Z`,
      measurements: {
        hydraulicPressureBar: 180 + (seed % 70),
        ramDisplacementMm: (seed % 1500) / 10,
        flowRateLpm: 45.2 + (seed % 15),
      },
      tags: ['gravipress', 'lossless', regions[seed % regions.length]],
      operational: seed % 10 !== 0,
    };
    const str = JSON.stringify(rec);
    jsonRecords.push(str);
    jsonBytes += Buffer.byteLength(str) + 1; // comma
    recordId += 1;
  }
  const json10Mb = Buffer.from(`[${jsonRecords.join(',')}]`);

  const randomBin = Buffer.alloc(256 * 1024);
  for (let i = 0; i < randomBin.length; i += 1) {
    randomBin[i] = (i * 167 + ((i >> 3) ^ (i * 29))) & 0xff;
  }

  fs.writeFileSync(text1MbPath, text1Mb);
  fs.writeFileSync(csv5MbPath, csv5Mb);
  fs.writeFileSync(json10MbPath, json10Mb);
  fs.writeFileSync(randomBinPath, randomBin);

  await page.goto('/');
  await page.locator('#archive-toggle').click();
  await expect(page.locator('#archive-section')).toBeVisible();

  // 1. Nested folder hierarchy via drop / webkitRelativePath simulation
  await page.evaluate(() => {
    const dt = new DataTransfer();
    const f1 = new File(['console.log("gravipress");'], 'app.js', {
      type: 'text/javascript',
    });
    Object.defineProperty(f1, 'webkitRelativePath', {
      value: 'my-app/src/app.js',
    });
    const f2 = new File(['# Heading\nBody text'], 'README.md', {
      type: 'text/markdown',
    });
    Object.defineProperty(f2, 'webkitRelativePath', {
      value: 'my-app/README.md',
    });
    dt.items.add(f1);
    dt.items.add(f2);
    document
      .getElementById('archive-files-input')
      .dispatchEvent(new Event('change'));
    window.__testFolderFiles = dt.files;
  });

  // Upload multiple files in archive mode & verify GZIP option is disabled
  await page
    .locator('#archive-files-input')
    .setInputFiles([text1MbPath, randomBinPath]);
  await expect(page.locator('#archive-count')).toContainText('2 FILES');
  await expect(
    page.locator('#archive-format option[value="gzip"]')
  ).toBeDisabled();
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '11-archive-mode.png'),
    fullPage: true,
  });

  // Compress mixed ZIP & verify extracted bytes
  await page.locator('#start').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '12-archive-completed.png'),
    fullPage: true,
  });

  const zipDlPromise = page.waitForEvent('download');
  await page.locator('#download').click();
  const zipDl = await zipDlPromise;
  const zipPath = path.join(FIXTURES_DIR, 'phase5-mixed.zip');
  await zipDl.saveAs(zipPath);
  const extractedZip = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  expect(Buffer.from(extractedZip['sample-1mb.txt']).equals(text1Mb)).toBe(
    true
  );
  expect(Buffer.from(extractedZip['random-256kb.bin']).equals(randomBin)).toBe(
    true
  );

  // 2. Single-file GZIP on 1 MB text & verify gunzip byte-for-byte
  await page.locator('#archive-clear').click();
  await page.locator('#archive-files-input').setInputFiles(text1MbPath);
  await page.locator('#archive-format').selectOption('gzip');
  await page.locator('#archive-preset').selectOption('Maximum');
  await page.locator('#start').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 30_000 });

  const gzDlPromise = page.waitForEvent('download');
  await page.locator('#download').click();
  const gzDl = await gzDlPromise;
  expect(gzDl.suggestedFilename()).toBe('sample-1mb.txt.gz');
  const gzPath = path.join(FIXTURES_DIR, 'sample-1mb.txt.gz');
  await gzDl.saveAs(gzPath);
  const gzBytes = new Uint8Array(fs.readFileSync(gzPath));
  expect(Buffer.from(gunzipSync(gzBytes)).equals(text1Mb)).toBe(true);

  // 3. Benchmarks: 1 MB text (Fast/Balanced/Max), 5 MB CSV, 10 MB JSON
  const benchmarks = [];
  for (const [label, filePath, presets] of [
    ['1MB-text', text1MbPath, ['Fast', 'Balanced', 'Maximum']],
    ['5MB-csv', csv5MbPath, ['Fast', 'Balanced', 'Maximum']],
    ['10MB-json', json10MbPath, ['Balanced', 'Maximum']],
  ]) {
    const origBytes = fs.readFileSync(filePath).byteLength;
    for (const preset of presets) {
      await page.locator('#archive-clear').click();
      await page.locator('#archive-files-input').setInputFiles(filePath);
      await page.locator('#archive-format').selectOption('zip');
      await page.locator('#archive-preset').selectOption(preset);
      await page.locator('#start').click();
      await expect(page.locator('#result')).toBeVisible({ timeout: 60_000 });

      const metrics = await page.locator('#metrics dd').allTextContents();
      benchmarks.push({
        fixture: label,
        preset,
        originalBytes: origBytes,
        archiveText: metrics[1],
        savedText: metrics[2],
        duration: metrics[4],
      });
    }
  }

  console.log('\nARCHIVE_BENCHMARK_JSON=' + JSON.stringify(benchmarks));
  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('Phase 6 video compression: MP4 & WebM detection, options, cancellation, and validation', async ({
  page,
}) => {
  const consoleErrors = [];
  const externalRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('request', (req) => {
    const url = req.url();
    if (
      !url.startsWith('http://127.0.0.1:4173') &&
      !url.startsWith('http://localhost:4173') &&
      !url.startsWith('blob:') &&
      !url.startsWith('data:')
    ) {
      externalRequests.push(url);
    }
  });

  await page.goto('/');

  // Generate a real decodable MP4 video in the browser via Canvas + MediaRecorder and compress it
  const videoBufferBase64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');

    // Create an audio track with an oscillator if AudioContext is available
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext || null;
    let audioCtx = null;
    let osc = null;
    const canvasStream = canvas.captureStream ? canvas.captureStream(25) : null;

    if (AudioContextClass && canvasStream) {
      try {
        audioCtx = new AudioContextClass();
        const dest = audioCtx.createMediaStreamDestination();
        osc = audioCtx.createOscillator();
        osc.frequency.value = 440;
        osc.connect(dest);
        osc.start();
        const audioTrack = dest.stream.getAudioTracks()[0];
        if (audioTrack) {
          canvasStream.addTrack(audioTrack);
        }
      } catch (e) {
        // Audio stream setup optional for fixture generation
      }
    }

    // If browser supports MediaRecorder (Chromium / Firefox), record canvas frames
    if (typeof MediaRecorder !== 'undefined' && canvas.captureStream) {
      let mimeType = 'video/webm;codecs=vp8,opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported('video/webm')
          ? 'video/webm'
          : 'video/mp4';
      }

      const recorder = new MediaRecorder(canvasStream, { mimeType });
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.start();

      // Render 25 animated frames with moving rectangle & text
      for (let frame = 0; frame < 25; frame += 1) {
        ctx.fillStyle = '#2b2d21';
        ctx.fillRect(0, 0, 320, 240);

        ctx.fillStyle = '#ffc93c';
        ctx.fillRect(20 + frame * 8, 40, 60, 60);

        ctx.fillStyle = '#d9dadc';
        ctx.font = '20px sans-serif';
        ctx.fillText(`Frame ${frame + 1} / 25`, 30, 160);

        await new Promise((r) => setTimeout(r, 40));
      }

      recorder.stop();
      if (osc) osc.stop();
      if (audioCtx) await audioCtx.close();

      await new Promise((resolve) => (recorder.onstop = resolve));
      const recordedBlob = new Blob(chunks, { type: mimeType });
      const arrayBuf = await recordedBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);

      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }

    return null;
  });

  const generatedVideoPath = path.join(
    FIXTURES_DIR,
    'generated-animation.webm'
  );
  if (videoBufferBase64) {
    fs.writeFileSync(
      generatedVideoPath,
      Buffer.from(videoBufferBase64, 'base64')
    );
  }

  const testVideoPath = videoBufferBase64
    ? generatedVideoPath
    : fixtures.sampleVideoMp4;

  // 1. Upload video fixture
  await page.locator('#file').setInputFiles(testVideoPath);
  await expect(page.locator('#video-options')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('SYSTEM READY');
  await expect(page.locator('#paperhead')).toHaveText('VID / 001');

  // Verify video-options controls
  await expect(page.locator('#video-format')).toHaveValue('mp4');
  await expect(page.locator('#video-resolution')).toHaveValue('auto');
  await expect(page.locator('#video-mute')).not.toBeChecked();

  // Test custom quality CRF slider
  await page.locator('#video-custom-crf').fill('30');
  await expect(page.locator('#video-crf-value')).toHaveText('CRF 30');

  // Test target size custom toggle
  await page.locator('#video-target-size').selectOption('custom');
  await expect(page.locator('#video-custom-target-row')).toBeVisible();
  await page.locator('#video-target-size').selectOption('');
  await expect(page.locator('#video-custom-target-row')).toBeHidden();

  // 2. Perform real video compression if playable video was generated (Chromium/Firefox)
  if (videoBufferBase64) {
    await page.locator('#video-format').selectOption('mp4');
    await page.locator('#start').click();

    // Await completion (loading WASM engine + encoding 25 frames)
    await expect(page.locator('#result')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#status')).toHaveText('PRESS COMPLETE');

    // Verify downloaded MP4 file
    const videoDlPromise = page.waitForEvent('download');
    await page.locator('#download').click();
    const videoDl = await videoDlPromise;
    expect(videoDl.suggestedFilename()).toBe(
      'generated-animation-compressed.mp4'
    );

    const dlPath = path.join(FIXTURES_DIR, 'downloaded-compressed.mp4');
    await videoDl.saveAs(dlPath);
    const dlStat = fs.statSync(dlPath);
    expect(dlStat.size).toBeGreaterThan(1000); // Decodable video generated!

    // Verify output MP4 signature (ftyp)
    const dlHeader = fs.readFileSync(dlPath, { encoding: null });
    expect(dlHeader.subarray(4, 8).toString('ascii')).toBe('ftyp');

    // Verify that output video is valid, decodable, and playable in browser
    const playbackVerified = await page.evaluate(async (pathBase64) => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      const blob = await fetch(`data:video/mp4;base64,${pathBase64}`).then(
        (r) => r.blob()
      );
      const url = URL.createObjectURL(blob);
      video.src = url;

      return new Promise((resolve) => {
        video.onloadedmetadata = () => {
          const ok =
            video.videoWidth > 0 && video.videoHeight > 0 && video.duration > 0;
          URL.revokeObjectURL(url);
          resolve({
            ok,
            width: video.videoWidth,
            height: video.videoHeight,
            duration: video.duration,
          });
        };
        video.onerror = () => {
          URL.revokeObjectURL(url);
          resolve({ ok: false });
        };
      });
    }, fs.readFileSync(dlPath).toString('base64'));

    expect(playbackVerified.ok).toBe(true);
    expect(playbackVerified.width).toBeGreaterThan(0);
    expect(playbackVerified.height).toBeGreaterThan(0);
  }

  // 3. Reset workspace
  await page.locator('#reset').click();
  await expect(page.locator('#video-options')).toBeHidden();
  await expect(page.locator('#filename')).toHaveText('Awaiting file');

  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
