import {
  renderBatchQueue,
  renderBatchSummary,
} from './components/batch-workspace.js';
import { BATCH_LIMITS, QUEUE_STATUS } from './config/batch-limits.js';
import {
  COMPRESSION_PRESETS,
  PDF_LIMITS,
  UNSUPPORTED_FORMAT_PATTERN,
} from './config/compression-presets.js';
import { IMAGE_LIMITS, IMAGE_PRESETS } from './config/image-presets.js';
import { buildBatchZip } from './engines/archive-builder.js';
import { runBatchQueue } from './engines/batch-compressor.js';
import { compressImage } from './engines/image-compressor.js';
import { renderImagePreview } from './engines/image-preview.js';
import { compressPdf } from './engines/pdf-compressor.js';
import {
  generateSamplePdfBytes,
  renderPdfFirstPagePreview,
} from './engines/pdf-preview.js';
import { createProcessingQueue } from './state/processing-queue.js';
import { createFileBlob, triggerFileDownload } from './utils/download-utils.js';
import {
  buildCompressedFilename,
  detectDigitalSignature,
  formatFileSize,
  formatPercentageReduction,
  hasPdfHeader,
  validatePdfFile,
} from './utils/file-utils.js';
import {
  buildCompressedImageFilename,
  detectImageFormat,
} from './utils/image-utils.js';

// ============================================================================
// State
// ============================================================================

let selectedFile = null;
let selectedFileBytes = null;
let selectedKind = null; // 'pdf' | 'image' | 'batch'
let selectedPageCount = 0;
let selectedImageInfo = null;
let hasDigitalSignature = false;
let previewObjectUrl = null;
let compressedPreviewUrl = null;
let compressionResult = null;
let useCustomQuality = false;
let activeOperationId = 0;
let activeAbortController = null;
let isCompressing = false;

let batchMode = false;
const batchQueue = createProcessingQueue('Balanced');
const itemAbortControllers = new Map();
let lastZipInfo = null;
let zipAbortController = null;

// ============================================================================
// DOM Helpers
// ============================================================================

function getElement(id) {
  return document.getElementById(id);
}

function getSelectedMode() {
  const checked = document.querySelector('[name=mode]:checked');
  return checked ? checked.value : 'Balanced';
}

function setPressPosition(fraction) {
  const clamped = Math.max(0, Math.min(1, fraction));
  getElement('machine').style.setProperty('--press', String(clamped));
}

function updateProgress(percentage, indeterminate = false) {
  const progressBar = getElement('progress');
  const clamped = Math.max(0, Math.min(100, percentage));

  progressBar.classList.toggle('indeterminate', Boolean(indeterminate));
  progressBar.firstElementChild.style.width = `${clamped}%`;
  progressBar.setAttribute('aria-valuenow', String(Math.round(clamped)));
}

function showError(message) {
  const errorElement = getElement('error');
  errorElement.textContent = message;
  errorElement.hidden = !message;
}

function updatePresetDescription() {
  const mode = getSelectedMode();
  if (selectedKind === 'image') {
    const preset = IMAGE_PRESETS[mode];
    if (preset) {
      getElement('quality').textContent = preset.description;
    }
  } else {
    const preset = COMPRESSION_PRESETS[mode];
    if (preset) {
      getElement('quality').textContent = preset.description;
    }
  }
}

function updateWarnings() {
  const mode = getSelectedMode();
  const warnings = [];

  if (batchMode) {
    const preset = COMPRESSION_PRESETS[mode];
    if (preset?.warning) {
      warnings.push(preset.warning);
    }
  } else if (selectedKind !== 'image') {
    const preset = COMPRESSION_PRESETS[mode];
    if (preset?.warning) {
      warnings.push(preset.warning);
    }
    if (hasDigitalSignature) {
      warnings.push(
        'Digital signature detected: processing this PDF can invalidate existing signatures.'
      );
    }
  } else if (selectedImageInfo?.format === 'PNG' && mode !== 'Light') {
    warnings.push(
      `${mode} mode uses indexed palette quantization for PNG to reduce file size while preserving transparency.`
    );
  }

  const warningElement = getElement('warning');
  if (warnings.length > 0) {
    warningElement.textContent = warnings.join(' ');
    warningElement.hidden = false;
  } else {
    warningElement.textContent = '';
    warningElement.hidden = true;
  }
}

