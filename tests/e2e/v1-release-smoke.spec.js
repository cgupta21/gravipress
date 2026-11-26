import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { unzipSync, gunzipSync } from 'fflate';

const FIXTURES_DIR = 'C:/CG_PROJECT/gravipress/tests/e2e/.fixtures';
const pdfFixture = path.join(FIXTURES_DIR, 'text-based.pdf');
const jpgFixture = path.join(FIXTURES_DIR, 'photo-highres.jpg');
const corruptedPdfFixture = path.join(FIXTURES_DIR, 'corrupted.pdf');
const text1MbFixture = path.join(FIXTURES_DIR, 'sample-1mb.txt');
const bin256KbFixture = path.join(FIXTURES_DIR, 'random-256kb.bin');

function attachTrackers(page, baseURL) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const externalRequests = [];
  const ffmpegRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.url()} (${req.failure()?.errorText || 'unknown'})`);
  });
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('ffmpeg') || url.endsWith('.wasm')) {
      ffmpegRequests.push(url);
    }
    if (
      baseURL &&
      new URL(url).origin !== new URL(baseURL).origin &&
      !url.startsWith('blob:') &&
      !url.startsWith('data:')
    ) {
      externalRequests.push(url);
    }
  });

  return { consoleErrors, pageErrors, failedRequests, externalRequests, ffmpegRequests };
}

test.describe('Phase 8: Gravipress v1.0 Non-Multimedia Release Smoke', () => {
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#filename')).toHaveText('Awaiting PDF');
    await expect(page.locator('#status')).toHaveText('SYSTEM READY');
  });

  test('1. PDF compression, download validity, and reset', async ({ page }) => {
    const trackers = attachTrackers(page, test.info().project.use.baseURL);

    await page.locator('#file').setInputFiles(pdfFixture);
    await page.locator('#start').click();
    await expect(page.locator('#result')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#status')).toHaveText('PRESS COMPLETE');

    const dlPromise = page.waitForEvent('download');
    await page.locator('#download').click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toContain('.pdf');

    const tmpPdf = path.join(FIXTURES_DIR, 'tmp-v1-out.pdf');
    await dl.saveAs(tmpPdf);
    const buf = fs.readFileSync(tmpPdf);
    fs.unlinkSync(tmpPdf);

    expect(buf.byteLength).toBeGreaterThan(500);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');

    await page.locator('#reset').click();
    await expect(page.locator('#filename')).toHaveText('Awaiting file');
    await expect(page.locator('#result')).toBeHidden();

    expect(trackers.ffmpegRequests).toEqual([]);
    expect(trackers.externalRequests).toEqual([]);
    expect(trackers.consoleErrors).toEqual([]);
    expect(trackers.pageErrors).toEqual([]);
    expect(trackers.failedRequests).toEqual([]);
  });

  test('2. Image compression, download validity, and reset', async ({ page }) => {
    const trackers = attachTrackers(page, test.info().project.use.baseURL);

    await page.locator('#file').setInputFiles(jpgFixture);
    await expect(page.locator('#image-options')).toBeVisible({ timeout: 15000 });
    await page.locator('#start').click();
    await expect(page.locator('#result')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#status')).toHaveText('PRESS COMPLETE');

    const dlPromise = page.waitForEvent('download');
    await page.locator('#download').click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toContain('.jpg');

    const tmpJpg = path.join(FIXTURES_DIR, 'tmp-v1-out.jpg');
    await dl.saveAs(tmpJpg);
    const buf = fs.readFileSync(tmpJpg);
    fs.unlinkSync(tmpJpg);

    expect(buf.byteLength).toBeGreaterThan(1000);
    expect(buf.subarray(0, 3).toString('hex')).toBe('ffd8ff');

    await page.locator('#reset').click();
    await expect(page.locator('#image-options')).toBeHidden();

    expect(trackers.ffmpegRequests).toEqual([]);
    expect(trackers.externalRequests).toEqual([]);
    expect(trackers.consoleErrors).toEqual([]);
    expect(trackers.pageErrors).toEqual([]);
    expect(trackers.failedRequests).toEqual([]);
  });

  test('3. Batch compression, error isolation, and ZIP download', async ({ page }) => {
    const trackers = attachTrackers(page, test.info().project.use.baseURL);

    await page.locator('#file').setInputFiles([pdfFixture, jpgFixture, corruptedPdfFixture]);
    await expect(page.locator('#batch-section')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#batch-count')).toHaveText('3 / 20 FILES');

    await page.locator('#start').click();
    await expect(page.locator('#batch-download-zip')).toBeVisible({ timeout: 45000 });

    const dlPromise = page.waitForEvent('download');
    await page.locator('#batch-download-zip').click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toContain('.zip');

    const tmpZip = path.join(FIXTURES_DIR, 'tmp-v1-batch.zip');
    await dl.saveAs(tmpZip);
    const buf = fs.readFileSync(tmpZip);
    fs.unlinkSync(tmpZip);

    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
    const extracted = unzipSync(new Uint8Array(buf));
    expect(Object.keys(extracted).length).toBe(2);

    expect(trackers.ffmpegRequests).toEqual([]);
    expect(trackers.externalRequests).toEqual([]);
    expect(trackers.consoleErrors).toEqual([]);
    expect(trackers.pageErrors).toEqual([]);
    expect(trackers.failedRequests).toEqual([]);
  });

  test('4. ZIP and GZIP compression with byte-for-byte verification', async ({ page }) => {
    const trackers = attachTrackers(page, test.info().project.use.baseURL);

    await page.locator('#archive-toggle').click();
    await expect(page.locator('#archive-section')).toBeVisible();

    await page.locator('#archive-files-input').setInputFiles([text1MbFixture, bin256KbFixture]);
    await expect(page.locator('#archive-count')).toContainText('2 FILES');
    await page.locator('#start').click();
    await expect(page.locator('#result')).toBeVisible({ timeout: 30000 });

    let dlPromise = page.waitForEvent('download');
    await page.locator('#download').click();
    let dl = await dlPromise;
    expect(dl.suggestedFilename()).toContain('.zip');

    const tmpZip = path.join(FIXTURES_DIR, 'tmp-v1-archive.zip');
    await dl.saveAs(tmpZip);
    const zipBuf = fs.readFileSync(tmpZip);
    fs.unlinkSync(tmpZip);

    const extracted = unzipSync(new Uint8Array(zipBuf));
    expect(Buffer.from(extracted['sample-1mb.txt']).equals(fs.readFileSync(text1MbFixture))).toBe(true);
    expect(Buffer.from(extracted['random-256kb.bin']).equals(fs.readFileSync(bin256KbFixture))).toBe(true);

    await page.locator('#archive-clear').click();
    await page.locator('#archive-files-input').setInputFiles(text1MbFixture);
    await page.locator('#archive-format').selectOption('gzip');
    await page.locator('#start').click();
    await expect(page.locator('#result')).toBeVisible({ timeout: 30000 });

    dlPromise = page.waitForEvent('download');
    await page.locator('#download').click();
    dl = await dlPromise;
    expect(dl.suggestedFilename()).toContain('.gz');

    const tmpGz = path.join(FIXTURES_DIR, 'tmp-v1-archive.gz');
    await dl.saveAs(tmpGz);
    const gzBuf = fs.readFileSync(tmpGz);
    fs.unlinkSync(tmpGz);

    expect(gzBuf.subarray(0, 2).toString('hex')).toBe('1f8b');
    expect(Buffer.from(gunzipSync(new Uint8Array(gzBuf))).equals(fs.readFileSync(text1MbFixture))).toBe(true);

    expect(trackers.ffmpegRequests).toEqual([]);
    expect(trackers.externalRequests).toEqual([]);
    expect(trackers.consoleErrors).toEqual([]);
    expect(trackers.pageErrors).toEqual([]);
    expect(trackers.failedRequests).toEqual([]);
  });

  test('5. Malformed file error handling, reset, Licenses and About dialogs', async ({ page }) => {
    const trackers = attachTrackers(page, test.info().project.use.baseURL);

    // A. Malformed PDF error handling
    await page.locator('#file').setInputFiles(corruptedPdfFixture);
    await expect(page.locator('#warning')).toBeVisible({ timeout: 10000 });
    await page.locator('#reset').click();
    await expect(page.locator('#filename')).toHaveText('Awaiting file');

    // B. Security headers + Licenses dialog & links verification
    const resp = await page.request.get('/');
    const hdrs = resp.headers();
    expect(hdrs['content-security-policy']).toContain("default-src 'self'");
    expect(hdrs['x-content-type-options']).toBe('nosniff');
    expect(hdrs['x-frame-options']).toBe('DENY');
    expect(hdrs['referrer-policy']).toBe('no-referrer');
    expect(hdrs['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');

    await page.locator('#licenses').click();
    await expect(page.locator('#licenses-dialog')).toBeVisible();
    await expect(page.locator('#licenses-dialog')).toContainText('pdf-lib');
    await expect(page.locator('#licenses-dialog')).toContainText('pdfjs-dist');
    await expect(page.locator('#licenses-dialog')).toContainText('fflate');
    await expect(page.locator('#licenses-dialog')).toContainText('upng-js');
    const hrefs = await page.locator('#licenses-dialog a').evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThanOrEqual(6);
    for (const h of hrefs) {
      const lr = await page.request.get(h);
      expect(lr.status()).toBe(200);
      expect((await lr.text()).length).toBeGreaterThan(100);
    }
    await page.locator('#licenses-dialog button.action').click();
    await expect(page.locator('#licenses-dialog')).toBeHidden();

    // C. About dialog
    await page.locator('#about').click();
    await expect(page.locator('#dialog')).toBeVisible();
    await expect(page.locator('#dialog-title')).toHaveText('Less space. More room.');
    await page.locator('#dialog button.action').click();
    await expect(page.locator('#dialog')).toBeHidden();

    expect(trackers.ffmpegRequests).toEqual([]);
    expect(trackers.externalRequests).toEqual([]);
    expect(trackers.consoleErrors).toEqual([]);
    expect(trackers.pageErrors).toEqual([]);
    expect(trackers.failedRequests).toEqual([]);
  });
});
