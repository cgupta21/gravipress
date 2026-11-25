import { PDF_LIMITS } from '../config/compression-presets.js';
import {
  createPdfJsDocumentOptions,
  loadPdfJs,
  loadPdfLib,
  mapPdfError,
} from './pdf-loader.js';

const PREVIEW_MAX_WIDTH = 420;
const PREVIEW_MAX_HEIGHT = 560;

export async function renderPdfFirstPagePreview(bytes, signal) {
  const pdfjs = await loadPdfJs();
  let loadingTask = null;
  let pdfDocument = null;
  let firstPage = null;

  try {
    if (signal?.aborted) {
      throw new DOMException('Preview cancelled.', 'AbortError');
    }

    loadingTask = pdfjs.getDocument(createPdfJsDocumentOptions(bytes));
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          loadingTask?.destroy();
        },
        { once: true }
      );
    }

    pdfDocument = await loadingTask.promise;
    const pageCount = pdfDocument.numPages;

    if (pageCount > PDF_LIMITS.maxPageCount) {
      throw new Error(
        `Document has ${pageCount} pages, exceeding the ${PDF_LIMITS.maxPageCount}-page browser limit.`
      );
    }

    firstPage = await pdfDocument.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    const scale = Math.min(
      PREVIEW_MAX_WIDTH / baseViewport.width,
      PREVIEW_MAX_HEIGHT / baseViewport.height,
      2
    );
    const viewport = firstPage.getViewport({ scale: Math.max(scale, 0.1) });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await firstPage.render({
      canvasContext: context,
      viewport,
    }).promise;

    if (signal?.aborted) {
      throw new DOMException('Preview cancelled.', 'AbortError');
    }

    const previewBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to generate preview image.'));
          }
        },
        'image/png',
        0.92
      );
    });

    canvas.width = 0;
    canvas.height = 0;

    return {
      previewUrl: URL.createObjectURL(previewBlob),
      pageCount,
    };
  } catch (error) {
    throw mapPdfError(error);
  } finally {
    if (firstPage) {
      firstPage.cleanup();
    }
    if (typeof pdfDocument?.destroy === 'function') {
      await pdfDocument.destroy();
    } else if (typeof loadingTask?.destroy === 'function') {
      await loadingTask.destroy();
    }
  }
}

export async function generateSamplePdfBytes() {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdfDoc = await PDFDocument.create();
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const olive = rgb(43 / 255, 45 / 255, 33 / 255);
  const yellow = rgb(255 / 255, 201 / 255, 60 / 255);
  const grey = rgb(217 / 255, 218 / 255, 220 / 255);
  const muted = rgb(95 / 255, 98 / 255, 86 / 255);

  const pageOne = pdfDoc.addPage([595, 842]);
  pageOne.drawRectangle({
    x: 42,
    y: 730,
    width: 511,
    height: 70,
    color: olive,
  });
  pageOne.drawText('GRAVIPRESS // SAMPLE SPECIFICATION 001', {
    x: 60,
    y: 760,
    size: 16,
    font: boldFont,
    color: yellow,
  });
  pageOne.drawText('Local-First Browser PDF Compression Test Document', {
    x: 60,
    y: 742,
    size: 10,
    font: regularFont,
    color: grey,
  });

  const bodyLines = [
    'This multi-page sample PDF is generated locally in your browser.',
    'Use it to test structural Light compression as well as Balanced',
    '(144 DPI) and Maximum (96 DPI) rasterized compression modes.',
    '',
    '1. All processing occurs client-side without external uploads.',
    '2. Light mode optimizes PDF object streams while keeping text.',
    '3. Balanced and Maximum modes render pages to compressed JPEGs.',
  ];

  bodyLines.forEach((line, index) => {
    pageOne.drawText(line, {
      x: 54,
      y: 675 - index * 22,
      size: 12,
      font: regularFont,
      color: olive,
    });
  });

  for (let row = 0; row < 12; row += 1) {
    pageOne.drawRectangle({
      x: 54,
      y: 440 - row * 28,
      width: 487,
      height: 18,
      color: row % 2 === 0 ? grey : rgb(0.95, 0.95, 0.93),
    });
    pageOne.drawText(
      `SPEC-ROW-${String(row + 1).padStart(2, '0')}  |  PRESS UNIT GP-01`,
      {
        x: 64,
        y: 445 - row * 28,
        size: 9,
        font: regularFont,
        color: muted,
      }
    );
  }

  const pageTwo = pdfDoc.addPage([595, 842]);
  pageTwo.drawText('PAGE 02 // HYDRAULIC TELEMETRY SUMMARY', {
    x: 54,
    y: 770,
    size: 14,
    font: boldFont,
    color: olive,
  });
  pageTwo.drawRectangle({
    x: 54,
    y: 756,
    width: 487,
    height: 3,
    color: yellow,
  });
  pageTwo.drawText(
    'Page count, orientation, and visible dimensions are preserved across modes.',
    {
      x: 54,
      y: 720,
      size: 11,
      font: regularFont,
      color: olive,
    }
  );

  // Add uncompressed-friendly padding comments via metadata/uncompressed save
  // so Light mode with object streams can measurably compact the sample.
  pdfDoc.setTitle('Gravipress Sample Document');
  pdfDoc.setSubject('Client-side PDF compression test fixture');
  pdfDoc.setCreator('Gravipress GP-01');

  return pdfDoc.save({ useObjectStreams: false });
}
