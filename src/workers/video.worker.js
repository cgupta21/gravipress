import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let ffmpegInstance = null;
let isLoaded = false;
let currentLoadPromise = null;

export async function getFFmpeg(onLog = () => {}, onProgress = () => {}) {
  if (isLoaded && ffmpegInstance) {
    return ffmpegInstance;
  }
  if (currentLoadPromise) {
    return currentLoadPromise;
  }

  currentLoadPromise = (async () => {
    const ffmpeg = new FFmpeg();

    ffmpeg.on('log', ({ message }) => {
      onLog(message);
    });

    ffmpeg.on('progress', ({ progress, time }) => {
      onProgress({ progress, time });
    });

    // Determine baseURL for self-hosted ffmpeg-core files
    // In dev / preview / production Vite builds, assets are hosted under /ffmpeg/
    const origin =
      typeof self !== 'undefined' && self.location?.origin
        ? self.location.origin
        : '';
    const baseURL = `${origin}/ffmpeg/`;

    const coreURL = await toBlobURL(
      `${baseURL}ffmpeg-core.js`,
      'text/javascript'
    );
    const wasmURL = await toBlobURL(
      `${baseURL}ffmpeg-core.wasm`,
      'application/wasm'
    );

    await ffmpeg.load({
      coreURL,
      wasmURL,
    });

    ffmpegInstance = ffmpeg;
    isLoaded = true;
    currentLoadPromise = null;
    return ffmpeg;
  })();

  try {
    return await currentLoadPromise;
  } catch (err) {
    currentLoadPromise = null;
    isLoaded = false;
    ffmpegInstance = null;
    throw err;
  }
}

self.onmessage = async (event) => {
  const { id, type, inputData, inputName, options } = event.data;

  try {
    if (type === 'transcode') {
      const ffmpeg = await getFFmpeg(
        (msg) => {
          self.postMessage({ id, type: 'log', message: msg });
        },
        ({ progress, time }) => {
          self.postMessage({ id, type: 'progress', progress, time });
        }
      );

      const inFilename = `input_${id}_${inputName || 'file'}`;
      const outFilename = `output_${id}_${options.outputFilename || 'out.mp4'}`;

      await ffmpeg.writeFile(inFilename, new Uint8Array(inputData));

      // Construct safe arguments array (never shell string)
      const args = ['-i', inFilename];

      // Video scaling filter if needed
      const filters = [];
      if (options.width && options.height) {
        filters.push(`scale=${options.width}:${options.height}`);
      }
      if (filters.length > 0) {
        args.push('-vf', filters.join(','));
      }

      // Video Codec & Settings
      if (options.targetFormat === 'webm') {
        args.push('-c:v', 'libvpx');
        if (options.targetBitrateKbps) {
          args.push('-b:v', `${options.targetBitrateKbps}k`);
        } else {
          args.push('-crf', String(options.crf || 32));
          args.push('-b:v', '0');
        }
      } else {
        // Default MP4 / H.264
        args.push('-c:v', 'libx264');
        args.push('-preset', 'veryfast');
        if (options.targetBitrateKbps) {
          args.push('-b:v', `${options.targetBitrateKbps}k`);
        } else {
          args.push('-crf', String(options.crf || 28));
        }
        args.push('-pix_fmt', 'yuv420p');
      }

      // Frame Rate limit if specified
      if (options.maxFps) {
        args.push('-r', String(options.maxFps));
      }

      // Audio handling
      if (options.removeAudio || !options.hasAudio) {
        args.push('-an');
      } else {
        if (options.targetFormat === 'webm') {
          args.push('-c:a', 'libvorbis');
        } else {
          args.push('-c:a', 'aac');
        }
        args.push('-b:a', `${options.audioBitrateKbps || 96}k`);
      }

      // Overwrite output
      args.push('-y', outFilename);

      self.postMessage({ id, type: 'status', label: 'ENCODING MULTIMEDIA' });
      await ffmpeg.exec(args);

      const outputBytes = await ffmpeg.readFile(outFilename);

      // Clean up virtual filesystem
      try {
        await ffmpeg.deleteFile(inFilename);
        await ffmpeg.deleteFile(outFilename);
      } catch (cleanErr) {
        // Non-fatal cleanup
      }

      self.postMessage(
        {
          id,
          type: 'complete',
          buffer: outputBytes.buffer,
          byteLength: outputBytes.byteLength,
        },
        [outputBytes.buffer]
      );
      return;
    }

    throw new Error(`Unsupported video worker operation: ${type}`);
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      error: error?.message || 'Video worker compression failed.',
    });
  }
};
