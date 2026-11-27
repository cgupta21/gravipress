import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  BufferTarget,
  Conversion,
  EncodedPacketSink,
  Input,
  OggOutputFormat,
  Output,
  WavOutputFormat,
  WebMOutputFormat,
} from 'mediabunny';

const LIMITS = {
  maxFileSizeBytes: 100 * 1024 * 1024,
  maxOutputBytes: 100 * 1024 * 1024,
  maxDurationSec: 300,
  maxDimensionPx: 1920,
};

let activeConversion = null;

async function detectCapabilities() {
  const hasWebCodecs =
    typeof VideoDecoder !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioDecoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined';

  const checkVideo = async (codec) => {
    if (!hasWebCodecs) return false;
    try {
      const res = await VideoEncoder.isConfigSupported({
        codec,
        width: 640,
        height: 360,
        bitrate: 500_000,
        framerate: 30,
      });
      return Boolean(res?.supported);
    } catch {
      return false;
    }
  };

  const checkAudio = async (codec) => {
    if (!hasWebCodecs) return false;
    try {
      const res = await AudioEncoder.isConfigSupported({
        codec,
        sampleRate: 48_000,
        numberOfChannels: 2,
        bitrate: 96_000,
      });
      return Boolean(res?.supported);
    } catch {
      return false;
    }
  };

  const [vp8, vp9, opus] = await Promise.all([
    checkVideo('vp8'),
    checkVideo('vp09.00.10.08'),
    checkAudio('opus'),
  ]);

  return { webCodecs: hasWebCodecs, vp8, vp9, opus, wav: true };
}

function validateFile(file) {
  if (!file || typeof file.size !== 'number' || file.size <= 0) {
    throw new Error('Selected media file is empty or invalid.');
  }
  if (file.size > LIMITS.maxFileSizeBytes) {
    throw new Error('Media file exceeds the 100 MB limit.');
  }
}

async function resolveBoundedDuration(input) {
  let duration = 0;
  try {
    duration = await input.computeDuration();
  } catch {
    duration = 0;
  }
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }

  const tracks = [
    ...(await input.getVideoTracks()),
    ...(await input.getAudioTracks()),
  ];
  if (tracks.length === 0) return 0;

  const MAX_PACKETS = 18_000;
  let maxEnd = 0;
  let count = 0;
  const sink = new EncodedPacketSink(tracks[0]);
  for await (const packet of sink.packets()) {
    count += 1;
    if (count > MAX_PACKETS) {
      throw new Error('Media packet count exceeds safe inspection limit.');
    }
    const end = packet.timestamp + (packet.duration || 0);
    if (end > maxEnd) maxEnd = end;
    if (maxEnd > LIMITS.maxDurationSec) {
      throw new Error(`Media duration exceeds ${LIMITS.maxDurationSec}s limit.`);
    }
  }
  return maxEnd;
}

async function validateOutputMedia(bytes) {
  if (!bytes || bytes.byteLength === 0) {
    throw new Error('Generated media output is empty.');
  }
  if (bytes.byteLength > LIMITS.maxOutputBytes) {
    throw new Error('Generated media output exceeds the 100 MB limit.');
  }
  const verifyInput = new Input({
    source: new BufferSource(bytes),
    formats: ALL_FORMATS,
  });
  const duration = await resolveBoundedDuration(verifyInput);
  const videoTracks = await verifyInput.getVideoTracks();
  const audioTracks = await verifyInput.getAudioTracks();
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Generated output has invalid duration.');
  }
  return {
    duration,
    videoTrackCount: videoTracks.length,
    audioTrackCount: audioTracks.length,
  };
}

