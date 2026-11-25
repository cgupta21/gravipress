import {
  VIDEO_CONTAINER_FORMATS,
  VIDEO_LIMITS,
  VIDEO_PRESETS,
} from '../config/video-presets.js';
import {
  buildCompressedVideoFilename,
  computeScaledDimensions,
  estimateVideoBitrateKbps,
  validateVideoLimits,
} from '../utils/video-utils.js';
import { calculateSavings, formatFileSize } from '../utils/file-utils.js';

let activeWorker = null;

export function terminateVideoWorker() {
  if (activeWorker) {
    try {
      activeWorker.terminate();
    } catch (e) {
      // ignore
    }
    activeWorker = null;
  }
}

function runVideoWorker(
  inputBuffer,
  inputName,
  options,
  signal,
  onProgress = () => {}
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Video compression cancelled.', 'AbortError'));
      return;
    }

    const worker = new Worker(
      new URL('../workers/video.worker.js', import.meta.url),
      { type: 'module' }
    );
    activeWorker = worker;

    const id = `vid-${Date.now()}`;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (activeWorker === worker) {
        activeWorker = null;
      }
      worker.terminate();
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Video compression cancelled.', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.id !== id) return;

      if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.error));
      } else if (msg.type === 'progress') {
        onProgress({
          progress:
            typeof msg.progress === 'number'
              ? Math.round(msg.progress * 100)
              : 0,
          label: 'ENCODING MULTIMEDIA',
          time: msg.time,
        });
      } else if (msg.type === 'status') {
        onProgress({
          progress: 50,
          label: msg.label || 'PROCESSING VIDEO',
          indeterminate: true,
        });
      } else if (msg.type === 'complete') {
        cleanup();
        resolve(new Uint8Array(msg.buffer));
      }
    };

    worker.onerror = (err) => {
      cleanup();
      reject(new Error(err?.message || 'Video worker execution failed.'));
    };

    onProgress({ progress: 10, label: 'LOADING MULTIMEDIA ENGINE' });
    worker.postMessage(
      {
        id,
        type: 'transcode',
        inputData: inputBuffer,
        inputName,
        options,
      },
      [inputBuffer]
    );
  });
}

export async function compressVideo(file, metadata, options = {}) {
  const {
    presetId = 'Balanced',
    targetFormat = 'mp4',
    maxDimensionOption = null,
    removeAudio = false,
    customCrf = null,
    maxFps = null,
    audioBitrateKbps = null,
    targetSizeBytes = null,
    signal,
    onProgress = () => {},
  } = options;

  onProgress({ progress: 5, label: 'VALIDATING INPUT' });
  validateVideoLimits(metadata, file.size);

  const preset = VIDEO_PRESETS[presetId] || VIDEO_PRESETS.Balanced;
  const maxDim = maxDimensionOption || preset.maxDimension;

  const originalWidth = metadata.width || 1280;
  const originalHeight = metadata.height || 720;
  const scaled = computeScaledDimensions(originalWidth, originalHeight, maxDim);

  const crf =
    customCrf !== null
      ? customCrf
      : targetFormat === 'webm'
        ? preset.crfWebm
        : preset.crf;

  const audioBitrate =
    audioBitrateKbps !== null ? audioBitrateKbps : preset.audioBitrateKbps;
  const fps = maxFps !== null ? maxFps : preset.maxFps;

  let targetBitrateKbps = null;
  if (targetSizeBytes && metadata.duration > 0) {
    targetBitrateKbps = estimateVideoBitrateKbps(
      targetSizeBytes,
      metadata.duration,
      removeAudio ? 0 : audioBitrate,
      targetFormat
    );
  }

  const workerOptions = {
    outputFilename: `out${VIDEO_CONTAINER_FORMATS[targetFormat]?.extension || '.mp4'}`,
    targetFormat,
    width: scaled.width,
    height: scaled.height,
    crf,
    targetBitrateKbps,
    maxFps: fps,
    audioBitrateKbps: audioBitrate,
    removeAudio: removeAudio || !metadata.hasAudio,
    hasAudio: metadata.hasAudio,
  };

  const startTime = performance.now();
  const fileBytes = await file.arrayBuffer();

  onProgress({ progress: 15, label: 'INSPECTING CODECS' });

  const compressedBytes = await runVideoWorker(
    fileBytes,
    file.name,
    workerOptions,
    signal,
    onProgress
  );

  onProgress({ progress: 95, label: 'FINALIZING CONTAINER' });

  const durationMs = Math.round(performance.now() - startTime);
  const originalSize = file.size;
  const compressedSize = compressedBytes.byteLength;

  const savings = calculateSavings(originalSize, compressedSize);
  const wasReduced = compressedSize < originalSize;

  const mimeType =
    VIDEO_CONTAINER_FORMATS[targetFormat]?.mimeType || 'video/mp4';
  const blob = new Blob([compressedBytes], { type: mimeType });

  return {
    blob,
    originalSize,
    compressedSize,
    savings,
    wasReduced,
    outputFilename: buildCompressedVideoFilename(file.name, targetFormat),
    mimeType,
    durationMs,
    presetId,
    targetFormat,
    outputWidth: scaled.width,
    outputHeight: scaled.height,
    originalWidth,
    originalHeight,
    durationSeconds: metadata.duration,
    hasAudio: !workerOptions.removeAudio && metadata.hasAudio,
  };
}
