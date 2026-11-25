let upngPromise = null;
const encoderSupportCache = new Map();

export async function loadUpng() {
  if (!upngPromise) {
    upngPromise = import('upng-js').then((mod) => mod.default || mod);
  }
  return upngPromise;
}

export async function supportsImageMimeType(mimeType) {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
    return true;
  }

  if (encoderSupportCache.has(mimeType)) {
    return encoderSupportCache.get(mimeType);
  }

  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 2, 2);

  const supported = await new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(Boolean(blob && blob.type === mimeType && blob.size > 0));
      },
      mimeType,
      0.8
    );
  });

  canvas.width = 0;
  canvas.height = 0;
  encoderSupportCache.set(mimeType, supported);
  return supported;
}
