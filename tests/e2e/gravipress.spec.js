import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
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
  await expect(page.locator('#filename')).toHaveText('Awaiting PDF');
  await expect(page.locator('#image-preview')).toBeHidden();

  // Test error states: empty, renamed non-PDF, corrupted, encrypted, unsupported JPG
  for (const invalidPath of [
    fixtures.empty,
    fixtures.renamedNonPdf,
    fixtures.corrupted,
    fixtures.encrypted,
    fixtures.unsupportedJpg,
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
