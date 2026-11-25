import { gzipSync, zipSync } from 'fflate';

self.onmessage = (event) => {
  const { id, type, entries, data, level, filename } = event.data;

  try {
    if (type === 'gzip') {
      const input = new Uint8Array(data);
      const output = gzipSync(input, {
        level,
        filename: filename || undefined,
      });
      self.postMessage(
        { id, buffer: output.buffer, byteLength: output.byteLength },
        [output.buffer]
      );
      return;
    }

    if (type === 'zip') {
      const zipInput = Object.create(null);
      for (const entry of entries) {
        zipInput[entry.path] = [
          new Uint8Array(entry.buffer),
          { level: entry.level },
        ];
      }
      const output = zipSync(zipInput);
      self.postMessage(
        { id, buffer: output.buffer, byteLength: output.byteLength },
        [output.buffer]
      );
      return;
    }

    throw new Error(`Unsupported worker operation: ${type}`);
  } catch (error) {
    self.postMessage({
      id,
      error: error?.message || 'Worker compression failed.',
    });
  }
};
