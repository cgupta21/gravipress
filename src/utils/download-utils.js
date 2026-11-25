export function createFileBlob(bytes, mimeType) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error('Cannot create a download from empty data.');
  }

  return new Blob([bytes], { type: mimeType });
}

export function triggerFileDownload(blob, filename) {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error('Cannot download an empty file.');
  }

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1500);
}

export function createPdfBlob(bytes) {
  return createFileBlob(bytes, 'application/pdf');
}

export function triggerPdfDownload(blob, filename) {
  triggerFileDownload(blob, filename);
}