function syncImageOptionsVisibility() {
  const optionsBox = getElement('image-options');
  if (batchMode || selectedKind !== 'image') {
    optionsBox.hidden = true;
    return;
  }

  optionsBox.hidden = false;
  const isPng = selectedImageInfo?.format === 'PNG';
  getElement('quality-row').hidden = isPng;

  if (!useCustomQuality) {
    const preset = IMAGE_PRESETS[getSelectedMode()];
    const pct = Math.round((preset?.lossyQuality || 0.78) * 100);
    getElement('custom-quality').value = String(pct);
    getElement('custom-quality-value').textContent = `${pct}%`;
  }
}

function getTargetSizeBytes() {
  const selectValue = getElement('target-size').value;
  if (!selectValue) {
    return null;
  }

  if (selectValue === 'custom') {
    const raw = Number(getElement('custom-target-value').value);
    const unit = getElement('custom-target-unit').value;
    if (!Number.isFinite(raw) || raw <= 0) {
      return null;
    }
    return Math.round(raw * (unit === 'MB' ? 1048576 : 1024));
  }

  const kb = Number(selectValue);
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

function openDialog(title, text) {
  getElement('dialog-title').textContent = title;
  getElement('dialog-text').textContent = text;
  getElement('dialog').showModal();
}

function setCompressionUiState(running) {
  isCompressing = running;
  const startButton = getElement('start');
  const cancelButton = getElement('cancel');

  startButton.disabled = running;
  cancelButton.hidden = !running;

  if (!running) {
    startButton.firstElementChild.textContent = batchMode
      ? 'Compress batch'
      : selectedKind === 'image'
        ? 'Compress image'
        : selectedKind === 'pdf'
          ? 'Compress PDF'
          : 'Compress file';
  }
}

// ============================================================================
// Preview & Results Rendering
// ============================================================================

function clearCompressedPreview() {
  if (compressedPreviewUrl) {
    URL.revokeObjectURL(compressedPreviewUrl);
  }
  compressedPreviewUrl = null;
  getElement('comparison').hidden = true;
  getElement('compare-before').removeAttribute('src');
  getElement('compare-after').removeAttribute('src');
}

function clearImagePreview() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
  }
  previewObjectUrl = null;
  clearCompressedPreview();

  const previewImage = getElement('image-preview');
  previewImage.hidden = true;
  previewImage.removeAttribute('src');

  getElement('paper').querySelector('.document').hidden = false;
}

function resetPressState() {
  setPressPosition(0);
  updateProgress(0, false);
  clearCompressedPreview();
  getElement('result').hidden = true;
  getElement('metrics').innerHTML = '';
  getElement('status').textContent = 'SYSTEM READY';
  setCompressionUiState(false);
}

