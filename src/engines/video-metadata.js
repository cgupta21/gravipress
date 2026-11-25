import { detectVideoFormat } from '../utils/video-utils.js';

export function extractVideoMetadata(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const objectUrl = URL.createObjectURL(file);
    let resolved = false;

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute('src');
      video.load();
    };

    video.onloadedmetadata = () => {
      if (resolved) return;
      resolved = true;

      const duration = video.duration || 0;
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;

      // Check audio track presence via webkitAudioDecodedByteCount or audioTracks if supported
      let hasAudio = false;
      if ('webkitAudioDecodedByteCount' in video) {
        hasAudio = video.webkitAudioDecodedByteCount > 0;
      } else if ('audioTracks' in video && video.audioTracks) {
        hasAudio = video.audioTracks.length > 0;
      } else {
        // Assume potential audio for common containers unless proven otherwise
        hasAudio = true;
      }

      cleanup();
      resolve({
        duration,
        width,
        height,
        hasAudio,
        bitrateApprox:
          duration > 0 ? Math.round((file.size * 8) / duration) : null,
      });
    };

    video.onerror = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      // Even if browser video element fails to decode native preview, return basic file info
      resolve({
        duration: 0,
        width: 0,
        height: 0,
        hasAudio: false,
        bitrateApprox: null,
        playbackUnsupported: true,
      });
    };

    video.src = objectUrl;
  });
}

export function captureVideoPosterFrame(file, timestamp = 0.5) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;

    const objectUrl = URL.createObjectURL(file);
    let resolved = false;

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute('src');
      video.load();
    };

    const capture = () => {
      if (resolved) return;
      resolved = true;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 240;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        cleanup();
        resolve(dataUrl);
      } catch (err) {
        cleanup();
        resolve(null);
      }
    };

    video.onloadeddata = () => {
      if (video.duration > 0 && timestamp > 0) {
        video.currentTime = Math.min(timestamp, video.duration / 2);
      } else {
        capture();
      }
    };

    video.onseeked = () => {
      capture();
    };

    video.onerror = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(null);
    };

    video.src = objectUrl;
  });
}
