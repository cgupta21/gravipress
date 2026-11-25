import {
  PDF_LIMITS,
  UNSUPPORTED_FORMAT_PATTERN,
} from '../config/compression-presets.js';

const BYTES_PER_KILOBYTE = 1024;
const BYTES_PER_MEGABYTE = 1048576;
const PDF_HEADER_SIGNATURE = '%PDF-';
const HEADER_SCAN_LIMIT = 1024;

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < BYTES_PER_KILOBYTE) {
    return `${bytes} B`;
  }
  if (bytes >= BYTES_PER_MEGABYTE) {
    return `${(bytes / BYTES_PER_MEGABYTE).toFixed(2)} MB`;
  }
  return `${(bytes / BYTES_PER_KILOBYTE).toFixed(1)} KB`;
}

export function calculateSavings(originalSize, compressedSize) {
  if (!Number.isFinite(originalSize) || originalSize <= 0) {
    return {
      bytesSaved: 0,
      percentage: 0,
      reduced: false,
    };
  }

  const bytesSaved = originalSize - compressedSize;
  const percentage = ((originalSize - compressedSize) / originalSize) * 100;

  return {
    bytesSaved,
    percentage,
    reduced: compressedSize < originalSize,
  };
}

export function formatPercentageReduction(
  percentage,
  originalSize,
  compressedSize
) {
  if (
    !Number.isFinite(percentage) ||
    percentage <= 0 ||
    compressedSize >= originalSize
  ) {
    return '0.0%';
  }

  if (compressedSize > 0 && percentage >= 99.95) {
    const capped = Math.min(99.99, percentage);
    return `${capped.toFixed(2)}%`;
  }

  return `${percentage.toFixed(1)}%`;
}

export function hasPdfHeader(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < PDF_HEADER_SIGNATURE.length
  ) {
    return false;
  }

  const limit = Math.min(bytes.length, HEADER_SCAN_LIMIT);
  let headerText = '';
  for (let i = 0; i < limit; i += 1) {
    headerText += String.fromCharCode(bytes[i]);
  }

  return headerText.includes(PDF_HEADER_SIGNATURE);
}

export function validatePdfFile(file, bytes) {
  if (!file) {
    return { valid: false, error: 'No file selected.' };
  }

  if (UNSUPPORTED_FORMAT_PATTERN.test(file.name)) {
    const extension = file.name.split('.').pop().toUpperCase();
    return {
      valid: false,
      error: `${extension} compression is not yet supported. Gravipress currently supports PDF, JPG, PNG, WebP, and AVIF.`,
    };
  }

  if (file.size === 0 || bytes.length === 0) {
    return { valid: false, error: 'The selected file is empty (0 bytes).' };
  }

  if (bytes.length > PDF_LIMITS.maxFileSizeBytes) {
    return {
      valid: false,
      error: `File exceeds the ${formatFileSize(PDF_LIMITS.maxFileSizeBytes)} browser processing limit.`,
    };
  }

  if (!hasPdfHeader(bytes)) {
    return {
      valid: false,
      error:
        'Invalid PDF file. The file contents do not match a valid PDF header.',
    };
  }

  return { valid: true, error: null };
}

export function detectDigitalSignature(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return false;
  }

  const decoder = new TextDecoder('latin1');
  const content = decoder.decode(bytes);

  return (
    content.includes('/ByteRange') &&
    (content.includes('/Type /Sig') ||
      content.includes('/Type/Sig') ||
      content.includes('/adbe.pkcs7') ||
      content.includes('/ETSI.CAdES'))
  );
}

export function buildCompressedFilename(originalName) {
  const safeName = (originalName || 'document.pdf').trim();
  const baseName = safeName.replace(/\.pdf$/i, '');
  return `${baseName}-compressed.pdf`;
}
