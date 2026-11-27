import {
  renderArchiveFileList,
  renderArchiveResult,
} from './components/archive-workspace.js';
import {
  renderBatchQueue,
  renderBatchSummary,
} from './components/batch-workspace.js';
import {
  isAudioFile,
  isVideoFile,
  loadNativeMediaEngine,
  syncMediaCapabilityControls,
} from './components/media-workspace.js';
import { ARCHIVE_LIMITS, ARCHIVE_PRESETS } from './config/archive-presets.js';
import { BATCH_LIMITS, QUEUE_STATUS } from './config/batch-limits.js';
import {
  COMPRESSION_PRESETS,
  PDF_LIMITS,
  UNSUPPORTED_FORMAT_PATTERN,
} from './config/compression-presets.js';
import { IMAGE_LIMITS, IMAGE_PRESETS } from './config/image-presets.js';
import { buildBatchZip } from './engines/archive-builder.js';
import { runBatchQueue } from './engines/batch-compressor.js';
import {
  extractDroppedItems,
  isFolderPickerSupported,
  normalizeSelectedFiles,
} from './engines/folder-compressor.js';
import { compressFilesToZip } from './engines/general-compressor.js';
import { compressFileToGzip } from './engines/gzip-compressor.js';
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
let isPreparingOffline = false;
let isApplyingUpdate = false;

function isOperationActive() {
  return Boolean(isCompressing || isPreparingOffline || isApplyingUpdate);
}

let batchMode = false;
const batchQueue = createProcessingQueue('Balanced');
const itemAbortControllers = new Map();
let lastZipInfo = null;
let zipAbortController = null;

