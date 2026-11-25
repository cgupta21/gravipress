import {
  VIDEO_CONTAINER_FORMATS,
  VIDEO_LIMITS,
  VIDEO_PRESETS,
} from '../config/video-presets.js';
import {
  formatFileSize,
  formatPercentageReduction,
} from '../utils/file-utils.js';

export function renderVideoControls(container, options = {}) {
  const {
    currentPreset = 'Balanced',
    currentFormat = 'mp4',
    onPresetChange = () => {},
    onFormatChange = () => {},
  } = options;

  container.innerHTML = `
    <div class="video-settings-grid">
      <div class="field-group">
        <label for="video-preset" class="field-label">Compression Preset</label>
        <select id="video-preset" class="settings-select">
          <option value="Light" ${currentPreset === 'Light' ? 'selected' : ''}>Light (1080p, CRF 23, preserve FPS)</option>
          <option value="Balanced" ${currentPreset === 'Balanced' ? 'selected' : ''}>Balanced (720p, CRF 28, 30 FPS)</option>
          <option value="Maximum" ${currentPreset === 'Maximum' ? 'selected' : ''}>Maximum (480p, CRF 32, 30 FPS)</option>
        </select>
      </div>

      <div class="field-group">
        <label for="video-format" class="field-label">Container & Codec</label>
        <select id="video-format" class="settings-select">
          <option value="mp4" ${currentFormat === 'mp4' ? 'selected' : ''}>MP4 (H.264 / AAC)</option>
          <option value="webm" ${currentFormat === 'webm' ? 'selected' : ''}>WebM (VP8 / Vorbis)</option>
        </select>
      </div>

      <div class="field-group">
        <label for="video-resolution" class="field-label">Max Resolution</label>
        <select id="video-resolution" class="settings-select">
          <option value="auto">Preset Default</option>
          <option value="1080">1080p (FHD)</option>
          <option value="720">720p (HD)</option>
          <option value="480">480p (SD)</option>
          <option value="360">360p</option>
        </select>
      </div>

      <div class="field-group">
        <label class="field-label">Audio Stream</label>
        <div class="checkbox-label-group">
          <input type="checkbox" id="video-mute" class="settings-checkbox" />
          <label for="video-mute" class="checkbox-text">Mute / Remove Audio Track</label>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#video-preset').onchange = (e) =>
    onPresetChange(e.target.value);
  container.querySelector('#video-format').onchange = (e) =>
    onFormatChange(e.target.value);
}

export function renderVideoMetadata(metadata, element) {
  if (!element) return;
  const dur = metadata.duration
    ? `${metadata.duration.toFixed(1)}s`
    : 'Unknown';
  const res =
    metadata.width && metadata.height
      ? `${metadata.width}×${metadata.height}`
      : 'Unknown';
  const audioText = metadata.hasAudio ? 'Audio detected' : 'No audio';
  element.textContent = `${dur} • ${res} • ${audioText}`;
}

export function renderVideoComparison(
  container,
  originalUrl,
  compressedUrl,
  originalSize,
  compressedSize
) {
  if (!container) return;
  container.innerHTML = `
    <div class="video-compare-wrapper">
      <div class="video-compare-col">
        <div class="video-compare-header">ORIGINAL (${formatFileSize(originalSize)})</div>
        <video class="video-compare-player" controls preload="metadata" playsinline src="${originalUrl}"></video>
      </div>
      <div class="video-compare-col">
        <div class="video-compare-header">COMPRESSED (${formatFileSize(compressedSize)})</div>
        <video class="video-compare-player" controls preload="metadata" playsinline src="${compressedUrl}"></video>
      </div>
    </div>
  `;
}
