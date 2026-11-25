import { QUEUE_STATUS } from '../config/batch-limits.js';
import { UNSUPPORTED_FORMAT_PATTERN } from '../config/compression-presets.js';
import { createFileBlob } from '../utils/download-utils.js';
import { hasPdfHeader, validatePdfFile } from '../utils/file-utils.js';
import { detectImageFormat } from '../utils/image-utils.js';
import { compressImage } from './image-compressor.js';
import { renderImagePreview } from './image-preview.js';
import { compressPdf } from './pdf-compressor.js';
import { renderPdfFirstPagePreview } from './pdf-preview.js';

export async function runBatchQueue(queue, callbacks = {}) {
  const {
    onQueueUpdated = () => {},
    onItemPreview = () => {},
    onProgress = () => {},
    onItemSettled = () => {},
    batchSignal,
    setItemAbortController = () => {},
  } = callbacks;

  const items = queue.getItems();
  const runnableIds = items
    .filter((item) => item.status === QUEUE_STATUS.QUEUED)
    .map((item) => item.id);

  for (let idx = 0; idx < runnableIds.length; idx += 1) {
    if (batchSignal?.aborted) {
      break;
    }

    const item = queue.getItem(runnableIds[idx]);
    if (!item || item.status !== QUEUE_STATUS.QUEUED) {
      continue;
    }

    const itemController = new AbortController();
    setItemAbortController(item.id, itemController);

    const onBatchAbort = () => itemController.abort();
    batchSignal?.addEventListener('abort', onBatchAbort, { once: true });

    let previewUrl = null;
    const itemStart = performance.now();

    try {
      queue.updateItem(item.id, {
        status: QUEUE_STATUS.VALIDATING,
        progress: 5,
        indeterminate: true,
        statusDetail: 'Validating…',
        error: null,
      });
      onQueueUpdated();

      if (UNSUPPORTED_FORMAT_PATTERN.test(item.name)) {
        const ext = item.name.split('.').pop().toUpperCase();
        throw new Error(`${ext} compression is not supported.`);
      }

      const bytes = new Uint8Array(await item.file.arrayBuffer());
      if (bytes.length === 0) {
        throw new Error('File is empty (0 bytes).');
      }

      const preset = queue.getEffectivePreset(item);
      let kind = null;
      let formatLabel = 'FILE';

      if (hasPdfHeader(bytes)) {
        const pdfCheck = validatePdfFile(item.file, bytes);
        if (!pdfCheck.valid) {
          throw new Error(pdfCheck.error);
        }
        kind = 'pdf';
        formatLabel = 'PDF';
        try {
          const preview = await renderPdfFirstPagePreview(
            bytes,
            itemController.signal
          );
          previewUrl = preview.previewUrl;
          onItemPreview(item, previewUrl, `${preview.pageCount} pages`);
        } catch (previewErr) {
          if (previewErr?.name === 'AbortError') {
            throw previewErr;
          }
          throw previewErr;
        }
      } else {
        const imgFormat = detectImageFormat(bytes);
        if (!imgFormat) {
          throw new Error(
            'Invalid or unsupported file signature (expected PDF, JPEG, PNG, WebP, or AVIF).'
          );
        }
        kind = 'image';
        formatLabel = imgFormat;
        const preview = await renderImagePreview(
          item.file,
          bytes,
          itemController.signal
        );
        previewUrl = preview.previewUrl;
        onItemPreview(item, previewUrl, `${preview.width}×${preview.height}`);
      }

      queue.updateItem(item.id, {
        kind,
        formatLabel,
        status: QUEUE_STATUS.PROCESSING,
        progress: 15,
        indeterminate: false,
        statusDetail: `Compressing (${preset})…`,
      });
      onQueueUpdated();

      const itemProgressHandler = ({ label, progress, indeterminate }) => {
        if (itemController.signal.aborted) {
          return;
        }
        queue.updateItem(item.id, {
          progress,
          indeterminate: Boolean(indeterminate),
          statusDetail: label,
        });
        onProgress({
          item,
          itemIndex: idx,
          totalItems: runnableIds.length,
          label,
          progress,
          indeterminate,
        });
        onQueueUpdated();
      };

      const result =
        kind === 'pdf'
          ? await compressPdf(bytes, preset, {
              onProgress: itemProgressHandler,
              signal: itemController.signal,
            })
          : await compressImage(item.file, bytes, {
              mode: preset,
              onProgress: itemProgressHandler,
              signal: itemController.signal,
            });

      const mimeType = kind === 'image' ? result.mimeType : 'application/pdf';
      const outputBlob = createFileBlob(result.bytes, mimeType);
      const outputFilename = queue.buildOutputFilename(item, result);
      const durationMs = Math.round(performance.now() - itemStart);

      queue.updateItem(item.id, {
        status: result.wasReduced
          ? QUEUE_STATUS.COMPLETED
          : QUEUE_STATUS.UNCHANGED,
        progress: 100,
        indeterminate: false,
        statusDetail: result.wasReduced ? 'Completed' : 'Unchanged',
        outputBlob,
        outputSize: result.compressedSize,
        outputMimeType: mimeType,
        outputFilename,
        wasReduced: result.wasReduced,
        methodUsed: result.methodUsed,
        durationMs,
        error: null,
      });

      await onItemSettled(item);
    } catch (error) {
      const isCancelled =
        error?.name === 'AbortError' || itemController.signal.aborted;
      queue.updateItem(item.id, {
        status: isCancelled ? QUEUE_STATUS.CANCELLED : QUEUE_STATUS.FAILED,
        progress: 0,
        indeterminate: false,
        statusDetail: isCancelled ? 'Cancelled' : 'Failed',
        error: isCancelled
          ? 'Operation cancelled.'
          : error?.message || 'Compression failed.',
      });
    } finally {
      batchSignal?.removeEventListener('abort', onBatchAbort);
      setItemAbortController(item.id, null);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      onQueueUpdated();
    }
  }

  if (batchSignal?.aborted) {
    for (const id of runnableIds) {
      const remaining = queue.getItem(id);
      if (remaining && remaining.status === QUEUE_STATUS.QUEUED) {
        queue.updateItem(id, {
          status: QUEUE_STATUS.CANCELLED,
          statusDetail: 'Cancelled',
          error: 'Batch cancelled.',
        });
      }
    }
    onQueueUpdated();
  }
}