function renderResultMetrics(result) {
  const metricsElement = getElement('metrics');
  metricsElement.innerHTML = '';

  const pctText = formatPercentageReduction(
    result.percentageSaved,
    result.originalSize,
    result.compressedSize
  );

  const reductionText = result.wasReduced
    ? `${formatFileSize(result.bytesSaved)} (${pctText})`
    : '0 B (0.0%)';

  const entries =
    result.kind === 'image'
      ? [
          ['ORIGINAL', formatFileSize(result.originalSize)],
          ['OUTPUT', formatFileSize(result.compressedSize)],
          ['SAVED', reductionText],
          [
            'DIMENSIONS',
            `${result.originalWidth}×${result.originalHeight} → ${result.outputWidth}×${result.outputHeight}`,
          ],
          ['DURATION', `${result.durationMs} ms`],
          ['METHOD', result.methodUsed],
        ]
      : [
          ['ORIGINAL', formatFileSize(result.originalSize)],
          ['OUTPUT', formatFileSize(result.compressedSize)],
          ['SAVED', reductionText],
          ['DURATION', `${result.durationMs} ms`],
          ['PAGES', String(result.pageCount)],
          ['METHOD', result.methodUsed || result.mode],
        ];

  for (const [label, value] of entries) {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    wrapper.append(term, detail);
    metricsElement.appendChild(wrapper);
  }

  const titleElement = getElement('result-title');
  const summaryElement = getElement('result-summary');
  const downloadButton = getElement('download');
  const extLabel = result.kind === 'image' ? result.format : 'PDF';

  if (result.wasReduced) {
    titleElement.textContent = 'Press complete.';
    let summary = `Reduced by ${pctText} (${formatFileSize(result.bytesSaved)} saved) via ${result.methodUsed}.`;
    if (result.targetSizeBytes && result.targetAchieved === false) {
      summary += ` Target of ${formatFileSize(result.targetSizeBytes)} could not be reached within quality/dimension limits.`;
    }
    summaryElement.textContent = summary;
    downloadButton.firstChild.textContent = `Download compressed ${extLabel} `;
  } else {
    titleElement.textContent = 'No reduction possible.';
    summaryElement.textContent =
      'No smaller acceptable output could be produced. Original file retained.';
    downloadButton.firstChild.textContent = `Download original ${extLabel} `;
  }

  if (result.kind === 'image' && previewObjectUrl) {
    compressedPreviewUrl = URL.createObjectURL(
      createFileBlob(result.bytes, result.mimeType)
    );
    getElement('compare-before').src = previewObjectUrl;
    getElement('compare-after').src = compressedPreviewUrl;
    getElement('compare-after-label').textContent = result.wasReduced
      ? 'Compressed'
      : 'Unchanged';
    getElement('comparison').hidden = false;
  } else {
    clearCompressedPreview();
  }

  getElement('result').hidden = false;
}

// ============================================================================
// Batch Queue UI Integration
// ============================================================================

function syncBatchUi() {
  const section = getElement('batch-section');
  section.hidden = !batchMode;
  getElement('batch-toggle').textContent = batchMode
    ? 'Single mode'
    : 'Batch mode';

  if (!batchMode) {
    return;
  }

  const items = batchQueue.getItems();
  getElement('batch-count').textContent =
    `${items.length} / ${BATCH_LIMITS.maxFiles} FILES`;

  renderBatchQueue(
    getElement('batch-list'),
    batchQueue,
    {
      onPresetOverride: (id, preset) => {
        batchQueue.setItemPresetOverride(id, preset);
        syncBatchUi();
      },
      onMove: (id, delta) => {
        batchQueue.moveItem(id, delta);
        syncBatchUi();
      },
      onRemove: (id) => {
        batchQueue.removeItem(id);
        lastZipInfo = null;
        syncBatchUi();
      },
      onCancelItem: (id) => {
        const controller = itemAbortControllers.get(id);
        if (controller) {
          controller.abort();
        }
      },
      onRetryItem: (id) => {
        batchQueue.retryItem(id);
        lastZipInfo = null;
        syncBatchUi();
      },
      onDownloadItem: (id) => {
        const item = batchQueue.getItem(id);
        if (item?.outputBlob) {
          triggerFileDownload(
            item.outputBlob,
            item.outputFilename || item.name
          );
        }
      },
    },
    isCompressing
  );

  const summary = batchQueue.getAggregateSummary();
  const summaryEl = getElement('batch-summary');
  const hasProcessed =
    summary.completedCount +
      summary.unchangedCount +
      summary.failedCount +
      summary.cancelledCount >
    0;

  if (hasProcessed) {
    renderBatchSummary(summaryEl, summary, lastZipInfo);
    summaryEl.hidden = false;
  } else {
    summaryEl.hidden = true;
  }

  getElement('batch-download-zip').hidden =
    isCompressing || !summary.hasDownloadableOutputs;
  getElement('batch-retry-failed').hidden =
    isCompressing || summary.failedCount + summary.cancelledCount === 0;
}

