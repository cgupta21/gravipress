export const BATCH_LIMITS = {
  maxFiles: 20,
  maxTotalInputBytes: 100 * 1024 * 1024,
  zipFilename: 'gravipress-compressed-files.zip',
};

export const QUEUE_STATUS = {
  QUEUED: 'Queued',
  VALIDATING: 'Validating',
  PROCESSING: 'Processing',
  COMPLETED: 'Completed',
  UNCHANGED: 'Unchanged',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};
