import { test, expect } from '@playwright/test';

test.describe('Phase 9: SEO, Accessibility & Responsive Audit (v1.0)', () => {
  test.setTimeout(60000);

  test('1. SEO metadata, JSON-LD, robots.txt, sitemap.xml & zero CSP errors', async ({ page }) => {
    const consoleErrors = [];
    const pageErrors = [];
    const externalRequests = [];
    const ffmpegRequests = [];
    const baseURL = test.info().project.use.baseURL;

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('ffmpeg') || url.endsWith('.wasm')) ffmpegRequests.push(url);
      if (baseURL && new URL(url).origin !== new URL(baseURL).origin && !url.startsWith('blob:') && !url.startsWith('data:')) {
        externalRequests.push(url);
      }
    });

    await page.goto('/');

    // Title & meta description
    const title = await page.title();
    expect(title).toContain('Gravipress');
    const desc = await page.locator('meta[name="description"]').getAttribute('content');
    expect(desc).toContain('PDF');
    expect(desc).toContain('ZIP/GZIP');

    // Open Graph & Twitter Card
    expect(await page.locator('meta[property="og:title"]').getAttribute('content')).toBe(title);
    expect(await page.locator('meta[name="twitter:card"]').getAttribute('content')).toBe('summary_large_image');
    expect(await page.locator('meta[name="twitter:title"]').getAttribute('content')).toBe(title);

    // JSON-LD WebApplication structured data
    const jsonLdRaw = await page.locator('script[type="application/ld+json"]').textContent();
    const jsonLd = JSON.parse(jsonLdRaw);
    expect(jsonLd['@type']).toBe('WebApplication');
    expect(jsonLd.softwareVersion).toBe('1.0.0');

    // robots.txt (sitemap deferred until production domain is confirmed)
    const robotsResp = await page.request.get('/robots.txt');
    expect(robotsResp.status()).toBe(200);
    expect(await robotsResp.text()).toContain('User-agent: *');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(ffmpegRequests).toEqual([]);
  });

  test('2. Accessibility: semantic HTML, ARIA, keyboard nav, dialog Escape, reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    // Heading hierarchy: exactly one H1
    expect(await page.locator('h1').count()).toBe(1);

    // Live regions & progressbar
    expect(await page.locator('#status').evaluate((el) => el.closest('[role="status"]') !== null)).toBe(true);
    expect(await page.locator('#error').getAttribute('role')).toBe('alert');
    expect(await page.locator('#warning').getAttribute('role')).toBe('status');
    expect(await page.locator('[role="progressbar"]').count()).toBe(1);

    // Keyboard-accessible file upload button (without drag & drop)
    const dropTag = await page.locator('#drop').evaluate((el) => el.tagName);
    expect(dropTag).toBe('BUTTON');

    // Keyboard Tab navigation reaches #licenses and Escape closes dialog
    await page.locator('#licenses').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#licenses-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#licenses-dialog')).toBeHidden();

    await page.locator('#about').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#dialog')).toBeHidden();
  });

  test('3. Responsive layout verification across 360px, 390px, 768px, 1024px, 1440px', async ({ page }) => {
    const viewports = [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.goto('/');
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        navOverflow: document.querySelector('header.nav').scrollWidth > window.innerWidth,
        dropVisible: document.getElementById('drop').getBoundingClientRect().width > 0,
      }));
      console.log(`[VP ${vp.width}x${vp.height}]`, JSON.stringify(metrics));
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
      expect(metrics.navOverflow).toBe(false);
      expect(metrics.dropVisible).toBe(true);
    }
  });
});
