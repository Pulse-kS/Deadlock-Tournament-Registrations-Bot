/**
 * Shared image-upload guards for team logos (registrationFlow.js's
 * handleMessage/resolveLogoUrl). Two independent checks live here:
 *
 *  - a size cap, checked against Discord's own attachment.size BEFORE
 *    downloading anything, so an oversized file never gets pulled into
 *    memory in the first place.
 *  - a magic-byte sniff of the actual downloaded bytes, since Discord's
 *    reported contentType and the filename extension are both just
 *    client-supplied metadata - either can be spoofed to get a
 *    non-image file (or an image format we don't expect) treated as a
 *    trusted PNG. This never executes or parses the file, just reads its
 *    leading bytes.
 *  - a dimension cap, read straight out of each format's own header bytes
 *    (no decode) - covers PNG, GIF, JPEG, and WebP, since a small-on-disk-
 *    but-huge-dimension file (highly compressible, e.g. a solid color at
 *    20000x20000) passes the byte-size and magic-byte checks fine in any
 *    of those formats, not just PNG.
 */

const MAX_LOGO_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const DOWNLOAD_TIMEOUT_MS = 15000;
// A broadcast logo has no business being bigger than this. Without a cap, a
// small-on-disk-but-huge-dimension PNG (highly compressible, e.g. a solid
// color at 20000x20000) passes the byte-size and magic-byte checks fine but
// is still expensive to decode/resize wherever the logo eventually gets
// rendered - this stops that class of file at upload time.
const MAX_LOGO_DIMENSION_PX = 4096;

const SIGNATURES = [
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] }, // "GIF8" (87a or 89a)
];

function matchesBytes(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

function isWebp(buffer) {
  return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
}

/** Returns 'png' | 'jpg' | 'gif' | 'webp' based on actual file contents, or null if none match. */
function detectImageType(buffer) {
  for (const sig of SIGNATURES) {
    if (matchesBytes(buffer, sig.bytes)) return sig.ext;
  }
  if (isWebp(buffer)) return 'webp';
  return null;
}

/**
 * Throws if attachment.size (Discord-reported, no download needed) exceeds
 * the cap. Call this before ever fetching the attachment's bytes.
 */
function assertSizeWithinLimit(attachment) {
  if (attachment.size > MAX_LOGO_SIZE_BYTES) {
    const mb = (attachment.size / (1024 * 1024)).toFixed(1);
    throw new Error(`That file is ${mb}MB - please keep logos under ${MAX_LOGO_SIZE_BYTES / (1024 * 1024)}MB.`);
  }
}

/**
 * Reads width/height straight out of a PNG's IHDR chunk (always the first
 * chunk, always this shape - bytes 16-19 width / 20-23 height, big-endian)
 * rather than pulling in an image-decoding dependency just to sanity-check
 * dimensions. Returns null if buffer is too short/not actually a PNG here -
 * callers should already have confirmed detectImageType(buffer) === 'png'.
 */
function getPngDimensions(buffer) {
  if (buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** GIF's logical screen descriptor: width/height are the first fields after the 6-byte "GIF87a"/"GIF89a" signature, little-endian. */
function getGifDimensions(buffer) {
  if (buffer.length < 10) return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

/**
 * Scans JPEG markers for the first SOFn (start-of-frame) segment, which
 * carries the actual pixel dimensions - big-endian height then width, right
 * after the 2-byte marker and 2-byte segment length. Skips markers that
 * aren't a real frame header (DHT/JPG/DAC use the 0xC0-0xCF range too but
 * aren't SOF). Returns null on anything malformed/truncated rather than
 * throwing - callers should already have confirmed detectImageType is 'jpg'.
 */
function getJpegDimensions(buffer) {
  let offset = 2; // skip the SOI marker (0xFFD8)
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    // Markers with no payload to skip over.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) return null; // EOI reached with no SOF found
    const segmentLength = buffer.readUInt16BE(offset + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (offset + 9 > buffer.length) return null;
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * WebP dimensions live in one of three sub-chunk shapes depending on how the
 * file was encoded - VP8X (extended format, dimensions are 24-bit LE minus
 * one), VP8 (simple lossy, 14-bit fields after the 3-byte start code), or
 * VP8L (simple lossless, packed into a 32-bit LE word). Reads whichever one
 * is actually present; returns null for anything else/too short to read.
 */
function getWebpDimensions(buffer) {
  if (buffer.length < 30) return null;
  const chunkType = buffer.toString('ascii', 12, 16);

  if (chunkType === 'VP8X') {
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { width, height };
  }
  if (chunkType === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunkType === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function getImageDimensions(buffer, type) {
  switch (type) {
    case 'png': return getPngDimensions(buffer);
    case 'gif': return getGifDimensions(buffer);
    case 'jpg': return getJpegDimensions(buffer);
    case 'webp': return getWebpDimensions(buffer);
    default: return null;
  }
}

/**
 * Throws if the image's dimensions exceed MAX_LOGO_DIMENSION_PX on either
 * axis, for any of the four formats detectImageType recognizes - not just
 * PNG. `type` should come from detectImageType(buffer), not client-supplied
 * metadata. Silently returns if dimensions can't be read (malformed/
 * truncated/unrecognized) - let the caller's other checks catch that case.
 */
function assertImageDimensionsWithinLimit(buffer, type) {
  const dims = getImageDimensions(buffer, type);
  if (!dims) return;
  if (dims.width > MAX_LOGO_DIMENSION_PX || dims.height > MAX_LOGO_DIMENSION_PX) {
    throw new Error(
      `That image is ${dims.width}x${dims.height} - please keep logos under ${MAX_LOGO_DIMENSION_PX}x${MAX_LOGO_DIMENSION_PX}px.`
    );
  }
}

module.exports = {
  MAX_LOGO_SIZE_BYTES,
  MAX_LOGO_DIMENSION_PX,
  DOWNLOAD_TIMEOUT_MS,
  detectImageType,
  assertSizeWithinLimit,
  assertImageDimensionsWithinLimit,
};