function enterBatchMode(files = []) {
  if (!batchMode) {
    cancelActiveOperation();
    resetPressState();
    clearImagePreview();
    selectedFile = null;
    selectedFileBytes = null;
    selectedKind = 'batch';
    batchMode = true;
    syncImageOptionsVisibility();
    updateWarnings();
  }

  if (files.length > 0) {
    const { added, rejected } = batchQueue.addFiles(files);
    lastZipInfo = null;
    if (rejected.length > 0) {
      showError(rejected.map((r) => r.reason).join(' '));
    } else {
      showError('');
    }
    if (added.length > 0) {
      const count = batchQueue.getItems().length;
      getElement('filelabel').textContent =
        `${count} file${count === 1 ? '' : 's'} queued`;
      getElement('filesub').textContent =
        `${formatFileSize(batchQueue.totalInputBytes())} total • add more or compress`;
      getElement('filename').textContent = `${count} files in batch queue`;
    }
  }

  setCompressionUiState(false);
  syncBatchUi();
}

// ============================================================================
// File Selection & Cancellation
// ============================================================================

function cancelActiveOperation() {
  activeOperationId += 1;
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  if (zipAbortController) {
    zipAbortController.abort();
    zipAbortController = null;
  }
  for (const controller of itemAbortControllers.values()) {
    controller.abort();
  }
  itemAbortControllers.clear();
}

async function handleSelectedPdf(file, bytes, isSample = false) {
  cancelActiveOperation();
  const operationId = activeOperationId;
  activeAbortController = new AbortController();
  const { signal } = activeAbortController;

  resetPressState();
  clearImagePreview();
  showError('');
  compressionResult = null;
  selectedKind = 'pdf';
  selectedImageInfo = null;
  syncImageOptionsVisibility();
  updatePresetDescription();

  const validation = validatePdfFile(file, bytes);
  if (!validation.valid) {
    selectedFile = null;
    selectedFileBytes = null;
    selectedKind = null;
    selectedPageCount = 0;
    hasDigitalSignature = false;
    updateWarnings();
    showError(validation.error);
    return;
  }

  selectedFile = file;
  selectedFileBytes = bytes;
  hasDigitalSignature = detectDigitalSignature(bytes);
  updateWarnings();
  setCompressionUiState(false);

  getElement('filename').textContent = file.name;
  getElement('filelabel').textContent = file.name;
  getElement('filesub').textContent = isSample
    ? `Sample PDF • ${formatFileSize(bytes.byteLength)}`
    : formatFileSize(bytes.byteLength);
  getElement('paperhead').textContent = 'PDF / 001';
  getElement('status').textContent = 'LOADING PREVIEW';
  getElement('filemeta').hidden = false;
  getElement('filemeta').textContent =
    `Rendering page 1 • ${formatFileSize(bytes.byteLength)}`;

  try {
    const preview = await renderPdfFirstPagePreview(bytes, signal);
    if (operationId !== activeOperationId) {
      URL.revokeObjectURL(preview.previewUrl);
      return;
    }

    selectedPageCount = preview.pageCount;
    previewObjectUrl = preview.previewUrl;

    const previewImage = getElement('image-preview');
    previewImage.src = previewObjectUrl;
    previewImage.hidden = false;
    getElement('paper').querySelector('.document').hidden = true;
    previewImage.onerror = () => clearImagePreview();

    const pageLabel =
      preview.pageCount === 1 ? '1 page' : `${preview.pageCount} pages`;
    getElement('filemeta').textContent =
      `${pageLabel} • ${formatFileSize(bytes.byteLength)}`;
    getElement('status').textContent = 'SYSTEM READY';
  } catch (error) {
    if (error?.name === 'AbortError' || operationId !== activeOperationId) {
      return;
    }

    selectedFile = null;
    selectedFileBytes = null;
    selectedKind = null;
    selectedPageCount = 0;
    hasDigitalSignature = false;
    updateWarnings();
    getElement('filemeta').hidden = true;
    getElement('filename').textContent = 'Awaiting file';
    getElement('status').textContent = 'SYSTEM READY';
    showError(error.message || 'Unable to load PDF preview.');
  }
}

