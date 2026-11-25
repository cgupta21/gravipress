import {
  COMPRESSION_PRESETS,
  PDF_LIMITS,
} from '../config/compression-presets.js';
import { calculateSavings, hasPdfHeader } from '../utils/file-utils.js';
import {
  createPdfJsDocumentOptions,
  loadPdfJs,
  loadPdfLib,
  mapPdfError,
} from './pdf-loader.js';

const TEXT_ONLY_SIZE_THRESHOLD_BYTES = 150 * 1024;

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Compression cancelled by user.', 'AbortError');
  }
}

function computeBoundedScale(baseViewport, targetDpi) {
  const desiredScale = targetDpi / 72;
  const maxDimScale = Math.min(
    PDF_LIMITS.maxPageDimensionPx / baseViewport.width,
    PDF_LIMITS.maxPageDimensionPx / baseViewport.height
  );
  const currentPixels =
    baseViewport.width * desiredScale * (baseViewport.height * desiredScale);
  const maxPixelScale =
    currentPixels > PDF_LIMITS.maxPagePixels
      ? Math.sqrt(
          PDF_LIMITS.maxPagePixels / (baseViewport.width * baseViewport.height)
        )
      : desiredScale;

  return Math.max(0.1, Math.min(desiredScale, maxDimScale, maxPixelScale));
}

async function canvasToJpegBytes(canvas, quality) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error('Failed to encode compressed page image.'));
        }
      },
      'image/jpeg',
      quality
    );
  });

  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

function hasEmbeddedImages(bytes) {
  const snippet = new TextDecoder('latin1').decode(bytes);
  return (
    snippet.includes('/Subtype /Image') || snippet.includes('/Subtype/Image')
  );
}

async function compressLosslessStructural(originalBytes, onProgress, signal) {
  throwIfAborted(signal);
  onProgress({
    stage: 'compress',
    label: 'OPTIMIZING STRUCTURE',
    progress: 35,
    indeterminate: true,
  });

  const { PDFDocument } = await loadPdfLib();
  const pdfDoc = await PDFDocument.load(originalBytes, {
    ignoreEncryption: false,
  });

  throwIfAborted(signal);
  onProgress({
    stage: 'reconstruct',
    label: 'REPACKING STREAMS',
    progress: 55,
    indeterminate: true,
  });

  const compressedBytes = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    objectsPerTick: 50,
  });

  return {
    outputBytes: new Uint8Array(compressedBytes),
    pageCount: pdfDoc.getPageCount(),
    methodUsed: 'Structural optimization',
  };
}

async function compressRasterized(
  originalBytes,
  stepConfig,
  onProgress,
  signal,
  progressRange = [20, 88]
) {
  const pdfjs = await loadPdfJs();
  const { PDFDocument } = await loadPdfLib();

  let loadingTask = null;
  let pdfDocument = null;
  const canvas = document.createElement('canvas');

  try {
    throwIfAborted(signal);
    loadingTask = pdfjs.getDocument(createPdfJsDocumentOptions(originalBytes));
    if (signal) {
      signal.addEventListener('abort', () => loadingTask?.destroy(), {
        once: true,
      });
    }

    pdfDocument = await loadingTask.promise;
    const pageCount = pdfDocument.numPages;

    if (pageCount > PDF_LIMITS.maxPageCount) {
      throw new Error(
        `Document has ${pageCount} pages, exceeding the ${PDF_LIMITS.maxPageCount}-page browser limit.`
      );
    }

    const outputPdf = await PDFDocument.create();
    const [startPct, endPct] = progressRange;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      throwIfAborted(signal);

      const pageProgress =
        startPct + ((pageNumber - 1) / pageCount) * (endPct - startPct);
      onProgress({
        stage: 'render',
        label: `PRESSING PAGE ${pageNumber} OF ${pageCount}`,
        progress: pageProgress,
        indeterminate: false,
      });

      const page = await pdfDocument.getPage(pageNumber);
      try {
        const visibleViewport = page.getViewport({ scale: 1 });
        const renderScale = computeBoundedScale(
          visibleViewport,
          stepConfig.dpi
        );
        const renderViewport = page.getViewport({ scale: renderScale });

        canvas.width = Math.max(1, Math.floor(renderViewport.width));
        canvas.height = Math.max(1, Math.floor(renderViewport.height));

        const context = canvas.getContext('2d', { alpha: false });
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: context,
          viewport: renderViewport,
        }).promise;

        throwIfAborted(signal);

        const jpegBytes = await canvasToJpegBytes(
          canvas,
          stepConfig.jpegQuality
        );
        const embeddedImage = await outputPdf.embedJpg(jpegBytes);

        const outPage = outputPdf.addPage([
          visibleViewport.width,
          visibleViewport.height,
        ]);
        outPage.drawImage(embeddedImage, {
          x: 0,
          y: 0,
          width: visibleViewport.width,
          height: visibleViewport.height,
        });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }

    throwIfAborted(signal);
    onProgress({
      stage: 'reconstruct',
      label: 'ASSEMBLING PDF',
      progress: endPct,
      indeterminate: false,
    });

    const outputBytes = await outputPdf.save({
      useObjectStreams: true,
    });

    return {
      outputBytes: new Uint8Array(outputBytes),
      pageCount,
      methodUsed: stepConfig.label,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    if (typeof pdfDocument?.destroy === 'function') {
      await pdfDocument.destroy();
    } else if (typeof loadingTask?.destroy === 'function') {
      await loadingTask.destroy();
    }
  }
}

