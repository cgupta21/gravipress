// ============================================================================
// Constants & Configuration
// ============================================================================

const COMPRESSION_MODES = {
  Light: 'Gentle pressure. Prioritize quality.',
  Balanced: 'A balance between quality and file size.',
  Maximum: 'Maximum pressure. Quality may decrease.',
};

const ALLOWED_FILE_PATTERN = /\.(pdf|jpe?g|png|webp|mp4|mp3|zip)$/i;
const IMAGE_FILE_PATTERN = /\.(jpe?g|png|webp)$/i;

const BYTES_PER_KILOBYTE = 1024;
const BYTES_PER_MEGABYTE = 1048576;

const PRESS_DURATION_MS = 1800;
const REDUCED_MOTION_DURATION_MS = 1;

const SAMPLE_DOCUMENT = {
  name: 'sample-document.pdf',
  size: 0,
};

// ============================================================================
// State
// ============================================================================

let selectedFile = null;
let previewObjectUrl = null;
let animationFrameId = 0;

// ============================================================================
// DOM Helpers
// ============================================================================

function getElement(id) {
  return document.getElementById(id);
}

function updateProgress(percentage) {
  const progressBar = getElement('progress');
  progressBar.firstElementChild.style.width = `${percentage}%`;
  progressBar.setAttribute('aria-valuenow', String(Math.round(percentage)));
}

function showError(message) {
  const errorElement = getElement('error');
  errorElement.textContent = message;
  errorElement.hidden = !message;
}

function openDialog(title, text) {
  getElement('dialog-title').textContent = title;
  getElement('dialog-text').textContent = text;
  getElement('dialog').showModal();
}

// ============================================================================
// File & Preview Management
// ============================================================================

function formatFileSize(bytes) {
  if (bytes >= BYTES_PER_MEGABYTE) {
    return `${(bytes / BYTES_PER_MEGABYTE).toFixed(2)} MB`;
  }
  return `${(bytes / BYTES_PER_KILOBYTE).toFixed(1)} KB`;
}

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

function stopPressAnimation() {
  cancelAnimationFrame(animationFrameId);
  getElement('machine').classList.remove('pressed');
  getElement('result').hidden = true;
  getElement('status').textContent = 'SYSTEM READY';

  const startButton = getElement('start');
  startButton.disabled = false;
  startButton.firstElementChild.textContent = 'Compress file';

  updateProgress(0);
}

function selectFile(file, isSample = false) {
  if (!file) {
    return;
  }

  if (!ALLOWED_FILE_PATTERN.test(file.name)) {
    showError('Choose a supported file format.');
    return;
  }

  stopPressAnimation();
  clearImagePreview();
  showError('');

  selectedFile = file;
  getElement('filename').textContent = file.name;
  getElement('filelabel').textContent = file.name;
  getElement('filesub').textContent = isSample
    ? 'Sample document • animation demo'
    : formatFileSize(file.size);

  const fileExtension = file.name.split('.').pop().toUpperCase();
  getElement('paperhead').textContent = `${fileExtension} / 001`;

  if (!isSample && IMAGE_FILE_PATTERN.test(file.name)) {
    previewObjectUrl = URL.createObjectURL(file);
    const previewImage = getElement('image-preview');
    previewImage.src = previewObjectUrl;
    previewImage.hidden = false;
    getElement('paper').querySelector('.document').hidden = true;
    previewImage.onerror = () => clearImagePreview();
  }
}

function resetWorkspace() {
  stopPressAnimation();
  clearImagePreview();
  selectedFile = null;

  getElement('file').value = '';
  getElement('filelabel').textContent = 'Drop your file here';
  getElement('filesub').textContent = 'or click to browse your device';
  getElement('filename').textContent = 'Awaiting file';
  getElement('paperhead').textContent = 'DOCUMENT 001';
  showError('');
}

// ============================================================================
// Press Animation
// ============================================================================

function startCompression() {
  if (!selectedFile) {
    showError('Select a file or try the sample first.');
    return;
  }

  stopPressAnimation();
  showError('');

  const startButton = getElement('start');
  startButton.disabled = true;
  startButton.firstElementChild.textContent = 'Compressing…';
  getElement('status').textContent = 'PRESS ENGAGED';

  const prefersReducedMotion = matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;
  const duration = prefersReducedMotion
    ? REDUCED_MOTION_DURATION_MS
    : PRESS_DURATION_MS;

  const machine = getElement('machine');
  machine.style.setProperty('--duration', `${duration}ms`);
  // Trigger reflow so re-adding the "pressed" class restarts CSS animations.
  void machine.offsetWidth;
  machine.classList.add('pressed');

  let animationStartTime;

  function tick(timestamp) {
    animationStartTime ??= timestamp;
    const elapsed = timestamp - animationStartTime;
    const progressPercent = Math.min(100, (elapsed / duration) * 100);
    updateProgress(progressPercent);

    if (progressPercent < 100) {
      animationFrameId = requestAnimationFrame(tick);
    } else {
      getElement('status').textContent = 'PRESS COMPLETE';
      getElement('result').hidden = false;
      startButton.firstElementChild.textContent = 'Press complete';
      startButton.disabled = false;
    }
  }

  animationFrameId = requestAnimationFrame(tick);
}

// ============================================================================
// Event Listeners
// ============================================================================

const dropZone = getElement('drop');
const fileInput = getElement('file');

dropZone.onclick = () => fileInput.click();

fileInput.onchange = (event) => {
  selectFile(event.target.files[0]);
};

dropZone.ondragover = (event) => {
  event.preventDefault();
  dropZone.classList.add('drag');
};

dropZone.ondragleave = () => {
  dropZone.classList.remove('drag');
};

dropZone.ondrop = (event) => {
  event.preventDefault();
  dropZone.classList.remove('drag');
  selectFile(event.dataTransfer.files[0]);
};

getElement('sample').onclick = () => selectFile(SAMPLE_DOCUMENT, true);
getElement('reset').onclick = resetWorkspace;

document.querySelectorAll('[name=mode]').forEach((input) => {
  input.onchange = () => {
    getElement('quality').textContent = COMPRESSION_MODES[input.value];
  };
});

getElement('start').onclick = startCompression;

getElement('about').onclick = () => {
  openDialog(
    'Less space. More room.',
    'A local-first file compression interface. This UI prototype does not ' +
      'upload or compress files. No accounts or database are required.'
  );
};

getElement('download').onclick = () => {
  openDialog(
    'Design preview',
    'The press animation is complete. Actual compressed-file downloads ' +
      'will be connected when the compression engine is implemented.'
  );
};

window.addEventListener('pagehide', () => {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
  }
});