async function handleSelectedImage(file, bytes) {
  cancelActiveOperation();
  const operationId = activeOperationId;
  activeAbortController = new AbortController();
  const { signal } = activeAbortController;

  resetPressState();
  clearImagePreview();
  showError('');
  compressionResult = null;
  selectedKind = 'image';
  selectedPageCount = 0;
  hasDigitalSignature = false;
  useCustomQuality = false;

  selectedFile = file;
  selectedFileBytes = bytes;
  getElement('filename').textContent = file.name;
  getElement('filelabel').textContent = file.name;
  getElement('filesub').textContent = formatFileSize(bytes.byteLength);
  getElement('paperhead').textContent = 'IMG / 001';
  getElement('status').textContent = 'DECODING PREVIEW';
  getElement('filemeta').hidden = false;
  getElement('filemeta').textContent =
    `Decoding image • ${formatFileSize(bytes.byteLength)}`;

  try {
    const preview = await renderImagePreview(file, bytes, signal);
    if (operationId !== activeOperationId) {
      URL.revokeObjectURL(preview.previewUrl);
      return;
    }

    selectedImageInfo = preview;
    previewObjectUrl = preview.previewUrl;

    const previewImage = getElement('image-preview');
    previewImage.src = previewObjectUrl;
    previewImage.hidden = false;
    getElement('paper').querySelector('.document').hidden = true;
    previewImage.onerror = () => clearImagePreview();

    const alphaLabel = preview.hasAlpha ? ' • Alpha' : '';
    getElement('filemeta').textContent =
      `${preview.format} • ${preview.width}×${preview.height}${alphaLabel} • ${formatFileSize(bytes.byteLength)}`;
    getElement('status').textContent = 'SYSTEM READY';

    syncImageOptionsVisibility();
    updatePresetDescription();
    updateWarnings();
    setCompressionUiState(false);
  } catch (error) {
    if (error?.name === 'AbortError' || operationId !== activeOperationId) {
      return;
    }

    selectedFile = null;
    selectedFileBytes = null;
    selectedKind = null;
    selectedImageInfo = null;
    syncImageOptionsVisibility();
    updateWarnings();
    getElement('filemeta').hidden = true;
    getElement('filename').textContent = 'Awaiting file';
    getElement('status').textContent = 'SYSTEM READY';
    showError(error.message || 'Unable to decode image preview.');
  }
}

async function selectBrowserFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (files.length === 0) {
    return;
  }

  if (batchMode || files.length > 1) {
    enterBatchMode(files);
    return;
  }

  const file = files[0];
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (UNSUPPORTED_FORMAT_PATTERN.test(file.name)) {
      const ext = file.name.split('.').pop().toUpperCase();
      resetWorkspace();
      showError(
        `${ext} compression is not yet supported. Gravipress supports PDF, JPG, PNG, WebP, and AVIF.`
      );
      return;
    }

    if (bytes.length === 0) {
      resetWorkspace();
      showError('The selected file is empty (0 bytes).');
      return;
    }

    if (hasPdfHeader(bytes)) {
      await handleSelectedPdf(file, bytes, false);
      return;
    }

    if (detectImageFormat(bytes)) {
      await handleSelectedImage(file, bytes);
      return;
    }

    resetWorkspace();
    showError(
      'Invalid or unsupported file. Contents do not match a valid PDF, JPEG, PNG, WebP, or AVIF signature.'
    );
  } catch {
    showError('Could not read the selected file from disk.');
  }
}

async function loadSamplePdf() {
  try {
    if (batchMode) {
      batchMode = false;
      batchQueue.clear();
      lastZipInfo = null;
      syncBatchUi();
    }
    showError('');
    getElement('status').textContent = 'GENERATING SAMPLE';
    const sampleBytes = await generateSamplePdfBytes();
    const sampleFile = {
      name: 'sample-document.pdf',
      size: sampleBytes.byteLength,
    };
    await handleSelectedPdf(sampleFile, sampleBytes, true);
  } catch (error) {
    getElement('status').textContent = 'SYSTEM READY';
    showError(error?.message || 'Unable to generate sample PDF.');
  }
}

