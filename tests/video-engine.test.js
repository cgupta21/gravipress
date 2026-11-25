import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VIDEO_CONTAINER_FORMATS,
  VIDEO_LIMITS,
  VIDEO_PRESETS,
} from '../src/config/video-presets.js';
import {
  buildCompressedVideoFilename,
  computeScaledDimensions,
  detectVideoFormat,
  estimateVideoBitrateKbps,
  validateVideoLimits,
} from '../src/utils/video-utils.js';

test('video-presets defines expected presets and format metadata', () => {
  assert.equal(VIDEO_PRESETS.Light.crf, 23);
  assert.equal(VIDEO_PRESETS.Balanced.crf, 28);
  assert.equal(VIDEO_PRESETS.Maximum.crf, 32);
  assert.equal(VIDEO_PRESETS.Balanced.maxDimension, 720);
  assert.equal(VIDEO_PRESETS.Maximum.maxDimension, 480);

  assert.equal(VIDEO_CONTAINER_FORMATS.mp4.extension, '.mp4');
  assert.equal(VIDEO_CONTAINER_FORMATS.webm.extension, '.webm');
});

test('detectVideoFormat detects MP4 and WebM magic bytes', () => {
  // Matroska / WebM
  const webmHeader = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x77, 0x65, 0x62, 0x6d,
  ]);
  assert.equal(detectVideoFormat(webmHeader), 'webm');

  // MP4 standard ftyp
  const mp4Header = new Uint8Array([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  assert.equal(detectVideoFormat(mp4Header), 'mp4');

  // Unsupported or empty
  assert.equal(detectVideoFormat(new Uint8Array([1, 2, 3])), null);
  assert.equal(detectVideoFormat(null), null);
});

test('computeScaledDimensions preserves aspect ratio and guarantees even numbers', () => {
  const fhd = computeScaledDimensions(1920, 1080, 720);
  assert.equal(fhd.height, 720);
  assert.equal(fhd.width, 1280);
  assert.equal(fhd.width % 2, 0);
  assert.equal(fhd.height % 2, 0);

  // Portrait video: 1080x1920 scaled to 480 short side -> 480 width x 852 height
  const portrait = computeScaledDimensions(1080, 1920, 480);
  assert.equal(portrait.width, 480);
  assert.equal(portrait.height, 852);
  assert.equal(portrait.width % 2, 0);
  assert.equal(portrait.height % 2, 0);

  // Odd input dimension
  const odd = computeScaledDimensions(853, 481, null);
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
});

test('validateVideoLimits enforces size, duration, and pixel limits', () => {
  assert.doesNotThrow(() =>
    validateVideoLimits(
      { duration: 15, width: 1280, height: 720 },
      10 * 1024 * 1024
    )
  );

  // Exceeds max file size
  assert.throws(
    () =>
      validateVideoLimits(
        { duration: 10, width: 640, height: 480 },
        VIDEO_LIMITS.maxFileSizeBytes + 1000
      ),
    /maximum file size limit/i
  );

  // Exceeds max duration
  assert.throws(
    () =>
      validateVideoLimits(
        {
          duration: VIDEO_LIMITS.maxDurationSeconds + 1,
          width: 640,
          height: 480,
        },
        1024
      ),
    /duration.*exceeds maximum limit/i
  );

  // Exceeds 1080p frame resolution
  assert.throws(
    () => validateVideoLimits({ duration: 5, width: 3840, height: 2160 }, 1024),
    /frame resolution.*exceeds/i
  );
});

test('estimateVideoBitrateKbps computes bounded bitrates and filenames', () => {
  const bitrate = estimateVideoBitrateKbps(5 * 1024 * 1024, 10, 96, 'mp4');
  assert.ok(bitrate > 100);

  assert.equal(
    buildCompressedVideoFilename('clip.mp4', 'mp4'),
    'clip-compressed.mp4'
  );
  assert.equal(
    buildCompressedVideoFilename('clip.mov', 'webm'),
    'clip-compressed.webm'
  );
});
