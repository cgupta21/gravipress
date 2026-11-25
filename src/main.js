import {
  COMPRESSION_PRESETS,
  PDF_LIMITS,
  UNSUPPORTED_FORMAT_PATTERN,
} from './config/compression-presets.js';
import { IMAGE_LIMITS, IMAGE_PRESETS } from './config/image-presets.js';
import { compressImage } from './engines/image-compressor.js';
import { renderImagePreview } from './engines/image-preview.js';
import { compressPdf } from './engines/pdf-compressor.js';
import {
  generateSamplePdfBytes,
  renderPdfFirstPagePreview,
} from './engines/pdf-preview.js';
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
let selectedKind = null; // 'pdf' | 'image'
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

  if (selectedKind !== 'image') {
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
  if (selectedKind !== 'image') {
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
    startButton.firstElementChild.textContent =
      selectedKind === 'image'
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
// File Selection & Cancellation
// ============================================================================

function cancelActiveOperation() {
  activeOperationId += 1;
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
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

async function selectBrowserFile(file) {
  if (!file) {
    return;
  }

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

  getElement('file').value = '';
  getElement('filelabel').textContent = 'Drop your PDF or image here';
  getElement('filesub').textContent = 'or click to browse your device';
  getElement('filename').textContent = 'Awaiting file';
  getElement('filemeta').hidden = true;
  getElement('filemeta').textContent = '';
  getElement('paperhead').textContent = 'DOCUMENT 001';
  syncImageOptionsVisibility();
  updatePresetDescription();
  updateWarnings();
  setCompressionUiState(false);
  showError('');
}

// ============================================================================
// Compression Workflow
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

async function startCompression() {
  if (isCompressing) {
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
  const file = event.target.files[0];
  event.target.value = '';
  selectBrowserFile(file);
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
    selectBrowserFile(event.dataTransfer.files[0]);
  }
};

getElement('sample').onclick = () => {
  if (!isCompressing) {
    loadSamplePdf();
  }
};

getElement('cancel').onclick = () => {
  cancelActiveOperation();
  resetPressState();
  if (selectedFile && (selectedPageCount > 0 || selectedImageInfo)) {
    getElement('status').textContent = 'COMPRESSION CANCELLED';
  }
};

getElement('reset').onclick = resetWorkspace;

document.querySelectorAll('[name=mode]').forEach((input) => {
  input.onchange = () => {
    useCustomQuality = false;
    syncImageOptionsVisibility();
    updatePresetDescription();
    updateWarnings();
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
    'A local-first PDF and image compression utility. All parsing, ' +
      'rendering, and compression run directly in your browser. Files are never uploaded.'
  );
};

window.addEventListener('pagehide', () => {
  cancelActiveOperation();
  clearImagePreview();
});

updatePresetDescription();
updateWarnings();