function resetWorkspace() {
  cancelActiveOperation();
  resetPressState();
  clearImagePreview();

  selectedFile = null;
  selectedFileBytes = null;
  selectedKind = null;
  selectedPageCount = 0;
  selectedImageInfo = null;
  hasDigitalSignature = false;
  compressionResult = null;
  useCustomQuality = false;

  batchMode = false;
  batchQueue.clear();
  lastZipInfo = null;

  getElement('file').value = '';
  getElement('filelabel').textContent = 'Drop your PDF, image, or batch here';
  getElement('filesub').textContent =
    'or click to browse your device (up to 20 files)';
  getElement('filename').textContent = 'Awaiting file';
  getElement('filemeta').hidden = true;
  getElement('filemeta').textContent = '';
  getElement('paperhead').textContent = 'DOCUMENT 001';
  syncImageOptionsVisibility();
  updatePresetDescription();
  updateWarnings();
  setCompressionUiState(false);
  syncBatchUi();
  showError('');
}

// ============================================================================
// Compression Workflow (Single & Batch)
// ============================================================================

function waitForSettling(durationMs, signal) {
  if (durationMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, durationMs);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Compression cancelled.', 'AbortError'));
        },
        { once: true }
      );
    }
  });
}

async function startBatchCompression() {
  const queued = batchQueue
    .getItems()
    .filter((item) => item.status === QUEUE_STATUS.QUEUED);
  if (queued.length === 0) {
    showError('Add at least one queued file to compress.');
    return;
  }

  cancelActiveOperation();
  const operationId = activeOperationId;
  activeAbortController = new AbortController();
  const { signal } = activeAbortController;
  lastZipInfo = null;

  showError('');
  setCompressionUiState(true);
  getElement('start').firstElementChild.textContent = 'Compressing batch…';
  syncBatchUi();

  const prefersReducedMotion = matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  try {
    await runBatchQueue(batchQueue, {
      batchSignal: signal,
      setItemAbortController: (id, controller) => {
        if (controller) {
          itemAbortControllers.set(id, controller);
        } else {
          itemAbortControllers.delete(id);
        }
      },
      onQueueUpdated: () => {
        if (operationId === activeOperationId) {
          syncBatchUi();
        }
      },
      onItemPreview: (item, previewUrl, metaText) => {
        if (operationId !== activeOperationId) {
          return;
        }
        getElement('filename').textContent = item.name;
        getElement('filemeta').hidden = false;
        getElement('filemeta').textContent =
          `${metaText} • ${formatFileSize(item.originalSize)}`;
        getElement('paperhead').textContent =
          `${item.formatLabel || 'FILE'} / BATCH`;
        const previewImage = getElement('image-preview');
        previewImage.src = previewUrl;
        previewImage.hidden = false;
        getElement('paper').querySelector('.document').hidden = true;
      },
      onProgress: ({
        itemIndex,
        totalItems,
        label,
        progress,
        indeterminate,
      }) => {
        if (operationId !== activeOperationId) {
          return;
        }
        const overallPct =
          ((itemIndex + progress / 100) / Math.max(1, totalItems)) * 100;
        getElement('status').textContent =
          `[${itemIndex + 1}/${totalItems}] ${label}`;
        updateProgress(Math.min(95, overallPct), indeterminate);
        setPressPosition(Math.min(0.95, progress / 100));
      },
      onItemSettled: async () => {
        if (operationId !== activeOperationId) {
          return;
        }
        setPressPosition(1);
        if (!prefersReducedMotion) {
          await waitForSettling(180, signal).catch(() => {});
        }
        setPressPosition(0);
      },
    });

    if (operationId !== activeOperationId) {
      return;
    }

    setPressPosition(0);
    updateProgress(signal.aborted ? 0 : 100, false);
    const summary = batchQueue.getAggregateSummary();
    getElement('status').textContent = signal.aborted
      ? 'BATCH CANCELLED'
      : `BATCH COMPLETE (${summary.completedCount + summary.unchangedCount}/${summary.totalFiles})`;
    setCompressionUiState(false);
    syncBatchUi();
  } catch (error) {
    setPressPosition(0);
    setCompressionUiState(false);
    syncBatchUi();
    if (error?.name !== 'AbortError') {
      showError(error?.message || 'Batch compression failed.');
    }
  }
}