async function validateOutputPdf(outputBytes, expectedPageCount) {
  const { PDFDocument } = await loadPdfLib();
  const verifiedDoc = await PDFDocument.load(outputBytes, {
    ignoreEncryption: false,
  });

  if (verifiedDoc.getPageCount() !== expectedPageCount) {
    throw new Error(
      'Output validation failed: compressed page count does not match original.'
    );
  }
}

export async function compressPdf(originalBytes, modeName, options = {}) {
  const { onProgress = () => {}, signal } = options;
  const preset = COMPRESSION_PRESETS[modeName];
  if (!preset) {
    throw new Error(`Unknown compression preset: ${modeName}`);
  }

  const startTime = performance.now();

  try {
    throwIfAborted(signal);
    onProgress({
      stage: 'validate',
      label: 'VALIDATING PDF',
      progress: 5,
      indeterminate: true,
    });

    if (
      !(originalBytes instanceof Uint8Array) ||
      !hasPdfHeader(originalBytes)
    ) {
      throw new Error('Invalid PDF data.');
    }

    onProgress({
      stage: 'parse',
      label: 'PARSING DOCUMENT',
      progress: 12,
      indeterminate: true,
    });

    const { PDFDocument } = await loadPdfLib();
    const parsedOriginal = await PDFDocument.load(originalBytes, {
      ignoreEncryption: false,
    });
    const originalPageCount = parsedOriginal.getPageCount();

    if (originalPageCount === 0) {
      throw new Error('The PDF contains zero pages.');
    }

    if (originalPageCount > PDF_LIMITS.maxPageCount) {
      throw new Error(
        `Document has ${originalPageCount} pages, exceeding the ${PDF_LIMITS.maxPageCount}-page browser limit.`
      );
    }

    // Always evaluate structural optimization first so text-based PDFs
    // preserve selectable text, forms, and links without unnecessary rasterization.
    const structuralCandidate = await compressLosslessStructural(
      originalBytes,
      onProgress,
      signal
    );

    const candidates = [structuralCandidate];
    const originalSize = originalBytes.byteLength;
    const isTextOnlyDocument =
      originalSize <= TEXT_ONLY_SIZE_THRESHOLD_BYTES &&
      !hasEmbeddedImages(originalBytes);

    if (preset.isLossy && !isTextOnlyDocument) {
      const steps = preset.adaptiveSteps || [
        {
          dpi: preset.dpi,
          jpegQuality: preset.jpegQuality,
          label: `${preset.id} (${preset.dpi} DPI / ${preset.jpegQuality})`,
        },
      ];

      for (let i = 0; i < steps.length; i += 1) {
        throwIfAborted(signal);
        const step = steps[i];
        const rangeStart = i === 0 ? 58 : 74;
        const rangeEnd = i === 0 ? 74 : 90;

        const rasterCandidate = await compressRasterized(
          originalBytes,
          step,
          onProgress,
          signal,
          [rangeStart, rangeEnd]
        );
        candidates.push(rasterCandidate);

        // Stop early if this step already achieved meaningful reduction
        // over both the original and structural candidate.
        const bestSoFar = Math.min(
          originalSize,
          structuralCandidate.outputBytes.byteLength
        );
        if (rasterCandidate.outputBytes.byteLength < bestSoFar * 0.95) {
          break;
        }
      }
    }

    throwIfAborted(signal);
    onProgress({
      stage: 'verify',
      label: 'VERIFYING OUTPUT',
      progress: 95,
      indeterminate: false,
    });

    let bestCandidate = null;
    for (const candidate of candidates) {
      if (
        !bestCandidate ||
        candidate.outputBytes.byteLength < bestCandidate.outputBytes.byteLength
      ) {
        bestCandidate = candidate;
      }
    }

    await validateOutputPdf(bestCandidate.outputBytes, originalPageCount);

    const candidateSize = bestCandidate.outputBytes.byteLength;
    const savings = calculateSavings(originalSize, candidateSize);
    const finalBytes = savings.reduced
      ? bestCandidate.outputBytes
      : originalBytes;
    const finalSize = finalBytes.byteLength;
    const finalSavings = calculateSavings(originalSize, finalSize);
    const durationMs = Math.round(performance.now() - startTime);

    return {
      bytes: finalBytes,
      originalSize,
      compressedSize: finalSize,
      bytesSaved: finalSavings.bytesSaved,
      percentageSaved: finalSavings.percentage,
      wasReduced: savings.reduced,
      methodUsed: savings.reduced
        ? bestCandidate.methodUsed
        : 'Unchanged (original retained)',
      pageCount: originalPageCount,
      durationMs,
      mode: preset.id,
    };
  } catch (error) {
    throw mapPdfError(error);
  }
}
