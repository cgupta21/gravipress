import assert from 'node:assert/strict';
import test from 'node:test';
import UPNG from 'upng-js';

import {
  IMAGE_FORMAT_META,
  IMAGE_LIMITS,
  IMAGE_PRESETS,
} from '../src/config/image-presets.js';
import {
  calculateSavings,
  formatPercentageReduction,
} from '../src/utils/file-utils.js';
import {
  buildCompressedImageFilename,
  computeScaledDimensions,
  detectImageFormat,
  hasAlphaChannel,
  isAnimatedImage,
  readHeaderDimensions,
  validateImageSignatureAndLimits,
} from '../src/utils/image-utils.js';

test('image presets and format metadata define expected defaults', () => {
  assert.equal(IMAGE_PRESETS.Light.lossyQuality, 0.9);
  assert.equal(IMAGE_PRESETS.Light.pngColors, 0);
  assert.equal(IMAGE_PRESETS.Balanced.lossyQuality, 0.78);
  assert.equal(IMAGE_PRESETS.Maximum.lossyQuality, 0.55);

  assert.equal(IMAGE_FORMAT_META.PNG.supportsQuality, false);
  assert.equal(IMAGE_FORMAT_META.JPEG.supportsQuality, true);
  assert.equal(IMAGE_FORMAT_META.WEBP.supportsQuality, true);
  assert.equal(IMAGE_FORMAT_META.AVIF.supportsQuality, true);
});

test('detectImageFormat identifies JPEG, PNG, WebP, AVIF, and GIF by magic bytes', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  const webp = new TextEncoder().encode('RIFF\x00\x00\x00\x00WEBPVP8 ');
  const avif = new TextEncoder().encode(
    '\x00\x00\x00\x1cftypavif\x00\x00\x00\x00'
  );
  const gif = new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00');

  assert.equal(detectImageFormat(jpeg), 'JPEG');
  assert.equal(detectImageFormat(png), 'PNG');
  assert.equal(detectImageFormat(webp), 'WEBP');
  assert.equal(detectImageFormat(avif), 'AVIF');
  assert.equal(detectImageFormat(gif), 'GIF');
  assert.equal(
    detectImageFormat(new TextEncoder().encode('plain text file')),
    null
  );
});

test('isAnimatedImage detects APNG, animated WebP, and animated AVIF', () => {
  // APNG: PNG signature + IHDR (13 bytes) + acTL chunk
  const apng = new Uint8Array(8 + 25 + 12);
  apng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  apng.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  apng.set([0, 0, 0, 0, 0x61, 0x63, 0x54, 0x4c], 8 + 25);
  assert.equal(isAnimatedImage(apng, 'PNG'), true);

  // Animated WebP with VP8X animation flag (bit 1)
  const animWebp = new TextEncoder().encode(
    'RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x02\x00\x00\x00'
  );
  assert.equal(isAnimatedImage(animWebp, 'WEBP'), true);

  // Animated AVIF brand 'avis'
  const animAvif = new TextEncoder().encode(
    '\x00\x00\x00\x1cftypavis\x00\x00\x00\x00'
  );
  assert.equal(isAnimatedImage(animAvif, 'AVIF'), true);
});

test('validateImageSignatureAndLimits rejects bombs, empty files, and animated images', () => {
  const empty = new Uint8Array(0);
  assert.equal(
    validateImageSignatureAndLimits({ name: 'empty.png', size: 0 }, empty)
      .valid,
    false
  );

  // PNG IHDR claiming 50000 x 50000 pixels (decompression bomb)
  const bombPng = new Uint8Array(24);
  bombPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bombPng.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bombPng.buffer);
  view.setUint32(16, 50000, false);
  view.setUint32(20, 50000, false);

  const dims = readHeaderDimensions(bombPng, 'PNG');
  assert.deepEqual(dims, { width: 50000, height: 50000 });
  const bombCheck = validateImageSignatureAndLimits(
    { name: 'bomb.png', size: bombPng.length },
    bombPng
  );
  assert.equal(bombCheck.valid, false);
  assert.ok(bombCheck.error.includes('exceed safe'));
  assert.ok(IMAGE_LIMITS.maxDecodedPixels < 50000 * 50000);
});

