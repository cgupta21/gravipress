const DEFAULT_TIMEOUT_MS = 60_000;

let nextRequestId = 1;

function runWorkerTask(type, payload = {}, { signal, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Media operation cancelled.'));
      return;
    }

    const id = nextRequestId++;
    const worker = new Worker(
      new URL('../workers/native-media.worker.js', import.meta.url),
      { type: 'module' }
    );

    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      worker.terminate();
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      worker.postMessage({ type: 'CANCEL', id });
      cleanup();
      reject(new Error('Media operation cancelled.'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Media operation timed out.'));
    }, timeoutMs);

    worker.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.id !== id) return;
      if (msg.type === 'PROGRESS') {
        onProgress?.(msg.progress);
      } else if (msg.type === 'CAPABILITIES') {
        settled = true;
        cleanup();
        resolve(msg.capabilities);
      } else if (msg.type === 'RESULT') {
        settled = true;
        cleanup();
        resolve({
          bytes: msg.bytes,
          mimeType: msg.mimeType,
          duration: msg.duration,
          videoTrackCount: msg.videoTrackCount,
          audioTrackCount: msg.audioTrackCount,
        });
      } else if (msg.type === 'ERROR') {
        settled = true;
        cleanup();
        reject(new Error(msg.message));
      }
    });

    worker.addEventListener('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(err?.message || 'Media worker error.'));
    });

    worker.postMessage({ type, id, ...payload });
  });
}

export function detectMediaCapabilities() {
  return runWorkerTask('DETECT_CAPABILITIES');
}

export function compressVideoToWebM(file, options = {}) {
  const { signal, onProgress, timeoutMs, ...workerOptions } = options;
  return runWorkerTask(
    'COMPRESS_VIDEO',
    { file, options: workerOptions },
    { signal, onProgress, timeoutMs }
  );
}

export function compressAudio(file, options = {}) {
  const { signal, onProgress, timeoutMs, ...workerOptions } = options;
  return runWorkerTask(
    'COMPRESS_AUDIO',
    { file, options: workerOptions },
    { signal, onProgress, timeoutMs }
  );
}
