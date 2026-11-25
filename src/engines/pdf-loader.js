let pdfLibPromise = null;
let pdfJsPromise = null;

export async function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import('pdf-lib');
  }
  return pdfLibPromise;
}

export async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const workerModule =
        await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
      return pdfjs;
    })();
  }
  return pdfJsPromise;
}

export function createPdfJsDocumentOptions(bytes) {
  return {
    data: bytes.slice(),
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    isEvalSupported: false,
  };
}

export function mapPdfError(error) {
  const message = error?.message || '';
  const name = error?.name || '';

  if (name === 'PasswordException' || /password|encrypted/i.test(message)) {
    return new Error(
      'This PDF is password-protected or encrypted. Remove protection before compressing.'
    );
  }

  if (
    name === 'InvalidPDFException' ||
    error instanceof TypeError ||
    /invalid pdf|header|stream|xref|corrupt|failed to parse|reading 'pages'/i.test(
      message
    )
  ) {
    return new Error(
      'This PDF appears to be corrupted or uses an unsupported structure.'
    );
  }

  if (name === 'AbortError') {
    return error;
  }

  return new Error(
    message || 'Unable to process this PDF document in the browser.'
  );
}
