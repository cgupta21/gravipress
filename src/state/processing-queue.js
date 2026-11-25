import { BATCH_LIMITS, QUEUE_STATUS } from '../config/batch-limits.js';
import {
  buildCompressedFilename,
  calculateSavings,
  formatFileSize,
} from '../utils/file-utils.js';
import { buildCompressedImageFilename } from '../utils/image-utils.js';

export function createProcessingQueue(initialPreset = 'Balanced') {
  let nextId = 1;
  let globalPreset = initialPreset;
  let items = [];

  function totalInputBytes() {
    return items.reduce((sum, item) => sum + (item.originalSize || 0), 0);
  }

  function addFiles(files) {
    const added = [];
    const rejected = [];

    for (const file of files) {
      if (!file) {
        continue;
      }

      if (items.length >= BATCH_LIMITS.maxFiles) {
        rejected.push({
          file,
          reason: `Batch limit of ${BATCH_LIMITS.maxFiles} files reached.`,
        });
        continue;
      }

      const fileSize = Number(file.size || 0);
      if (totalInputBytes() + fileSize > BATCH_LIMITS.maxTotalInputBytes) {
        rejected.push({
          file,
          reason: `Adding "${file.name}" exceeds the ${formatFileSize(BATCH_LIMITS.maxTotalInputBytes)} combined batch limit.`,
        });
        continue;
      }

      const item = {
        id: `batch-item-${nextId++}`,
        file,
        name: file.name,
        originalSize: fileSize,
        kind: null,
        formatLabel: 'FILE',
        presetOverride: null,
        status: QUEUE_STATUS.QUEUED,
        progress: 0,
        indeterminate: false,
        statusDetail: 'Queued',
        outputBlob: null,
        outputSize: null,
        outputMimeType: null,
        outputFilename: null,
        wasReduced: false,
        methodUsed: null,
        durationMs: null,
        error: null,
      };

      items.push(item);
      added.push(item);
    }

    return { added, rejected };
  }

  function getItems() {
    return items;
  }

  function getItem(id) {
    return items.find((item) => item.id === id) || null;
  }

  function updateItem(id, patch) {
    const item = getItem(id);
    if (!item) {
      return null;
    }
    Object.assign(item, patch);
    return item;
  }

  function removeItem(id) {
    const idx = items.findIndex((item) => item.id === id);
    if (idx === -1) {
      return false;
    }
    const target = items[idx];
    if (
      target.status === QUEUE_STATUS.VALIDATING ||
      target.status === QUEUE_STATUS.PROCESSING
    ) {
      return false;
    }
    const [removed] = items.splice(idx, 1);
    removed.outputBlob = null;
    return true;
  }

  function moveItem(id, delta) {
    const idx = items.findIndex((item) => item.id === id);
    const targetIdx = idx + delta;
    if (
      idx === -1 ||
      targetIdx < 0 ||
      targetIdx >= items.length ||
      items[idx].status !== QUEUE_STATUS.QUEUED
    ) {
      return false;
    }
    const [moved] = items.splice(idx, 1);
    items.splice(targetIdx, 0, moved);
    return true;
  }

  function clear() {
    for (const item of items) {
      item.outputBlob = null;
    }
    items = [];
  }

  function setGlobalPreset(preset) {
    globalPreset = preset;
  }

  function getGlobalPreset() {
    return globalPreset;
  }

  function getEffectivePreset(item) {
    return item.presetOverride || globalPreset;
  }

  function setItemPresetOverride(id, preset) {
    const item = getItem(id);
    if (!item) {
      return;
    }
    item.presetOverride = preset || null;
  }

  function retryItem(id) {
    const item = getItem(id);
    if (
      !item ||
      (item.status !== QUEUE_STATUS.FAILED &&
        item.status !== QUEUE_STATUS.CANCELLED)
    ) {
      return false;
    }
    Object.assign(item, {
      status: QUEUE_STATUS.QUEUED,
      progress: 0,
      indeterminate: false,
      statusDetail: 'Queued',
      outputBlob: null,
      outputSize: null,
      outputMimeType: null,
      outputFilename: null,
      wasReduced: false,
      methodUsed: null,
      durationMs: null,
      error: null,
    });
    return true;
  }

  function retryAllFailed() {
    let count = 0;
    for (const item of items) {
      if (retryItem(item.id)) {
        count += 1;
      }
    }
    return count;
  }

  function buildOutputFilename(item, result) {
    if (!result.wasReduced) {
      return item.name;
    }
    if (result.kind === 'image') {
      return buildCompressedImageFilename(item.name, result.extension);
    }
    return buildCompressedFilename(item.name);
  }

  function getAggregateSummary() {
    let completedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;
    let pendingCount = 0;
    let successfulOriginalBytes = 0;
    let successfulOutputBytes = 0;

    for (const item of items) {
      if (item.status === QUEUE_STATUS.COMPLETED) {
        completedCount += 1;
        successfulOriginalBytes += item.originalSize;
        successfulOutputBytes += item.outputSize ?? item.originalSize;
      } else if (item.status === QUEUE_STATUS.UNCHANGED) {
        unchangedCount += 1;
        successfulOriginalBytes += item.originalSize;
        successfulOutputBytes += item.outputSize ?? item.originalSize;
      } else if (item.status === QUEUE_STATUS.FAILED) {
        failedCount += 1;
      } else if (item.status === QUEUE_STATUS.CANCELLED) {
        cancelledCount += 1;
      } else {
        pendingCount += 1;
      }
    }

    const savings = calculateSavings(
      successfulOriginalBytes,
      successfulOutputBytes
    );

    return {
      totalFiles: items.length,
      completedCount,
      unchangedCount,
      failedCount,
      cancelledCount,
      pendingCount,
      successfulOriginalBytes,
      successfulOutputBytes,
      totalBytesSaved: Math.max(0, savings.bytesSaved),
      overallPercentageSaved: Math.max(0, savings.percentage),
      hasDownloadableOutputs: completedCount + unchangedCount > 0,
    };
  }

  return {
    addFiles,
    getItems,
    getItem,
    updateItem,
    removeItem,
    moveItem,
    clear,
    setGlobalPreset,
    getGlobalPreset,
    getEffectivePreset,
    setItemPresetOverride,
    retryItem,
    retryAllFailed,
    buildOutputFilename,
    getAggregateSummary,
    totalInputBytes,
  };
}
