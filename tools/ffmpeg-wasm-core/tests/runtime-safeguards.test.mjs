/**
 * runtime-safeguards.test.mjs
 * Focused verification tests for custom FFmpeg 5.1.10 WASM engine:
 * 1. Progress reporting units (microseconds, clamped [0.0, 1.0], no premature completion).
 * 2. Suppression of fake 1.0 completion on genuine runtime failures.
 * 3. Actual encoding timeout enforcement (exceeded limit aborts cleanly with non-zero exit code).
 * 4. Repeated multi-operation workflow on same instance (probe -> transcode -> probe -> transcode).
 * 5. Genuine runtime failure reporting (never swallow errors or report fake 0 exit code).
 * 6. Corruption lockout prevention (never reuse corrupted instance).
 * 7. Clean recovery using a fresh WASM core instance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

export function createWavBuffer(durationSeconds = 1, sampleRate = 8000) {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const buffer = Buffer.alloc(44 + numSamples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  // Generate a test tone
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.floor(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

export async function runSafeguardTests(createFFmpegCore, wasmBinary) {
  console.log('--- Starting FFmpeg WASM Safeguard & Lifecycle Tests ---');

  // Test 1: Progress Reporting Accuracy, Monotonicity & Premature Completion Prevention
  await test('Progress events stay within [0.0, 1.0] and report microseconds without premature 1.0', async () => {
    const core = await createFFmpegCore({ wasmBinary });
    const wav = createWavBuffer(2.0, 8000);
    core.FS.writeFile('test_progress.wav', wav);

    const progressEvents = [];
    core.setProgress((p) => {
      progressEvents.push(p);
    });

    const ret = core.exec('-i', 'test_progress.wav', '-c:a', 'libmp3lame', 'test_progress.mp3');
    assert.equal(ret, 0, 'Exec should succeed with exit code 0');

    assert.ok(progressEvents.length > 0, 'At least one progress event must be received');
    for (let i = 0; i < progressEvents.length; i++) {
      const { progress, time } = progressEvents[i];
      assert.ok(typeof progress === 'number' && !isNaN(progress), 'Progress must be a valid number');
      assert.ok(progress >= 0.0 && progress <= 1.0, `Progress ${progress} must be within [0.0, 1.0]`);
      assert.ok(typeof time === 'number' && time >= 0, `Time ${time} must be non-negative microseconds`);

      // All intermediate events must strictly be <= 0.99 (never premature 1.0)
      if (i < progressEvents.length - 1) {
        assert.ok(progress <= 0.99, `Intermediate progress ${progress} must not be 1.0`);
      }
    }

    const finalEvent = progressEvents[progressEvents.length - 1];
    assert.equal(finalEvent.progress, 1.0, 'Final progress must be 1.0');
    assert.ok(finalEvent.time > 0, 'Final media time must be greater than 0');

    core.FS.unlink('test_progress.wav');
    core.FS.unlink('test_progress.mp3');
  });

  // Test 2: Genuine Runtime Failure Reporting & No Fake 1.0
  await test('Genuine runtime failures return non-zero exit code and suppress 1.0 progress', async () => {
    const core = await createFFmpegCore({ wasmBinary });
    const progressEvents = [];
    core.setProgress((p) => {
      progressEvents.push(p);
    });

    // Run invalid command (non-existent input)
    const ret1 = core.exec('-i', 'missing_audio_file.wav', 'out.mp3');
    assert.notEqual(ret1, 0, 'Missing file must return non-zero exit code');

    // Run invalid codec options
    const wav = createWavBuffer(0.5, 8000);
    core.FS.writeFile('test_bad_codec.wav', wav);
    const ret2 = core.exec('-i', 'test_bad_codec.wav', '-c:a', 'non_existent_codec', 'out.mp3');
    assert.notEqual(ret2, 0, 'Invalid codec must return non-zero exit code');
    core.FS.unlink('test_bad_codec.wav');

    const emitted100 = progressEvents.some((p) => p.progress === 1.0);
    assert.equal(emitted100, false, 'Failed execution must never emit 1.0 progress completion');
  });

  // Test 3: Actual Encoding Timeout Enforcement
  await test('Configured timeout halts execution and returns non-zero code on exceeded duration', async () => {
    const core = await createFFmpegCore({ wasmBinary });
    const wav = createWavBuffer(3.0, 8000);
    core.FS.writeFile('test_timeout.wav', wav);

    // Set an ultra-short timeout of 10ms to trigger timeout limit during encoding
    core.setTimeout(10);

    const ret = core.exec('-i', 'test_timeout.wav', '-c:a', 'libmp3lame', '-b:a', '128k', 'out_timeout.mp3');
    assert.notEqual(ret, 0, 'Timed-out execution must return non-zero exit code');

    core.reset();
    assert.equal(core.timeout, -1, 'Reset must restore timeout to -1');

    core.FS.unlink('test_timeout.wav');
    if (core.FS.analyzePath('out_timeout.mp3').exists) {
      core.FS.unlink('out_timeout.mp3');
    }
  });

  // Test 4: Repeated Operations on Same Instance (Re-entrancy & Shadow Stack Stability)
  await test('Repeated ffprobe and ffmpeg operations execute reliably on the same instance', async () => {
    const core = await createFFmpegCore({ wasmBinary });
    const wav = createWavBuffer(1.0, 8000);
    core.FS.writeFile('seq_in.wav', wav);

    const spInitial = typeof core.stackSave === 'function' ? core.stackSave() : 0;

    // Operation 1: FFprobe input WAV
    const probeRet1 = core.ffprobe(
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      '-o', 'probe1.json',
      'seq_in.wav'
    );
    assert.equal(probeRet1, 0, 'Operation 1 (ffprobe) should succeed with code 0');
    assert.ok(core.FS.analyzePath('probe1.json').exists, 'probe1.json must exist');
    const info1 = JSON.parse(core.FS.readFile('probe1.json', { encoding: 'utf8' }));
    assert.ok(info1.streams?.length > 0, 'probe1.json must contain audio stream info');

    // Operation 2: Transcode WAV -> MP3
    const execRet1 = core.exec('-i', 'seq_in.wav', '-c:a', 'libmp3lame', 'seq_mid.mp3');
    assert.equal(execRet1, 0, 'Operation 2 (exec MP3) should succeed with code 0');
    assert.ok(core.FS.analyzePath('seq_mid.mp3').exists, 'seq_mid.mp3 must exist');

    // Operation 3: FFprobe generated MP3
    const probeRet2 = core.ffprobe(
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      '-o', 'probe2.json',
      'seq_mid.mp3'
    );
    assert.equal(probeRet2, 0, 'Operation 3 (ffprobe MP3) should succeed with code 0');
    assert.ok(core.FS.analyzePath('probe2.json').exists, 'probe2.json must exist');

    // Operation 4: Transcode MP3 -> Ogg Vorbis
    const execRet2 = core.exec('-i', 'seq_mid.mp3', '-c:a', 'libvorbis', 'seq_out.ogg');
    assert.equal(execRet2, 0, 'Operation 4 (exec Vorbis) should succeed with code 0');
    assert.ok(core.FS.analyzePath('seq_out.ogg').exists, 'seq_out.ogg must exist');

    if (spInitial > 0) {
      const spFinal = core.stackSave();
      assert.equal(spFinal, spInitial, 'WASM shadow stack pointer must remain stable across repeated operations');
    }

    // Cleanup virtual files
    for (const f of ['seq_in.wav', 'probe1.json', 'seq_mid.mp3', 'probe2.json', 'seq_out.ogg']) {
      if (core.FS.analyzePath(f).exists) core.FS.unlink(f);
    }
  });

  // Test 5: Corruption Prevention on Unexpected Abort
  await test('Unexpected runtime abort flags instance as corrupted and blocks reuse', async () => {
    const core = await createFFmpegCore({ wasmBinary });
    assert.equal(core.isCorrupted(), false, 'Fresh instance must not be corrupted');

    // Simulate unexpected native abort (bypassing clean exit_program)
    core._cleanExit = false;
    core._corrupted = true;

    assert.equal(core.isCorrupted(), true, 'Instance must report corrupted');
    assert.throws(
      () => core.exec('-version'),
      /corrupted state/,
      'Subsequent exec on corrupted instance must throw and refuse execution'
    );
    assert.throws(
      () => core.ffprobe(),
      /corrupted state/,
      'Subsequent ffprobe on corrupted instance must throw and refuse execution'
    );
  });

  // Test 6: Fresh Instance Recovery
  await test('Fresh instance creation restores full functionality after corruption', async () => {
    const freshCore = await createFFmpegCore({ wasmBinary });
    assert.equal(freshCore.isCorrupted(), false, 'New instance must be uncorrupted');
    const ret = freshCore.exec('-version');
    assert.equal(ret, 0, 'Fresh instance should execute normally with code 0');
  });

  console.log('--- All Safeguard Tests Completed Successfully ---');
}
