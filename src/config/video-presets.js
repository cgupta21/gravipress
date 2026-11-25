export const VIDEO_LIMITS = {
  maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB
  maxDurationSeconds: 60, // 60 seconds
  maxInputWidth: 1920,
  maxInputHeight: 1080,
  maxPixelsPerFrame: 1920 * 1080, // ~2.07 MP
  minTargetSizeBytes: 50 * 1024, // 50 KB
};

export const VIDEO_PRESETS = {
  Light: {
    id: 'Light',
    name: 'Light (High Quality)',
    description: 'Max 1080p, CRF 23, preserve frame rate & audio 128 kbps',
    maxDimension: 1080,
    crf: 23, // H.264
    crfWebm: 30, // VP9/VP8
    audioBitrateKbps: 128,
    maxFps: null, // preserve
  },
  Balanced: {
    id: 'Balanced',
    name: 'Balanced (Standard)',
    description: 'Max 720p, CRF 28, max 30 fps, audio 96 kbps',
    maxDimension: 720,
    crf: 28,
    crfWebm: 36,
    audioBitrateKbps: 96,
    maxFps: 30,
  },
  Maximum: {
    id: 'Maximum',
    name: 'Maximum (High Compression)',
    description: 'Max 480p, CRF 32, max 30 fps, audio 64 kbps',
    maxDimension: 480,
    crf: 32,
    crfWebm: 42,
    audioBitrateKbps: 64,
    maxFps: 30,
  },
};

export const VIDEO_CONTAINER_FORMATS = {
  mp4: {
    extension: '.mp4',
    mimeType: 'video/mp4',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    label: 'MP4 (H.264 / AAC)',
  },
  webm: {
    extension: '.webm',
    mimeType: 'video/webm',
    videoCodec: 'libvpx',
    audioCodec: 'libvorbis',
    label: 'WebM (VP8 / Vorbis)',
  },
};
