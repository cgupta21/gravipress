import {
  formatFileSize,
  formatPercentageReduction,
} from '../utils/file-utils.js';

export function renderArchiveFileList(listElement, items, onRemove, isRunning) {
  listElement.innerHTML = '';

  items.forEach((item, index) => {
    const row = document.createElement('li');
    row.className = 'batch-row';

    const head = document.createElement('div');
    head.className = 'batch-row-head';

    const badge = document.createElement('span');
    badge.className = 'batch-badge';
    const ext = item.file.name.includes('.')
      ? item.file.name.split('.').pop().toUpperCase().slice(0, 6)
      : 'BIN';
    badge.textContent = ext;

    const pathEl = document.createElement('strong');
    pathEl.className = 'batch-name';
    pathEl.textContent = item.relativePath || item.file.name;

    const sizeEl = document.createElement('span');
    sizeEl.className = 'batch-size';
    sizeEl.textContent = formatFileSize(item.file.size);

    head.append(badge, pathEl, sizeEl);

    if (!isRunning) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'link';
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = () => onRemove(index);
      head.appendChild(removeBtn);
    }

    row.appendChild(head);
    listElement.appendChild(row);
  });
}

export function renderArchiveResult(result, elements) {
  const { metricsElement, titleElement, summaryElement, downloadButton } =
    elements;
  metricsElement.innerHTML = '';

  const pctText = formatPercentageReduction(
    result.percentageSaved,
    result.originalSize,
    result.compressedSize
  );

  const deltaText = result.wasReduced
    ? `${formatFileSize(result.bytesSaved)} (${pctText})`
    : result.increasedSize
      ? `+${formatFileSize(result.compressedSize - result.originalSize)} overhead`
      : '0 B (0.0%)';

  const entries = [
    ['ORIGINAL', formatFileSize(result.originalSize)],
    ['ARCHIVE', formatFileSize(result.compressedSize)],
    [result.increasedSize ? 'OVERHEAD' : 'SAVED', deltaText],
    ['FILES', String(result.fileCount)],
    ['DURATION', `${result.durationMs} ms`],
    ['METHOD', result.methodUsed],
  ];

  for (const [label, value] of entries) {
    const cell = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    cell.append(dt, dd);
    metricsElement.appendChild(cell);
  }

  if (result.wasReduced) {
    titleElement.textContent = 'Archive ready.';
    summaryElement.textContent = `Compressed ${result.fileCount} ${result.fileCount === 1 ? 'file' : 'files'} by ${pctText} via ${result.methodUsed}.`;
  } else if (result.increasedSize) {
    titleElement.textContent = 'Archive packaged.';
    summaryElement.textContent = `Archive headers increased total size by ${formatFileSize(result.compressedSize - result.originalSize)} (input is already compressed or very small).`;
  } else {
    titleElement.textContent = 'Archive ready.';
    summaryElement.textContent = `Packaged ${result.fileCount} ${result.fileCount === 1 ? 'file' : 'files'} (${result.methodUsed}).`;
  }

  downloadButton.firstChild.textContent = `Download ${result.kind.toUpperCase()} `;
}