test('computeScaledDimensions preserves aspect ratio and buildCompressedImageFilename formats names', () => {
  assert.deepEqual(computeScaledDimensions(4000, 2000, 1000), {
    width: 1000,
    height: 500,
    resized: true,
  });
  assert.deepEqual(computeScaledDimensions(800, 600, 1000), {
    width: 800,
    height: 600,
    resized: false,
  });

  assert.equal(
    buildCompressedImageFilename('photo.jpeg', 'jpg'),
    'photo-compressed.jpg'
  );
  assert.equal(
    buildCompressedImageFilename('logo.png', 'png'),
    'logo-compressed.png'
  );
});

test('UPNG lossless and quantized encoding preserves PNG transparency', () => {
  const width = 32;
  const height = 32;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = (i * 7) % 256;
    rgba[i * 4 + 1] = (i * 13) % 256;
    rgba[i * 4 + 2] = (i * 19) % 256;
    rgba[i * 4 + 3] = i < (width * height) / 2 ? 0 : 255;
  }

  assert.equal(hasAlphaChannel(rgba), true);

  const lossless = new Uint8Array(UPNG.encode([rgba.buffer], width, height, 0));
  const quantized = new Uint8Array(
    UPNG.encode([rgba.buffer], width, height, 128)
  );

  assert.equal(detectImageFormat(lossless), 'PNG');
  assert.equal(detectImageFormat(quantized), 'PNG');

  const decoded = UPNG.decode(quantized.buffer);
  const decodedRgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(hasAlphaChannel(decodedRgba), true);
});

test('UPNG lossless mode (cnum=0) is pixel-for-pixel identical on transparent graphics and partial-alpha gradients', () => {
  const width = 120;
  const height = 80;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const inBox = x > 20 && x < 100 && y > 15 && y < 65;
      rgba[idx] = inBox ? 255 : Math.round((x / width) * 255);
      rgba[idx + 1] = inBox ? 201 : Math.round((y / height) * 255);
      rgba[idx + 2] = inBox ? 60 : 45;
      // Include 0, partial (1..254), and 255 alpha values
      rgba[idx + 3] = inBox ? 255 : Math.round((x / width) * 254);
    }
  }

  const encoded = new Uint8Array(UPNG.encode([rgba.buffer], width, height, 0));
  const decoded = UPNG.decode(encoded.buffer);
  const decodedRgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);

  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(decodedRgba.length, rgba.length);

  let maxChannelDiff = 0;
  for (let i = 0; i < rgba.length; i += 1) {
    // When alpha === 0, RGB values are invisible; UPNG lossless preserves all non-zero alpha pixels identically
    const alpha = rgba[i - (i % 4) + 3];
    if (alpha > 0 || i % 4 === 3) {
      const diff = Math.abs(decodedRgba[i] - rgba[i]);
      if (diff > maxChannelDiff) {
        maxChannelDiff = diff;
      }
    }
  }
  assert.equal(maxChannelDiff, 0);
});

test('formatPercentageReduction never reports 100% for non-empty output and WebP VP8X bomb is rejected', () => {
  const savings = calculateSavings(480433, 165);
  const pctText = formatPercentageReduction(savings.percentage, 480433, 165);
  assert.equal(pctText, '99.97%');
  assert.notEqual(pctText, '100.0%');
  assert.equal(formatPercentageReduction(0, 100, 100), '0.0%');

  // WebP VP8X claiming 10000 x 10000 (> 8192 maxDimensionPx)
  const webpBomb = new Uint8Array(30);
  webpBomb.set(new TextEncoder().encode('RIFF\x00\x00\x00\x00WEBPVP8X'), 0);
  webpBomb[24] = 9999 & 0xff;
  webpBomb[25] = (9999 >> 8) & 0xff;
  webpBomb[26] = (9999 >> 16) & 0xff;
  webpBomb[27] = 9999 & 0xff;
  webpBomb[28] = (9999 >> 8) & 0xff;
  webpBomb[29] = (9999 >> 16) & 0xff;

  const dims = readHeaderDimensions(webpBomb, 'WEBP');
  assert.deepEqual(dims, { width: 10000, height: 10000 });
  assert.equal(
    validateImageSignatureAndLimits({ name: 'bomb.webp', size: 30 }, webpBomb)
      .valid,
    false
  );
});