async function startCompression() {
  if (isCompressing) {
    return;
  }

  if (batchMode) {
    await startBatchCompression();
    return;
  }

  if (!selectedFile || !selectedFileBytes || !selectedKind) {
    showError('Select a valid PDF or image file, or try the sample PDF first.');
    return;
  }

  cancelActiveOperation();
  const operationId = activeOperationId;
  activeAbortController = new AbortController();
  const { signal } = activeAbortController;

  resetPressState();
  showError('');
  compressionResult = null;
  setCompressionUiState(true);

  const startButton = getElement('start');
  startButton.firstElementChild.textContent = 'Compressing…';
  getElement('status').textContent = 'PRESS ENGAGED';

  const mode = getSelectedMode();
  const prefersReducedMotion = matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  try {
    const onProgress = ({ label, progress, indeterminate }) => {
      if (operationId !== activeOperationId) {
        return;
      }
      getElement('status').textContent = label;
      updateProgress(Math.min(95, progress), indeterminate);
      setPressPosition(Math.min(0.92, progress / 100));
    };

    let result;
    if (selectedKind === 'image') {
      const qualityVal = useCustomQuality
        ? Number(getElement('custom-quality').value) / 100
        : null;
      const resizeEnabled = getElement('enable-resize').checked;
      const maxDim = resizeEnabled
        ? Number(getElement('max-dimension').value)
        : null;

      result = await compressImage(selectedFile, selectedFileBytes, {
        mode,
        customQuality: qualityVal,
        targetSizeBytes: getTargetSizeBytes(),
        maxDimension: Number.isFinite(maxDim) && maxDim >= 64 ? maxDim : null,
        onProgress,
        signal,
      });
    } else {
      result = await compressPdf(selectedFileBytes, mode, {
        onProgress,
        signal,
      });
    }

    if (operationId !== activeOperationId) {
      return;
    }

    setPressPosition(1);
    updateProgress(100, false);

    const minSettle =
      selectedKind === 'image'
        ? IMAGE_LIMITS.minSettlingDurationMs
        : PDF_LIMITS.minSettlingDurationMs;
    const remainingSettlingMs = prefersReducedMotion
      ? 0
      : Math.max(0, minSettle - result.durationMs);
    await waitForSettling(remainingSettlingMs, signal);

    if (operationId !== activeOperationId) {
      return;
    }

    compressionResult = result;
    getElement('status').textContent = result.wasReduced
      ? 'PRESS COMPLETE'
      : 'NO FURTHER REDUCTION';
    renderResultMetrics(result);
    setCompressionUiState(false);
  } catch (error) {
    if (error?.name === 'AbortError' || operationId !== activeOperationId) {
      resetPressState();
      return;
    }

    resetPressState();
    showError(error?.message || 'Compression failed.');
  }
}

function handleDownload() {
  if (isCompressing || !compressionResult || !selectedFile) {
    return;
  }

  const downloadButton = getElement('download');
  downloadButton.disabled = true;

  try {
    const mimeType =
      compressionResult.kind === 'image'
        ? compressionResult.mimeType
        : 'application/pdf';
    const blob = createFileBlob(compressionResult.bytes, mimeType);
    const filename = compressionResult.wasReduced
      ? compressionResult.kind === 'image'
        ? buildCompressedImageFilename(
            selectedFile.name,
            compressionResult.extension
          )
        : buildCompressedFilename(selectedFile.name)
      : selectedFile.name;

    triggerFileDownload(blob, filename);
  } catch (error) {
    showError(error?.message || 'Unable to download compressed file.');
  } finally {
    setTimeout(() => {
      downloadButton.disabled = false;
    }, 350);
  }
}

