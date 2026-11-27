let enginePromise = null;

export function loadNativeMediaEngine() {
  if (!enginePromise) {
    enginePromise = import('../engines/native-media-engine.js');
  }
  return enginePromise;
}

export function isVideoFile(file) {
  return (
    Boolean(file?.type?.startsWith('video/')) ||
    /\.(mp4|webm|mov|mkv)$/i.test(file?.name || '')
  );
}

export function isAudioFile(file) {
  return (
    Boolean(file?.type?.startsWith('audio/')) ||
    /\.(mp3|wav|ogg|m4a|opus|flac)$/i.test(file?.name || '')
  );
}

export async function syncMediaCapabilityControls({
  videoCodecSelect,
  audioFormatSelect,
  onUnsupported,
}) {
  const engine = await loadNativeMediaEngine();
  const caps = await engine.detectMediaCapabilities();

  if (videoCodecSelect) {
    const vp9Opt = videoCodecSelect.querySelector('option[value="vp9"]');
    const vp8Opt = videoCodecSelect.querySelector('option[value="vp8"]');
    if (vp9Opt) vp9Opt.disabled = !caps.vp9;
    if (vp8Opt) vp8Opt.disabled = !caps.vp8;
    if (videoCodecSelect.value === 'vp9' && !caps.vp9 && caps.vp8) {
      videoCodecSelect.value = 'vp8';
    }
    if (!caps.webCodecs || (!caps.vp8 && !caps.vp9)) {
      onUnsupported?.(
        'This browser does not support native VP8/VP9 WebCodecs video encoding.'
      );
    }
  }

  if (audioFormatSelect) {
    const opusWebm = audioFormatSelect.querySelector('option[value="opus-webm"]');
    const opusOgg = audioFormatSelect.querySelector('option[value="opus-ogg"]');
    if (opusWebm) opusWebm.disabled = !caps.opus;
    if (opusOgg) opusOgg.disabled = !caps.opus;
    if (audioFormatSelect.value.startsWith('opus') && !caps.opus) {
      audioFormatSelect.value = 'wav';
      onUnsupported?.(
        'Opus WebCodecs encoding is unavailable in this browser; only PCM WAV conversion is available.'
      );
    }
  }

  return caps;
}