let archiveMode = false;
let archiveItems = [];
let archiveResult = null;

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
  if (selectedKind === 'video') {
    getElement('quality').textContent =
      'Compresses video to VP8/VP9 WebM using native WebCodecs with Opus audio when supported.';
  } else if (selectedKind === 'audio') {
    getElement('quality').textContent =
      'Compresses audio to Opus (WebM/OGG) or converts to uncompressed 16-bit PCM WAV.';
  } else if (selectedKind === 'image') {
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
  } else if (selectedKind === 'video' || selectedKind === 'audio') {
    // Multimedia modes do not use PDF rasterization warnings.
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
    startButton.firstElementChild.textContent = archiveMode
      ? 'Create archive'
      : batchMode
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
      : result.kind === 'video' || result.kind === 'audio'
        ? [
            ['ORIGINAL', formatFileSize(result.originalSize)],
            ['OUTPUT', formatFileSize(result.compressedSize)],
            ['SAVED', reductionText],
            ['TIME', `${result.durationMs} ms`],
            ['FORMAT', result.format],
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
  const isMedia = result.kind === 'video' || result.kind === 'audio';
  const extLabel =
    result.kind === 'image' || isMedia ? result.format : 'PDF';

  if (isMedia) {
    titleElement.textContent = 'Press complete.';
    summaryElement.textContent = result.wasReduced
      ? `Reduced by ${pctText} (${formatFileSize(result.bytesSaved)} saved) via ${result.methodUsed}.`
      : `Output generated (${formatFileSize(result.compressedSize)}) via ${result.methodUsed}.`;
    downloadButton.firstChild.textContent = `Download ${extLabel} `;
  } else if (result.wasReduced) {
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
    archiveMode = false;
    archiveItems = [];
    archiveResult = null;
    batchMode = true;
    syncArchiveUi();
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
// Archive & Folder Mode Integration
// ============================================================================

function syncArchiveUi() {
  const section = getElement('archive-section');
  section.hidden = !archiveMode;
  getElement('archive-toggle').textContent = archiveMode
    ? 'Exit archive mode'
    : 'ZIP / GZ archive';

  if (!archiveMode) {
    return;
  }

  const totalBytes = archiveItems.reduce(
    (sum, item) => sum + (item.file?.size || 0),
    0
  );
  getElement('archive-count').textContent =
    `${archiveItems.length} ${archiveItems.length === 1 ? 'FILE' : 'FILES'} • ${formatFileSize(totalBytes)}`;

  const formatSelect = getElement('archive-format');
  const gzipOption = formatSelect.querySelector('option[value="gzip"]');
  const hasFolderPath = archiveItems.some((item) =>
    (item.relativePath || '').includes('/')
  );
  const canUseGzip = archiveItems.length === 1 && !hasFolderPath;
  gzipOption.disabled = !canUseGzip;
  if (!canUseGzip && formatSelect.value === 'gzip') {
    formatSelect.value = 'zip';
  }

  getElement('archive-name-row').hidden = formatSelect.value === 'gzip';
  getElement('archive-pick-folder').hidden = !isFolderPickerSupported(
    getElement('archive-folder-input')
  );

  renderArchiveFileList(
    getElement('archive-list'),
    archiveItems,
    (removeIdx) => {
      archiveItems.splice(removeIdx, 1);
      archiveResult = null;
      syncArchiveUi();
    },
    isCompressing
  );
}

function enterArchiveMode(initialEntries = []) {
  if (!archiveMode) {
    cancelActiveOperation();
    resetPressState();
    clearImagePreview();
    selectedFile = null;
    selectedFileBytes = null;
    selectedKind = 'archive';
    batchMode = false;
    batchQueue.clear();
    archiveMode = true;
    syncBatchUi();
    syncImageOptionsVisibility();
    updateWarnings();
  }

  if (initialEntries.length > 0) {
    archiveItems = [...archiveItems, ...initialEntries];
    archiveResult = null;
    if (archiveItems.length > ARCHIVE_LIMITS.maxFiles) {
      showError(
        `Archive supports up to ${ARCHIVE_LIMITS.maxFiles} files (${archiveItems.length} selected).`
      );
      archiveItems = archiveItems.slice(0, ARCHIVE_LIMITS.maxFiles);
    } else {
      showError('');
    }
    const firstRoot = (
      archiveItems[0]?.relativePath ||
      archiveItems[0]?.file?.name ||
      ''
    ).split('/')[0];
    getElement('filename').textContent =
      archiveItems.length === 1
        ? archiveItems[0].file.name
        : `${firstRoot || 'Archive'} (${archiveItems.length} files)`;
    getElement('paperhead').textContent = 'ARCHIVE / 001';
  }

  setCompressionUiState(false);
  syncArchiveUi();
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

async function handleSelectedVideo(file) {
  resetWorkspace();
  selectedFile = file;
  selectedFileBytes = new Uint8Array(await file.arrayBuffer());
  selectedKind = 'video';

  getElement('filelabel').textContent = file.name;
  getElement('filesub').textContent = `${formatFileSize(file.size)} — Video ready`;
  getElement('filename').textContent = file.name;
  getElement('filemeta').hidden = false;
  getElement('filemeta').textContent = `${formatFileSize(file.size)} · VIDEO`;
  getElement('paperhead').textContent = 'VIDEO INPUT';
  getElement('video-options').hidden = false;
  getElement('audio-options').hidden = true;
  getElement('status').textContent = 'VIDEO READY';
  updatePresetDescription();
  updateWarnings();

  await syncMediaCapabilityControls({
    videoCodecSelect: getElement('video-codec'),
    onUnsupported: (msg) => showError(msg),
  });
}

async function handleSelectedAudio(file) {
  resetWorkspace();
  selectedFile = file;
  selectedFileBytes = new Uint8Array(await file.arrayBuffer());
  selectedKind = 'audio';

  getElement('filelabel').textContent = file.name;
  getElement('filesub').textContent = `${formatFileSize(file.size)} — Audio ready`;
  getElement('filename').textContent = file.name;
  getElement('filemeta').hidden = false;
  getElement('filemeta').textContent = `${formatFileSize(file.size)} · AUDIO`;
  getElement('paperhead').textContent = 'AUDIO INPUT';
  getElement('audio-options').hidden = false;
  getElement('video-options').hidden = true;
  getElement('status').textContent = 'AUDIO READY';
  updatePresetDescription();
  updateWarnings();

  await syncMediaCapabilityControls({
    audioFormatSelect: getElement('audio-format'),
    onUnsupported: (msg) => showError(msg),
  });
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
    if (file.size === 0) {
      resetWorkspace();
      showError('The selected file is empty (0 bytes).');
      return;
    }

    if (isVideoFile(file)) {
      await handleSelectedVideo(file);
      return;
    }

    if (isAudioFile(file)) {
      await handleSelectedAudio(file);
      return;
    }

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

  archiveMode = false;
  archiveItems = [];
  archiveResult = null;

  getElement('file').value = '';
  getElement('filelabel').textContent = 'Drop your PDF, image, or batch here';
  getElement('filesub').textContent =
    'or click to browse your device (up to 20 files)';
  getElement('filename').textContent = 'Awaiting file';
  getElement('filemeta').hidden = true;
  getElement('filemeta').textContent = '';
  getElement('paperhead').textContent = 'DOCUMENT 001';
  getElement('video-options').hidden = true;
  getElement('audio-options').hidden = true;
  syncImageOptionsVisibility();
  updatePresetDescription();
  updateWarnings();
  setCompressionUiState(false);
  syncBatchUi();
  syncArchiveUi();
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

async function startArchiveCompression() {
  if (archiveItems.length === 0) {
    showError('Select files or a folder to archive first.');
    return;
  }

  cancelActiveOperation();
  const operationId = activeOperationId;
  activeAbortController = new AbortController();
  const { signal } = activeAbortController;

  resetPressState();
  showError('');
  archiveResult = null;
  setCompressionUiState(true);
  getElement('start').firstElementChild.textContent = 'Archiving…';
  syncArchiveUi();

  const format = getElement('archive-format').value;
  const presetId = getElement('archive-preset').value;
  const archiveName =
    getElement('archive-filename').value.trim() ||
    ARCHIVE_LIMITS.defaultZipName;
  const prefersReducedMotion = matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  try {
    const onProgress = ({ progress, label, indeterminate }) => {
      if (operationId !== activeOperationId) {
        return;
      }
      getElement('status').textContent = label;
      updateProgress(Math.min(95, progress), indeterminate);
      setPressPosition(Math.min(0.92, progress / 100));
    };

    const result =
      format === 'gzip'
        ? await compressFileToGzip(archiveItems[0].file, {
            presetId,
            signal,
            onProgress,
          })
        : await compressFilesToZip(archiveItems, {
            presetId,
            archiveName,
            signal,
            onProgress,
          });

    if (operationId !== activeOperationId) {
      return;
    }

    setPressPosition(1);
    updateProgress(100, false);

    if (!prefersReducedMotion) {
      await waitForSettling(Math.max(0, 350 - result.durationMs), signal).catch(
        () => {}
      );
    }

    if (operationId !== activeOperationId) {
      return;
    }

    archiveResult = result;
    getElement('status').textContent = 'ARCHIVE COMPLETE';
    renderArchiveResult(result, {
      metricsElement: getElement('metrics'),
      titleElement: getElement('result-title'),
      summaryElement: getElement('result-summary'),
      downloadButton: getElement('download'),
    });
    clearCompressedPreview();
    getElement('result').hidden = false;
    setCompressionUiState(false);
    syncArchiveUi();
  } catch (error) {
    if (error?.name === 'AbortError' || operationId !== activeOperationId) {
      resetPressState();
      syncArchiveUi();
      return;
    }
    resetPressState();
    syncArchiveUi();
    showError(error?.message || 'Archive compression failed.');
  }
}

async function startCompression() {
  if (isCompressing || isApplyingUpdate) {
    return;
  }

  if (archiveMode) {
    await startArchiveCompression();
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

  if (selectedKind === 'video' || selectedKind === 'audio') {
    const t0 = performance.now();
    try {
      const engine = await loadNativeMediaEngine();
      const onProgress = (p) => {
        if (operationId !== activeOperationId) return;
        const pct = Math.min(99, Math.max(1, Math.round(p * 100)));
        updateProgress(pct);
        setPressPosition(0.15 + pct * 0.007);
      };

      let out;
      let ext;
      let methodLabel;
      if (selectedKind === 'video') {
        const codec = getElement('video-codec').value;
        const bitrate = Number(getElement('video-bitrate').value);
        const maxWidth = Number(getElement('video-max-width').value);
        out = await engine.compressVideoToWebM(selectedFile, {
          codec,
          bitrate,
          maxWidth,
          signal,
          onProgress,
        });
        ext = 'webm';
        methodLabel = `${codec.toUpperCase()} WebM (native WebCodecs)`;
      } else {
        const format = getElement('audio-format').value;
        const bitrate = Number(getElement('audio-bitrate').value);
        const sampleRate = Number(getElement('audio-sample-rate').value);
        const numberOfChannels = Number(getElement('audio-channels').value);
        out = await engine.compressAudio(selectedFile, {
          format,
          bitrate,
          sampleRate,
          numberOfChannels,
          signal,
          onProgress,
        });
        ext = format === 'wav' ? 'wav' : format === 'opus-ogg' ? 'ogg' : 'webm';
        methodLabel =
          format === 'wav'
            ? 'PCM WAV (uncompressed conversion)'
            : `Opus (${ext.toUpperCase()})`;
      }

      if (operationId !== activeOperationId) return;
      const baseName = selectedFile.name.replace(/\.[^.]+$/, '');
      const bytesSaved = Math.max(0, selectedFile.size - out.bytes.byteLength);
      const reductionPct =
        selectedFile.size > 0
          ? Number(((bytesSaved / selectedFile.size) * 100).toFixed(1))
          : 0;
      compressionResult = {
        kind: selectedKind,
        bytes: out.bytes,
        mimeType: out.mimeType,
        extension: ext,
        format: ext.toUpperCase(),
        wasReduced: out.bytes.byteLength < selectedFile.size,
        originalSize: selectedFile.size,
        compressedSize: out.bytes.byteLength,
        bytesSaved,
        reductionPct,
        percentageSaved: reductionPct,
        durationMs: Math.round(performance.now() - t0),
        methodUsed: methodLabel,
        outputFilename: `${baseName}-gravipress.${ext}`,
      };
      updateProgress(100);
      setPressPosition(1);
      getElement('status').textContent = 'PRESS COMPLETE';
      renderResultMetrics(compressionResult);
      getElement('result').hidden = false;
    } catch (err) {
      if (operationId !== activeOperationId) return;
      resetPressState();
      showError(err?.message || 'Media processing failed.');
    } finally {
      if (operationId === activeOperationId) {
        setCompressionUiState(false);
        activeAbortController = null;
      }
    }
    return;
  }

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
  if (isCompressing) {
    return;
  }

  if (archiveMode && archiveResult?.blob) {
    triggerFileDownload(archiveResult.blob, archiveResult.outputFilename);
    return;
  }

  if (!compressionResult || !selectedFile) {
    return;
  }

  const downloadButton = getElement('download');
  downloadButton.disabled = true;

  try {
    const isMedia =
      compressionResult.kind === 'video' || compressionResult.kind === 'audio';
    const mimeType =
      isMedia || compressionResult.kind === 'image'
        ? compressionResult.mimeType
        : 'application/pdf';
    const blob = createFileBlob(compressionResult.bytes, mimeType);
    const filename = isMedia
      ? compressionResult.outputFilename
      : compressionResult.wasReduced
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

dropZone.ondrop = async (event) => {
  event.preventDefault();
  dropZone.classList.remove('drag');
  if (isCompressing) {
    return;
  }

  const droppedEntries = await extractDroppedItems(event.dataTransfer).catch(
    () => null
  );
  if (
    archiveMode ||
    (droppedEntries &&
      droppedEntries.some((entry) => (entry.relativePath || '').includes('/')))
  ) {
    enterArchiveMode(
      droppedEntries || normalizeSelectedFiles(event.dataTransfer.files)
    );
    return;
  }

  selectBrowserFiles(event.dataTransfer.files);
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

getElement('archive-toggle').onclick = () => {
  if (isCompressing) {
    return;
  }
  if (archiveMode) {
    resetWorkspace();
  } else {
    enterArchiveMode([]);
  }
};

getElement('archive-pick-files').onclick = () => {
  if (!isCompressing) {
    getElement('archive-files-input').click();
  }
};

getElement('archive-pick-folder').onclick = () => {
  if (!isCompressing) {
    getElement('archive-folder-input').click();
  }
};

getElement('archive-files-input').onchange = (event) => {
  const entries = normalizeSelectedFiles(event.target.files);
  event.target.value = '';
  enterArchiveMode(entries);
};

getElement('archive-folder-input').onchange = (event) => {
  const entries = normalizeSelectedFiles(event.target.files);
  event.target.value = '';
  enterArchiveMode(entries);
};

getElement('archive-clear').onclick = () => {
  if (!isCompressing) {
    archiveItems = [];
    archiveResult = null;
    resetPressState();
    syncArchiveUi();
  }
};

getElement('archive-format').onchange = () => {
  syncArchiveUi();
};

getElement('cancel').onclick = () => {
  cancelActiveOperation();
  if (archiveMode) {
    setPressPosition(0);
    setCompressionUiState(false);
    getElement('status').textContent = 'ARCHIVE CANCELLED';
    syncArchiveUi();
    return;
  }
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

getElement('audio-format').onchange = (event) => {
  const isWav = event.target.value === 'wav';
  getElement('audio-bitrate').disabled = isWav;
};

getElement('start').onclick = startCompression;
getElement('download').onclick = handleDownload;

getElement('licenses').onclick = () => {
  getElement('licenses-dialog').showModal();
};

getElement('about').onclick = () => {
  openDialog(
    'Less space. More room.',
    'A local-first PDF, image, batch, and ZIP/GZIP archive compression utility. All parsing, ' +
      'rendering, compression, and packaging run directly in your browser. Files are never uploaded.'
  );
};

window.addEventListener('pagehide', () => {
  cancelActiveOperation();
  clearImagePreview();
});

const installButton = getElement('install-app');
let deferredInstallPrompt = null;

function isStandaloneMode() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function isSafariBrowser() {
  const ua = window.navigator.userAgent;
  return (
    /Safari/i.test(ua) &&
    !/Chrome|Chromium|CriOS|Edg|EdgiOS|FxiOS|Firefox|OPR/i.test(ua)
  );
}

if (installButton && !isStandaloneMode()) {
  if (isSafariBrowser()) {
    installButton.hidden = false;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    installButton.hidden = true;
  });

  installButton.onclick = async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (outcome === 'accepted') {
        installButton.hidden = true;
      }
      return;
    }

    if (isSafariBrowser()) {
      const isIOS = /iPad|iPhone|iPod/i.test(window.navigator.userAgent);
      openDialog(
        'Install Gravipress',
        isIOS
          ? 'In Safari, tap the Share button and choose "Add to Home Screen" to install Gravipress.'
          : 'In Safari on macOS, choose File → Add to Dock… (or Share → Add to Dock) to install Gravipress.'
      );
    }
  };
}

if ('serviceWorker' in navigator) {
  const offlineBar = getElement('offline-bar');
  const offlineStatus = getElement('offline-status');
  const offlinePrepareBtn = getElement('offline-prepare');
  const offlineRemoveBtn = getElement('offline-remove');
  const updateAppBtn = getElement('update-app');
  const updateBanner = getElement('update-banner');
  const updateNowBtn = getElement('update-now');

  let swRegistration = null;
  let waitingWorker = null;
  let reloadingForUpdate = false;
  let hasReloadedForUpdate = false;
  let updateApplyTimer = null;
  let lastUpdateCheckAt = 0;
  const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

  const formatMB = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  function setUpdateButtonsBusy(busy) {
    if (updateNowBtn) {
      updateNowBtn.disabled = busy;
      updateNowBtn.textContent = busy ? 'Updating…' : 'Update now';
      updateNowBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    if (updateAppBtn) {
      updateAppBtn.disabled = busy;
      updateAppBtn.textContent = busy ? 'Updating…' : 'Update Available';
      updateAppBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  function showUpdateAvailable(worker) {
    if (!worker || worker.state === 'redundant') return;
    waitingWorker = worker;
    if (updateBanner) updateBanner.hidden = false;
    if (updateAppBtn) updateAppBtn.hidden = false;
    setUpdateButtonsBusy(false);
  }

  function clearUpdateAvailable() {
    waitingWorker = null;
    isApplyingUpdate = false;
    reloadingForUpdate = false;
    if (updateApplyTimer) {
      clearTimeout(updateApplyTimer);
      updateApplyTimer = null;
    }
    if (updateBanner) updateBanner.hidden = true;
    if (updateAppBtn) updateAppBtn.hidden = true;
    setUpdateButtonsBusy(false);
  }

  function applyOfflineStatus(status) {
    if (!offlineBar || !offlineStatus) return;
    offlineBar.hidden = false;
    if (status.ready) {
      offlineStatus.textContent = `Offline Ready (${status.cachedCount}/${status.totalCount} assets)`;
      offlinePrepareBtn.hidden = true;
      offlineRemoveBtn.hidden = false;
    } else if (status.optionalCachedCount > 0) {
      offlineStatus.textContent = `Offline: Partial (${status.cachedCount}/${status.totalCount}, ~${formatMB(status.totalBytes)})`;
      offlinePrepareBtn.textContent = 'Enable Offline Mode';
      offlinePrepareBtn.hidden = false;
      offlineRemoveBtn.hidden = false;
    } else {
      offlineStatus.textContent = `Offline: Not prepared (~${formatMB(status.totalBytes)})`;
      offlinePrepareBtn.textContent = 'Enable Offline Mode';
      offlinePrepareBtn.hidden = false;
      offlineRemoveBtn.hidden = true;
    }
    offlinePrepareBtn.disabled = false;
  }

  function requestOfflineStatus() {
    navigator.serviceWorker.controller?.postMessage({ type: 'GET_OFFLINE_STATUS' });
  }

  function triggerUpdateApply() {
    if (!waitingWorker || waitingWorker.state === 'redundant') {
      clearUpdateAvailable();
      return;
    }
    if (isCompressing || isPreparingOffline) {
      openDialog(
        'Operation in progress',
        'Please wait for the active compression or offline preparation to finish or cancel it before updating.'
      );
      return;
    }
    if (isApplyingUpdate) return;

    isApplyingUpdate = true;
    reloadingForUpdate = true;
    setUpdateButtonsBusy(true);

    if (updateApplyTimer) clearTimeout(updateApplyTimer);
    updateApplyTimer = setTimeout(() => {
      updateApplyTimer = null;
      if (!hasReloadedForUpdate && isApplyingUpdate) {
        isApplyingUpdate = false;
        reloadingForUpdate = false;
        setUpdateButtonsBusy(false);
      }
    }, 5000);

    try {
      waitingWorker.postMessage({ type: 'APPLY_UPDATE' });
    } catch {
      isApplyingUpdate = false;
      reloadingForUpdate = false;
      setUpdateButtonsBusy(false);
    }
  }

  function checkForUpdatesIfDue() {
    if (!swRegistration || isOperationActive() || navigator.onLine === false) return;
    const now = Date.now();
    if (now - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return;
    lastUpdateCheckAt = now;
    swRegistration.update().catch(() => {});
  }

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'OFFLINE_STATUS') {
      isPreparingOffline = false;
      applyOfflineStatus(data);
    } else if (data.type === 'OFFLINE_PROGRESS') {
      isPreparingOffline = true;
      const pct = Math.round((data.cachedCount / Math.max(1, data.totalCount)) * 100);
      offlineStatus.textContent = `Preparing offline… ${pct}% (${data.cachedCount}/${data.totalCount})`;
      offlinePrepareBtn.disabled = true;
      offlineRemoveBtn.hidden = true;
    } else if (data.type === 'OFFLINE_ERROR') {
      isPreparingOffline = false;
      offlineStatus.textContent = `Preparation failed (${data.cachedCount}/${data.totalCount})`;
      offlinePrepareBtn.textContent = 'Retry Preparation';
      offlinePrepareBtn.hidden = false;
      offlinePrepareBtn.disabled = false;
      offlineRemoveBtn.hidden = data.optionalCachedCount === 0;
    } else if (data.type === 'CHECK_BUSY_FOR_UPDATE' && data.requestId) {
      const target = event.source || navigator.serviceWorker.controller;
      target?.postMessage({
        type: 'BUSY_STATUS',
        requestId: data.requestId,
        busy: Boolean(isCompressing || isPreparingOffline),
      });
    } else if (data.type === 'UPDATE_BLOCKED_OTHER_CLIENTS') {
      isApplyingUpdate = false;
      reloadingForUpdate = false;
      if (updateApplyTimer) {
        clearTimeout(updateApplyTimer);
        updateApplyTimer = null;
      }
      setUpdateButtonsBusy(false);
      openDialog(
        'Update Deferred',
        data.busyDetected
          ? 'Another Gravipress tab or window is currently compressing or preparing offline data. Please finish or cancel that operation and close other Gravipress windows before updating.'
          : 'Other Gravipress tabs or windows are open. Please close all other Gravipress tabs and windows, then click Update now again (or reopen the app) to activate the update safely.'
      );
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateApplyTimer) {
      clearTimeout(updateApplyTimer);
      updateApplyTimer = null;
    }
    if (
      reloadingForUpdate &&
      !hasReloadedForUpdate &&
      !isCompressing &&
      !isPreparingOffline
    ) {
      hasReloadedForUpdate = true;
      window.location.reload();
    } else {
      isApplyingUpdate = false;
      reloadingForUpdate = false;
      requestOfflineStatus();
    }
  });

  if (offlinePrepareBtn) {
    offlinePrepareBtn.onclick = () => {
      if (!navigator.serviceWorker.controller || isApplyingUpdate || isCompressing) return;
      isPreparingOffline = true;
      offlinePrepareBtn.disabled = true;
      navigator.serviceWorker.controller.postMessage({ type: 'PREPARE_OFFLINE' });
    };
  }

  if (offlineRemoveBtn) {
    offlineRemoveBtn.onclick = () => {
      if (isApplyingUpdate || isCompressing) return;
      navigator.serviceWorker.controller?.postMessage({ type: 'REMOVE_OFFLINE_DATA' });
    };
  }

  if (updateNowBtn) {
    updateNowBtn.onclick = triggerUpdateApply;
  }

  if (updateAppBtn) {
    updateAppBtn.onclick = triggerUpdateApply;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkForUpdatesIfDue();
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        swRegistration = reg;
        lastUpdateCheckAt = Date.now();
        if (reg.waiting) {
          showUpdateAvailable(reg.waiting);
        }
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateAvailable(installing);
            } else if (installing.state === 'redundant' && installing === waitingWorker) {
              clearUpdateAvailable();
            }
          });
        });
        navigator.serviceWorker.ready.then(() => {
          requestOfflineStatus();
        });
      })
      .catch(() => {});
  });
}

updatePresetDescription();
updateWarnings();
syncBatchUi();
