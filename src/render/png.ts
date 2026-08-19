// A minimal, dependency-free PNG encoder. It exists so `temu doctor` can render a self-test
// frame without depending on the ffmpeg pipeline (built in M1) being wired up yet, and so the
// rest of temu never needs an image library just to draw a handful of test patterns / overlays.

import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Standard CRC-32 (ISO-3309 / PKZIP polynomial), as required by the PNG chunk format.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    const tableIndex = (crc ^ byte) & 0xff;
    crc = (CRC_TABLE[tableIndex] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** RGBA pixel buffer, 4 bytes per pixel, row-major, top to bottom. */
export interface RgbaImage {
  width: number;
  height: number;
  /** Length must be exactly width * height * 4. */
  pixels: Buffer;
}

/** Encodes an RGBA pixel buffer as a PNG (8-bit depth, color type 6 = truecolor + alpha). */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, pixels } = image;
  if (pixels.length !== width * height * 4) {
    throw new Error(
      `pixel buffer length ${pixels.length} does not match ${width}x${height}x4 = ${width * height * 4}`,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  // Each scanline is prefixed with a filter-type byte; 0 (None) keeps this encoder simple at
  // the cost of compression ratio, which is a fine trade-off for small test-pattern images.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rawOffset = y * (stride + 1);
    raw[rawOffset] = 0;
    pixels.copy(raw, rawOffset + 1, y * stride, y * stride + stride);
  }
  const idatData = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Generates a simple RGBA test pattern: a border plus four colour quadrants (red, green, blue,
 * white). Good enough to sanity-check that pixel colours and orientation survive the full
 * transmit -> terminal-decode -> display round trip.
 */
export function generateTestPattern(width: number, height: number): RgbaImage {
  const pixels = Buffer.alloc(width * height * 4);
  const borderPx = Math.max(2, Math.round(Math.min(width, height) * 0.03));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const onBorder =
        x < borderPx || y < borderPx || x >= width - borderPx || y >= height - borderPx;

      let r: number, g: number, b: number;
      if (onBorder) {
        r = g = b = 255;
      } else {
        const leftHalf = x < width / 2;
        const topHalf = y < height / 2;
        if (topHalf && leftHalf) {
          [r, g, b] = [220, 40, 40]; // red
        } else if (topHalf && !leftHalf) {
          [r, g, b] = [40, 200, 90]; // green
        } else if (!topHalf && leftHalf) {
          [r, g, b] = [50, 100, 230]; // blue
        } else {
          [r, g, b] = [235, 235, 235]; // near-white
        }
      }

      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  }

  return { width, height, pixels };
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 6: 4 };

/**
 * Decodes a subset of PNG sufficient for this project's own pipeline: 8-bit depth, color type 0
 * (grayscale), 2 (RGB), or 6 (RGBA), non-interlaced, one or more IDAT chunks. That covers both
 * this module's own encoder (encodePng, above) and ffmpeg's `-vcodec png` output (verified
 * against this project's real pipeline: color type 2, 8-bit). Used by the block-character
 * fallback renderer, which needs raw pixels rather than a PNG buffer. Always returns RGBA,
 * regardless of the source color type, so callers never need to branch on it.
 */
export function decodePng(buffer: Buffer): RgbaImage {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file (bad signature)');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idatParts: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.subarray(dataStart, dataStart + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8] as number;
      colorType = data[9] as number;
      const interlace = data[12] as number;
      if (bitDepth !== 8) {
        throw new Error(`unsupported PNG bit depth ${String(bitDepth)} (only 8 is supported)`);
      }
      if (interlace !== 0) {
        throw new Error('interlaced PNGs are not supported');
      }
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }

    offset = dataStart + length + 4; // skip the trailing CRC
  }

  if (width === 0 || height === 0) {
    throw new Error('missing or invalid IHDR chunk');
  }
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (channels === undefined) {
    throw new Error(`unsupported PNG color type ${String(colorType)}`);
  }

  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let prevRow = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filterType = raw[rowStart] as number;
    const row = Buffer.alloc(stride);
    raw.copy(row, 0, rowStart + 1, rowStart + 1 + stride);

    for (let i = 0; i < stride; i++) {
      const rawByte = row[i] as number;
      const a = i >= channels ? (row[i - channels] as number) : 0;
      const b = prevRow[i] as number;
      const c = i >= channels ? (prevRow[i - channels] as number) : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + Math.floor((a + b) / 2);
          break;
        case 4:
          value = rawByte + paethPredictor(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter type ${String(filterType)}`);
      }
      row[i] = value & 0xff;
    }

    for (let x = 0; x < width; x++) {
      const srcOffset = x * channels;
      const dstOffset = (y * width + x) * 4;
      if (channels === 1) {
        const gray = row[srcOffset] as number;
        pixels[dstOffset] = gray;
        pixels[dstOffset + 1] = gray;
        pixels[dstOffset + 2] = gray;
        pixels[dstOffset + 3] = 255;
      } else if (channels === 3) {
        pixels[dstOffset] = row[srcOffset] as number;
        pixels[dstOffset + 1] = row[srcOffset + 1] as number;
        pixels[dstOffset + 2] = row[srcOffset + 2] as number;
        pixels[dstOffset + 3] = 255;
      } else {
        pixels[dstOffset] = row[srcOffset] as number;
        pixels[dstOffset + 1] = row[srcOffset + 1] as number;
        pixels[dstOffset + 2] = row[srcOffset + 2] as number;
        pixels[dstOffset + 3] = row[srcOffset + 3] as number;
      }
    }

    prevRow = row;
  }

  return { width, height, pixels };
}