async function handleVideoCompression(id, file, options = {}) {
  validateFile(file);
  const {
    codec = 'vp9',
    bitrate = 400_000,
    audioBitrate = 64_000,
    maxWidth = 640,
  } = options;

  if (codec !== 'vp8' && codec !== 'vp9') {
    throw new Error(`Unsupported video codec "${codec}". Only VP8 and VP9 WebM are supported.`);
  }

  const caps = await detectCapabilities();
  if (!caps.webCodecs || (codec === 'vp9' && !caps.vp9) || (codec === 'vp8' && !caps.vp8)) {
    throw new Error(`Browser does not support native ${codec.toUpperCase()} WebCodecs encoding.`);
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const duration = await resolveBoundedDuration(input);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Malformed or empty media container.');
  }
  if (duration > LIMITS.maxDurationSec) {
    throw new Error(`Media duration exceeds ${LIMITS.maxDurationSec}s limit.`);
  }

  const videoTracks = await input.getVideoTracks();
  if (videoTracks.length === 0) {
    throw new Error('No video track found in input file.');
  }
  const firstVideo = videoTracks[0];
  if (
    firstVideo.codedWidth > LIMITS.maxDimensionPx ||
    firstVideo.codedHeight > LIMITS.maxDimensionPx
  ) {
    throw new Error(`Input video resolution exceeds ${LIMITS.maxDimensionPx}px limit.`);
  }

  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      codec,
      bitrate,
      width: Math.min(maxWidth, LIMITS.maxDimensionPx),
      fit: 'contain',
    },
    audio: caps.opus ? { codec: 'opus', bitrate: audioBitrate } : { discard: true },
  });

  if (!conversion.isValid) {
    throw new Error('No supported video/audio tracks found for WebM conversion.');
  }

  activeConversion = conversion;
  conversion.onProgress = (progress) => {
    self.postMessage({ type: 'PROGRESS', id, progress });
  };

  try {
    await conversion.execute();
  } finally {
    if (activeConversion === conversion) activeConversion = null;
  }

  const bytes = new Uint8Array(target.buffer);
  const verified = await validateOutputMedia(bytes);

  self.postMessage(
    {
      type: 'RESULT',
      id,
      bytes,
      mimeType: 'video/webm',
      ...verified,
    },
    [bytes.buffer]
  );
}

async function handleAudioCompression(id, file, options = {}) {
  validateFile(file);
  const {
    format = 'opus-webm',
    bitrate = 64_000,
    sampleRate = 48_000,
    numberOfChannels = 2,
  } = options;

  const caps = await detectCapabilities();
  if (format !== 'wav' && (!caps.webCodecs || !caps.opus)) {
    throw new Error('Browser does not support native Opus WebCodecs encoding.');
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const duration = await resolveBoundedDuration(input);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Malformed or empty audio container.');
  }
  if (duration > LIMITS.maxDurationSec) {
    throw new Error(`Audio duration exceeds ${LIMITS.maxDurationSec}s limit.`);
  }

  const target = new BufferTarget();
  const outputFormat =
    format === 'wav'
      ? new WavOutputFormat()
      : format === 'opus-ogg'
        ? new OggOutputFormat()
        : new WebMOutputFormat();

  const output = new Output({ format: outputFormat, target });
  const audioConfig =
    format === 'wav'
      ? { codec: 'pcm-s16', sampleRate, numberOfChannels }
      : { codec: 'opus', bitrate, sampleRate, numberOfChannels };

  const conversion = await Conversion.init({
    input,
    output,
    video: { discard: true },
    audio: audioConfig,
  });

  if (!conversion.isValid) {
    throw new Error('No supported audio track found for conversion.');
  }

  activeConversion = conversion;
  conversion.onProgress = (progress) => {
    self.postMessage({ type: 'PROGRESS', id, progress });
  };

  try {
    await conversion.execute();
  } finally {
    if (activeConversion === conversion) activeConversion = null;
  }

  const bytes = new Uint8Array(target.buffer);
  const verified = await validateOutputMedia(bytes);

  self.postMessage(
    {
      type: 'RESULT',
      id,
      bytes,
      mimeType:
        format === 'wav'
          ? 'audio/wav'
          : format === 'opus-ogg'
            ? 'audio/ogg'
            : 'audio/webm',
      ...verified,
    },
    [bytes.buffer]
  );
}

self.addEventListener('message', async (event) => {
  const { type, id, file, options } = event.data || {};
  try {
    if (type === 'DETECT_CAPABILITIES') {
      const capabilities = await detectCapabilities();
      self.postMessage({ type: 'CAPABILITIES', id, capabilities });
    } else if (type === 'COMPRESS_VIDEO') {
      await handleVideoCompression(id, file, options);
    } else if (type === 'COMPRESS_AUDIO') {
      await handleAudioCompression(id, file, options);
    } else if (type === 'CANCEL') {
      if (activeConversion) {
        await activeConversion.cancel().catch(() => {});
        activeConversion = null;
      }
    }
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      id,
      message: err?.message || 'Native media processing failed.',
    });
  }
});
