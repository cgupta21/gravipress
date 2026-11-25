import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
}

function createSyntheticPng(width, height, seed = 1) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const idx = rowStart + 1 + x * 3;
      const noise = ((x * 37 + y * 53 + seed * 97) ^ (x * y)) & 0xff;
      raw[idx] = (noise + x) & 0xff;
      raw[idx + 1] = ((noise >> 1) + y) & 0xff;
      raw[idx + 2] = (noise ^ seed) & 0xff;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function ensureTestFixtures(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const files = {};

  // 1. Text-based PDF (uncompressed streams)
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let p = 1; p <= 3; p += 1) {
      const page = doc.addPage([595, 842]);
      page.drawText(`Text Fixture Page ${p}`, {
        x: 50,
        y: 780,
        size: 18,
        font,
      });
      for (let line = 0; line < 24; line += 1) {
        page.drawText(
          `Line ${line + 1}: Gravipress synthetic text document for Light, Balanced, and Maximum verification.`,
          { x: 50, y: 740 - line * 26, size: 10, font }
        );
      }
    }
    const target = path.join(outputDir, 'text-based.pdf');
    fs.writeFileSync(target, await doc.save({ useObjectStreams: false }));
    files.textBased = target;
  }

  // 2. Image-heavy PDF (high-res embedded PNGs)
  {
    const doc = await PDFDocument.create();
    const pngA = await doc.embedPng(createSyntheticPng(700, 900, 11));
    const pngB = await doc.embedPng(createSyntheticPng(700, 900, 29));
    for (const img of [pngA, pngB]) {
      const page = doc.addPage([595, 842]);
      page.drawImage(img, { x: 40, y: 80, width: 515, height: 680 });
    }
    const target = path.join(outputDir, 'image-heavy.pdf');
    fs.writeFileSync(target, await doc.save({ useObjectStreams: false }));
    files.imageHeavy = target;
  }

  // 3. Scanned-style PDF (full-bleed raster scan simulation)
  {
    const doc = await PDFDocument.create();
    const scanImg = await doc.embedPng(createSyntheticPng(800, 1100, 47));
    const page = doc.addPage([612, 792]);
    page.drawImage(scanImg, { x: 0, y: 0, width: 612, height: 792 });
    const target = path.join(outputDir, 'scanned-style.pdf');
    fs.writeFileSync(target, await doc.save({ useObjectStreams: false }));
    files.scannedStyle = target;
  }

  // 4. Multi-page PDF (6 pages)
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (let i = 1; i <= 6; i += 1) {
      const page = doc.addPage([595, 842]);
      page.drawRectangle({
        x: 40,
        y: 740,
        width: 515,
        height: 60,
        color: rgb(0.17, 0.18, 0.13),
      });
      page.drawText(`MULTI-PAGE SECTION ${i}`, {
        x: 60,
        y: 764,
        size: 16,
        font,
        color: rgb(1, 0.79, 0.24),
      });
    }
    const target = path.join(outputDir, 'multi-page.pdf');
    fs.writeFileSync(target, await doc.save({ useObjectStreams: false }));
    files.multiPage = target;
  }

  // 5. Large PDF (between 1 MB and 20 MB, ~1.8 MB)
  {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i += 1) {
      const bigPng = await doc.embedPng(createSyntheticPng(850, 900, 70 + i));
      const page = doc.addPage([595, 842]);
      page.drawImage(bigPng, { x: 20, y: 20, width: 555, height: 802 });
    }
    const target = path.join(outputDir, 'large-pdf.pdf');
    fs.writeFileSync(target, await doc.save({ useObjectStreams: false }));
    files.largePdf = target;
  }

  // 5b. Extra-large PDF between 5 MB and 20 MB (~6 MB, 8 pages)
  {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 8; i += 1) {
      const bigPng = await doc.embedPng(createSyntheticPng(850, 950, 120 + i));
      const page = doc.addPage([595, 842]);
      page.drawImage(bigPng, { x: 20, y: 20, width: 555, height: 802 });
    }
    const target = path.join(outputDir, 'large-6mb.pdf');
    fs.writeFileSync(target, await doc.save({ useObjectStreams: false }));
    files.large6Mb = target;
  }

  // 6. Portrait and landscape PDF
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595, 842]);
    p1.drawText('Portrait Page 1', { x: 40, y: 780, size: 16, font });
    const p2 = doc.addPage([842, 595]);
    p2.drawText('Landscape Page 2', { x: 40, y: 540, size: 16, font });
    const target = path.join(outputDir, 'portrait-landscape.pdf');
    fs.writeFileSync(target, await doc.save({ useObjectStreams: false }));
    files.portraitLandscape = target;
  }

  // 7. Rotated pages PDF
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595, 842]);
    p1.setRotation(degrees(90));
    p1.drawText('Rotated 90 deg', { x: 40, y: 780, size: 16, font });
    const p2 = doc.addPage([595, 842]);
    p2.setRotation(degrees(180));
    p2.drawText('Rotated 180 deg', { x: 40, y: 780, size: 16, font });
    const target = path.join(outputDir, 'rotated-pages.pdf');
    fs.writeFileSync(target, await doc.save({ useObjectStreams: false }));
    files.rotatedPages = target;
  }

  // 8. Forms and hyperlinks PDF
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText('Interactive Form & Link Fixture', {
      x: 50,
      y: 780,
      size: 16,
      font,
    });
    const form = doc.getForm();
    const field = form.createTextField('applicant.name');
    field.setText('Gravipress QA');
    field.addToPage(page, { x: 50, y: 710, width: 220, height: 28 });

    const linkAnnot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [50, 650, 250, 675],
      Border: [0, 0, 0],
      A: {
        Type: 'Action',
        S: 'URI',
        URI: PDFString.of('https://example.com/gravipress'),
      },
    });
    const linkRef = doc.context.register(linkAnnot);
    page.node.set(PDFName.of('Annots'), doc.context.obj([linkRef]));

    const target = path.join(outputDir, 'forms-links.pdf');
    fs.writeFileSync(target, await doc.save({ useObjectStreams: false }));
    files.formsLinks = target;
  }

  // 9. Already-optimized PDF
  {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const target = path.join(outputDir, 'already-optimized.pdf');
    fs.writeFileSync(target, await doc.save({ useObjectStreams: true }));
    files.alreadyOptimized = target;
  }

  // 10. Corrupted PDF
  {
    const target = path.join(outputDir, 'corrupted.pdf');
    fs.writeFileSync(target, '%PDF-1.7\n1 0 obj\n<< /Corrupt >>\n%%EOF-broken');
    files.corrupted = target;
  }

  // 11. Password-protected / encrypted PDF marker
  {
    const target = path.join(outputDir, 'encrypted.pdf');
    fs.writeFileSync(
      target,
      '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Encrypt 3 0 R >>\nendobj'
    );
    files.encrypted = target;
  }

  // 12. Empty file
  {
    const target = path.join(outputDir, 'empty.pdf');
    fs.writeFileSync(target, Buffer.alloc(0));
    files.empty = target;
  }

  // 13. Renamed non-PDF file
  {
    const target = path.join(outputDir, 'renamed-text.pdf');
    fs.writeFileSync(target, 'This is plain text disguised as a PDF.');
    files.renamedNonPdf = target;
  }

  // 14. Unsupported format (.mp4)
  {
    const target = path.join(outputDir, 'unsupported.mp4');
    fs.writeFileSync(
      target,
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
    );
    files.unsupportedMp4 = target;
  }

  // 15. Transparent PNG (flat graphic + alpha)
  {
    const width = 400;
    const height = 300;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6; // RGBA
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
      raw[y * stride] = 0;
      for (let x = 0; x < width; x += 1) {
        const idx = y * stride + 1 + x * 4;
        const inBox = x > 80 && x < 320 && y > 60 && y < 240;
        raw[idx] = inBox ? 255 : 0;
        raw[idx + 1] = inBox ? 201 : 0;
        raw[idx + 2] = inBox ? 60 : 0;
        raw[idx + 3] = inBox ? 255 : 0;
      }
    }
    const pngBuf = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      makePngChunk('IHDR', ihdr),
      makePngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
      makePngChunk('IEND', Buffer.alloc(0)),
    ]);
    const target = path.join(outputDir, 'transparent-graphic.png');
    fs.writeFileSync(target, pngBuf);
    files.transparentPng = target;
  }

  // 16. Noisy high-res PNG (for Balanced/Maximum PNG & photo conversion)
  {
    const target = path.join(outputDir, 'noisy-photo.png');
    fs.writeFileSync(target, createSyntheticPng(900, 700, 88));
    files.noisyPng = target;
  }

  // 17. Already-optimized tiny 1x1 PNG
  {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const tiny = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      makePngChunk('IHDR', ihdr),
      makePngChunk(
        'IDAT',
        zlib.deflateSync(Buffer.from([0, 43, 45, 33]), { level: 9 })
      ),
      makePngChunk('IEND', Buffer.alloc(0)),
    ]);
    const target = path.join(outputDir, 'tiny-optimized.png');
    fs.writeFileSync(target, tiny);
    files.tinyPng = target;
  }

  // 18. Animated PNG (APNG)
  {
    const base = createSyntheticPng(64, 64, 5);
    const actl = makePngChunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]));
    const apng = Buffer.concat([base.subarray(0, 33), actl, base.subarray(33)]);
    const target = path.join(outputDir, 'animated.png');
    fs.writeFileSync(target, apng);
    files.animatedPng = target;
  }

  // 19. Corrupted PNG & renamed text as .jpg
  {
    const corruptImg = path.join(outputDir, 'corrupted-image.png');
    fs.writeFileSync(
      corruptImg,
      Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
        10, 0, 0, 0, 10, 8, 2, 0, 0, 0, 0,
      ])
    );
    files.corruptedPng = corruptImg;

    const renamedImg = path.join(outputDir, 'renamed-image.jpg');
    fs.writeFileSync(renamedImg, 'Not a real JPEG file');
    files.renamedImage = renamedImg;
  }

  // 20. Large 5-25 MB PNG (~8 MB uncompressed level-0 PNG, 2200x1600)
  {
    const width = 2200;
    const height = 1600;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2; // RGB
    const stride = width * 3 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
      raw[y * stride] = 0;
      for (let x = 0; x < width; x += 1) {
        const idx = y * stride + 1 + x * 3;
        raw[idx] = (x * 3 + y) & 0xff;
        raw[idx + 1] = (y * 5 + x) & 0xff;
        raw[idx + 2] = ((x ^ y) * 2) & 0xff;
      }
    }
    const bigPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      makePngChunk('IHDR', ihdr),
      makePngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
      makePngChunk('IEND', Buffer.alloc(0)),
    ]);
    const target = path.join(outputDir, 'large-image-10mb.png');
    fs.writeFileSync(target, bigPng);
    files.largeImage10Mb = target;
  }

  // 21. Phase 6 Video Fixtures (Synthetically crafted MP4 & WebM)
  {
    // Minimal standard MP4 ISO container structure: ftyp + moov + mdat
    const ftyp = Buffer.from([
      0x00,
      0x00,
      0x00,
      0x20, // 32 bytes length
      0x66,
      0x74,
      0x79,
      0x70, // 'ftyp'
      0x69,
      0x73,
      0x6f,
      0x6d, // 'isom'
      0x00,
      0x00,
      0x02,
      0x00, // minor version
      0x69,
      0x73,
      0x6f,
      0x6d, // compatible brand 1: 'isom'
      0x69,
      0x73,
      0x6f,
      0x32, // compatible brand 2: 'iso2'
      0x61,
      0x76,
      0x63,
      0x31, // compatible brand 3: 'avc1'
      0x6d,
      0x70,
      0x34,
      0x31, // compatible brand 4: 'mp41'
    ]);
    const mdatPayload = Buffer.alloc(64 * 1024, 0xaa); // 64 KB media data
    const mdatHeader = Buffer.alloc(8);
    mdatHeader.writeUInt32BE(mdatPayload.length + 8, 0);
    mdatHeader.write('mdat', 4, 'ascii');
    const sampleMp4 = Buffer.concat([ftyp, mdatHeader, mdatPayload]);

    const mp4Path = path.join(outputDir, 'sample-video.mp4');
    fs.writeFileSync(mp4Path, sampleMp4);
    files.sampleVideoMp4 = mp4Path;

    // WebM container structure: EBML header (1A 45 DF A3) + DocType 'webm'
    const ebmlHeader = Buffer.from([
      0x1a,
      0x45,
      0xdf,
      0xa3, // EBML
      0x9f, // size 31
      0x42,
      0x86,
      0x81,
      0x01, // EBMLVersion = 1
      0x42,
      0xf7,
      0x81,
      0x01, // EBMLReadVersion = 1
      0x42,
      0xf2,
      0x81,
      0x04, // EBMLMaxIDLength = 4
      0x42,
      0xf3,
      0x81,
      0x08, // EBMLMaxSizeLength = 8
      0x42,
      0x82,
      0x84,
      0x77,
      0x65,
      0x62,
      0x6d, // DocType = 'webm'
      0x42,
      0x87,
      0x81,
      0x04, // DocTypeVersion = 4
      0x42,
      0x85,
      0x81,
      0x02, // DocTypeReadVersion = 2
    ]);
    const webmSegment = Buffer.alloc(64 * 1024, 0x55);
    const sampleWebm = Buffer.concat([ebmlHeader, webmSegment]);

    const webmPath = path.join(outputDir, 'sample-video.webm');
    fs.writeFileSync(webmPath, sampleWebm);
    files.sampleVideoWebm = webmPath;

    // Corrupted video fixture
    const corruptPath = path.join(outputDir, 'corrupt-video.mp4');
    fs.writeFileSync(
      corruptPath,
      Buffer.from([0x00, 0x00, 0x00, 0x08, 0x66, 0x74, 0x79, 0x70])
    );
    files.corruptVideoMp4 = corruptPath;
  }

  // 21. Phase 6 Video Fixtures (Synthetically crafted MP4 & WebM)
  {
    // Minimal standard MP4 ISO container structure: ftyp + moov + mdat
    const ftyp = Buffer.from([
      0x00,
      0x00,
      0x00,
      0x20, // 32 bytes length
      0x66,
      0x74,
      0x79,
      0x70, // 'ftyp'
      0x69,
      0x73,
      0x6f,
      0x6d, // 'isom'
      0x00,
      0x00,
      0x02,
      0x00, // minor version
      0x69,
      0x73,
      0x6f,
      0x6d, // compatible brand 1: 'isom'
      0x69,
      0x73,
      0x6f,
      0x32, // compatible brand 2: 'iso2'
      0x61,
      0x76,
      0x63,
      0x31, // compatible brand 3: 'avc1'
      0x6d,
      0x70,
      0x34,
      0x31, // compatible brand 4: 'mp41'
    ]);
    const mdatPayload = Buffer.alloc(64 * 1024, 0xaa); // 64 KB media data
    const mdatHeader = Buffer.alloc(8);
    mdatHeader.writeUInt32BE(mdatPayload.length + 8, 0);
    mdatHeader.write('mdat', 4, 'ascii');
    const sampleMp4 = Buffer.concat([ftyp, mdatHeader, mdatPayload]);

    const mp4Path = path.join(outputDir, 'sample-video.mp4');
    fs.writeFileSync(mp4Path, sampleMp4);
    files.sampleVideoMp4 = mp4Path;

    // WebM container structure: EBML header (1A 45 DF A3) + DocType 'webm'
    const ebmlHeader = Buffer.from([
      0x1a,
      0x45,
      0xdf,
      0xa3, // EBML
      0x9f, // size 31
      0x42,
      0x86,
      0x81,
      0x01, // EBMLVersion = 1
      0x42,
      0xf7,
      0x81,
      0x01, // EBMLReadVersion = 1
      0x42,
      0xf2,
      0x81,
      0x04, // EBMLMaxIDLength = 4
      0x42,
      0xf3,
      0x81,
      0x08, // EBMLMaxSizeLength = 8
      0x42,
      0x82,
      0x84,
      0x77,
      0x65,
      0x62,
      0x6d, // DocType = 'webm'
      0x42,
      0x87,
      0x81,
      0x04, // DocTypeVersion = 4
      0x42,
      0x85,
      0x81,
      0x02, // DocTypeReadVersion = 2
    ]);
    const webmSegment = Buffer.alloc(64 * 1024, 0x55);
    const sampleWebm = Buffer.concat([ebmlHeader, webmSegment]);

    const webmPath = path.join(outputDir, 'sample-video.webm');
    fs.writeFileSync(webmPath, sampleWebm);
    files.sampleVideoWebm = webmPath;

    // Corrupted video fixture
    const corruptPath = path.join(outputDir, 'corrupt-video.mp4');
    fs.writeFileSync(
      corruptPath,
      Buffer.from([0x00, 0x00, 0x00, 0x08, 0x66, 0x74, 0x79, 0x70])
    );
    files.corruptVideoMp4 = corruptPath;
  }

  return files;
}