async function handleBatchZipDownload() {
  if (isCompressing) {
    return;
  }

  const zipBtn = getElement('batch-download-zip');
  zipBtn.disabled = true;
  zipAbortController = new AbortController();
  showError('');

  try {
    const archive = await buildBatchZip(batchQueue.getItems(), {
      signal: zipAbortController.signal,
      onProgress: ({ label, progress }) => {
        getElement('status').textContent = label;
        updateProgress(progress, false);
      },
    });
    lastZipInfo = archive;
    syncBatchUi();
    updateProgress(100, false);
    getElement('status').textContent = 'ZIP READY';
    triggerFileDownload(archive.blob, BATCH_LIMITS.zipFilename);
  } catch (error) {
    if (error?.name !== 'AbortError') {
      showError(error?.message || 'Unable to create ZIP archive.');
    }
  } finally {
    zipAbortController = null;
    zipBtn.disabled = false;
  }
}

// ============================================================================
// Event Listeners
// ============================================================================

const dropZone = getElement('drop');
const fileInput = getElement('file');

dropZone.onclick = () => {
  if (!isCompressing) {
    fileInput.click();
  }
};

fileInput.onchange = (event) => {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  selectBrowserFiles(files);
};

dropZone.ondragover = (event) => {
  event.preventDefault();
  if (!isCompressing) {
    dropZone.classList.add('drag');
  }
};

dropZone.ondragleave = () => {
  dropZone.classList.remove('drag');
};

dropZone.ondrop = (event) => {
  event.preventDefault();
  dropZone.classList.remove('drag');
  if (!isCompressing) {
    selectBrowserFiles(event.dataTransfer.files);
  }
};

getElement('sample').onclick = () => {
  if (!isCompressing) {
    loadSamplePdf();
  }
};

getElement('batch-toggle').onclick = () => {
  if (isCompressing) {
    return;
  }
  if (batchMode) {
    resetWorkspace();
  } else {
    const existing = selectedFile ? [selectedFile] : [];
    enterBatchMode(existing);
  }
};

getElement('cancel').onclick = () => {
  cancelActiveOperation();
  if (batchMode) {
    setPressPosition(0);
    setCompressionUiState(false);
    getElement('status').textContent = 'BATCH CANCELLED';
    syncBatchUi();
    return;
  }
  resetPressState();
  if (selectedFile && (selectedPageCount > 0 || selectedImageInfo)) {
    getElement('status').textContent = 'COMPRESSION CANCELLED';
  }
};

getElement('reset').onclick = resetWorkspace;

getElement('batch-clear').onclick = () => {
  if (!isCompressing) {
    resetWorkspace();
  }
};

getElement('batch-retry-failed').onclick = () => {
  if (!isCompressing) {
    batchQueue.retryAllFailed();
    lastZipInfo = null;
    syncBatchUi();
  }
};

getElement('batch-download-zip').onclick = handleBatchZipDownload;

document.querySelectorAll('[name=mode]').forEach((input) => {
  input.onchange = () => {
    useCustomQuality = false;
    batchQueue.setGlobalPreset(input.value);
    syncImageOptionsVisibility();
    updatePresetDescription();
    updateWarnings();
    if (batchMode) {
      syncBatchUi();
    }
  };
});

getElement('custom-quality').oninput = (event) => {
  useCustomQuality = true;
  getElement('custom-quality-value').textContent = `${event.target.value}%`;
};

getElement('target-size').onchange = (event) => {
  getElement('custom-target-row').hidden = event.target.value !== 'custom';
};

getElement('enable-resize').onchange = (event) => {
  getElement('max-dimension').disabled = !event.target.checked;
};

getElement('start').onclick = startCompression;
getElement('download').onclick = handleDownload;

getElement('about').onclick = () => {
  openDialog(
    'Less space. More room.',
    'A local-first PDF, image, and batch compression utility. All parsing, ' +
      'rendering, compression, and ZIP packaging run directly in your browser. Files are never uploaded.'
  );
};

window.addEventListener('pagehide', () => {
  cancelActiveOperation();
  clearImagePreview();
});

updatePresetDescription();
updateWarnings();
syncBatchUi();
