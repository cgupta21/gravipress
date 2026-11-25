import {
  COMPRESSION_PRESETS,
  PDF_LIMITS,
} from './config/compression-presets.js';
import { compressPdf } from './engines/pdf-compressor.js';
import {
  generateSamplePdfBytes,
  renderPdfFirstPagePreview,
} from './engines/pdf-preview.js';
import { createPdfBlob, triggerPdfDownload } from './utils/download-utils.js';
import {
  buildCompressedFilename,
  detectDigitalSignature,
  formatFileSize,
  validatePdfFile,
} from './utils/file-utils.js';

// ============================================================================
// State
// ============================================================================

let selectedFile = null;
let selectedFileBytes = null;
let selectedPageCount = 0;
let hasDigitalSignature = false;
let previewObjectUrl = null;
let compressionResult = null;
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

function updateWarnings() {
  const preset = COMPRESSION_PRESETS[getSelectedMode()];
  const warnings = [];

  if (preset?.warning) {
    warnings.push(preset.warning);
  }

  if (hasDigitalSignature) {
    warnings.push(
      'Digital signature detected: processing this PDF can invalidate existing signatures.'
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
    startButton.firstElementChild.textContent = 'Compress PDF';
  }
}

// ============================================================================
// Preview & Results Rendering
// ============================================================================

function clearImagePreview() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
  }
  previewObjectUrl = null;

  const previewImage = getElement('image-preview');
  previewImage.hidden = true;
  previewImage.removeAttribute('src');

  getElement('paper').querySelector('.document').hidden = false;
}

function resetPressState() {
  setPressPosition(0);
  updateProgress(0, false);
  getElement('result').hidden = true;
  getElement('metrics').innerHTML = '';
  getElement('status').textContent = 'SYSTEM READY';
  setCompressionUiState(false);
}

function renderResultMetrics(result) {
  const metricsElement = getElement('metrics');
  metricsElement.innerHTML = '';

  const reductionText = result.wasReduced
    ? `${formatFileSize(result.bytesSaved)} (${result.percentageSaved.toFixed(1)}%)`
    : '0 B (0.0%)';

  const entries = [
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

  if (result.wasReduced) {
    titleElement.textContent = 'Press complete.';
    summaryElement.textContent = `Reduced by ${result.percentageSaved.toFixed(1)}% (${formatFileSize(result.bytesSaved)} saved) via ${result.methodUsed}.`;
    downloadButton.firstChild.textContent = 'Download compressed PDF ';
  } else {
    titleElement.textContent = 'No reduction possible.';
    summaryElement.textContent =
      'No smaller acceptable output could be produced. Original file retained.';
    downloadButton.firstChild.textContent = 'Download original PDF ';
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

  const validation = validatePdfFile(file, bytes);
  if (!validation.valid) {
    selectedFile = null;
    selectedFileBytes = null;
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
    selectedPageCount = 0;
    hasDigitalSignature = false;
    updateWarnings();
    getElement('filemeta').hidden = true;
    getElement('filename').textContent = 'Awaiting PDF';
    getElement('status').textContent = 'SYSTEM READY';
    showError(error.message || 'Unable to load PDF preview.');
  }
}

async function selectBrowserFile(file) {
  if (!file) {
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    await handleSelectedPdf(file, bytes, false);
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
  selectedPageCount = 0;
  hasDigitalSignature = false;
  compressionResult = null;

  getElement('file').value = '';
  getElement('filelabel').textContent = 'Drop your PDF here';
  getElement('filesub').textContent = 'or click to browse your device';
  getElement('filename').textContent = 'Awaiting PDF';
  getElement('filemeta').hidden = true;
  getElement('filemeta').textContent = '';
  getElement('paperhead').textContent = 'DOCUMENT 001';
  updateWarnings();
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

  if (!selectedFile || !selectedFileBytes) {
    showError('Select a valid PDF file or try the sample PDF first.');
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
    const result = await compressPdf(selectedFileBytes, mode, {
      signal,
      onProgress: ({ label, progress, indeterminate }) => {
        if (operationId !== activeOperationId) {
          return;
        }
        getElement('status').textContent = label;
        updateProgress(Math.min(95, progress), indeterminate);
        setPressPosition(Math.min(0.92, progress / 100));
      },
    });

    if (operationId !== activeOperationId) {
      return;
    }

    setPressPosition(1);
    updateProgress(100, false);

    const remainingSettlingMs = prefersReducedMotion
      ? 0
      : Math.max(0, PDF_LIMITS.minSettlingDurationMs - result.durationMs);
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
    startButton.firstElementChild.textContent = 'Compress PDF';
  } catch (error) {
    if (error?.name === 'AbortError' || operationId !== activeOperationId) {
      resetPressState();
      return;
    }

    resetPressState();
    showError(error?.message || 'PDF compression failed.');
  }
}

function handleDownload() {
  if (isCompressing || !compressionResult || !selectedFile) {
    return;
  }

  const downloadButton = getElement('download');
  downloadButton.disabled = true;

  try {
    const blob = createPdfBlob(compressionResult.bytes);
    const filename = compressionResult.wasReduced
      ? buildCompressedFilename(selectedFile.name)
      : selectedFile.name;
    triggerPdfDownload(blob, filename);
  } catch (error) {
    showError(error?.message || 'Unable to download compressed PDF.');
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
  if (selectedFile && selectedPageCount > 0) {
    getElement('status').textContent = 'COMPRESSION CANCELLED';
  }
};

getElement('reset').onclick = resetWorkspace;

document.querySelectorAll('[name=mode]').forEach((input) => {
  input.onchange = () => {
    const preset = COMPRESSION_PRESETS[input.value];
    if (preset) {
      getElement('quality').textContent = preset.description;
      updateWarnings();
    }
  };
});

getElement('start').onclick = startCompression;
getElement('download').onclick = handleDownload;

getElement('about').onclick = () => {
  openDialog(
    'Less space. More room.',
    'A local-first PDF compression utility. All PDF parsing, rendering, ' +
      'and compression run directly in your browser. Files are never uploaded.'
  );
};

window.addEventListener('pagehide', () => {
  cancelActiveOperation();
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
  }
});

updateWarnings();
