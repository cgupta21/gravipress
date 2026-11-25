import { QUEUE_STATUS } from '../config/batch-limits.js';
import {
  calculateSavings,
  formatFileSize,
  formatPercentageReduction,
} from '../utils/file-utils.js';

export function renderBatchQueue(listElement, queue, handlers, isRunning) {
  listElement.innerHTML = '';
  const items = queue.getItems();

  items.forEach((item, index) => {
    const row = document.createElement('li');
    row.className = 'batch-row';
    row.dataset.status = item.status.toLowerCase();

    const header = document.createElement('div');
    header.className = 'batch-row-head';

    const badge = document.createElement('span');
    badge.className = 'batch-badge';
    badge.textContent = item.formatLabel || 'FILE';

    const nameEl = document.createElement('strong');
    nameEl.className = 'batch-name';
    nameEl.textContent = item.name;

    const sizeEl = document.createElement('span');
    sizeEl.className = 'batch-size';
    if (
      item.status === QUEUE_STATUS.COMPLETED ||
      item.status === QUEUE_STATUS.UNCHANGED
    ) {
      const savings = calculateSavings(item.originalSize, item.outputSize);
      const pct = formatPercentageReduction(
        savings.percentage,
        item.originalSize,
        item.outputSize
      );
      sizeEl.textContent = item.wasReduced
        ? `${formatFileSize(item.originalSize)} → ${formatFileSize(item.outputSize)} (-${pct})`
        : `${formatFileSize(item.originalSize)} (unchanged)`;
    } else {
      sizeEl.textContent = formatFileSize(item.originalSize);
    }

    header.append(badge, nameEl, sizeEl);

    const meta = document.createElement('div');
    meta.className = 'batch-row-meta';

    const statusEl = document.createElement('span');
    statusEl.className = 'batch-status';
    statusEl.textContent = item.error
      ? `${item.status}: ${item.error}`
      : item.statusDetail || item.status;

    const controls = document.createElement('div');
    controls.className = 'batch-row-actions';

    if (item.status === QUEUE_STATUS.QUEUED && !isRunning) {
      const presetSelect = document.createElement('select');
      presetSelect.className = 'batch-preset-select';
      presetSelect.setAttribute('aria-label', `Preset for ${item.name}`);

      const globalOpt = document.createElement('option');
      globalOpt.value = '';
      globalOpt.textContent = `Global (${queue.getGlobalPreset()})`;
      presetSelect.appendChild(globalOpt);

      for (const mode of ['Light', 'Balanced', 'Maximum']) {
        const opt = document.createElement('option');
        opt.value = mode;
        opt.textContent = mode;
        presetSelect.appendChild(opt);
      }
      presetSelect.value = item.presetOverride || '';
      presetSelect.onchange = () => {
        handlers.onPresetOverride(item.id, presetSelect.value || null);
      };
      controls.appendChild(presetSelect);

      if (index > 0) {
        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.className = 'link';
        upBtn.textContent = '↑';
        upBtn.title = 'Move up';
        upBtn.onclick = () => handlers.onMove(item.id, -1);
        controls.appendChild(upBtn);
      }

      if (index < items.length - 1) {
        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.className = 'link';
        downBtn.textContent = '↓';
        downBtn.title = 'Move down';
        downBtn.onclick = () => handlers.onMove(item.id, 1);
        controls.appendChild(downBtn);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'link';
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = () => handlers.onRemove(item.id);
      controls.appendChild(removeBtn);
    }

    if (
      item.status === QUEUE_STATUS.PROCESSING ||
      item.status === QUEUE_STATUS.VALIDATING
    ) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'link';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => handlers.onCancelItem(item.id);
      controls.appendChild(cancelBtn);
    }

    if (
      (item.status === QUEUE_STATUS.FAILED ||
        item.status === QUEUE_STATUS.CANCELLED) &&
      !isRunning
    ) {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'link';
      retryBtn.textContent = 'Retry';
      retryBtn.onclick = () => handlers.onRetryItem(item.id);
      controls.appendChild(retryBtn);
    }

    if (
      (item.status === QUEUE_STATUS.COMPLETED ||
        item.status === QUEUE_STATUS.UNCHANGED) &&
      item.outputBlob
    ) {
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'link';
      dlBtn.textContent = 'Download';
      dlBtn.onclick = () => handlers.onDownloadItem(item.id);
      controls.appendChild(dlBtn);
    }

    meta.append(statusEl, controls);
    row.append(header, meta);
    listElement.appendChild(row);
  });
}

export function renderBatchSummary(summaryEl, summary, zipInfo) {
  summaryEl.innerHTML = '';

  const pct = formatPercentageReduction(
    summary.overallPercentageSaved,
    summary.successfulOriginalBytes,
    summary.successfulOutputBytes
  );

  const items = [
    ['TOTAL', String(summary.totalFiles)],
    ['COMPLETED', String(summary.completedCount)],
    ['UNCHANGED', String(summary.unchangedCount)],
    [
      'FAILED / CANCELLED',
      `${summary.failedCount} / ${summary.cancelledCount}`,
    ],
    [
      'BYTES (SUCCESSFUL)',
      `${formatFileSize(summary.successfulOriginalBytes)} → ${formatFileSize(summary.successfulOutputBytes)}`,
    ],
    ['SAVED', `${formatFileSize(summary.totalBytesSaved)} (${pct})`],
  ];

  if (zipInfo) {
    items.push([
      'ZIP ARCHIVE',
      `${formatFileSize(zipInfo.archiveSize)} (${zipInfo.entryCount} files)`,
    ]);
  }

  for (const [label, value] of items) {
    const cell = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    cell.append(dt, dd);
    summaryEl.appendChild(cell);
  }
}
