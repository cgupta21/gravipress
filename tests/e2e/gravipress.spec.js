import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
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
