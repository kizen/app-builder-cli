import { deflateSync } from 'node:zlib';

export const THUMBNAIL_SIZE = 512;

const BODY_HALF_SIZE = 150;

const BODY_CORNER_RADIUS = 26;

const KNOB_RADIUS = 46;

const KNOB_OFFSET_RATIO = 0.6;

const NECK_HALF_WIDTH = KNOB_RADIUS * 0.55;

const SATURATION = 0.55;

const LIGHTNESS = 0.47;

export interface ThumbnailStyle {
  hue: number;
  quarterTurns: 0 | 1 | 2 | 3;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);

    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }

  return hash;
}

export function thumbnailStyle(apiName: string): ThumbnailStyle {
  const hash = fnv1a(apiName);

  return {
    hue: hash % 360,
    quarterTurns: ((hash >>> 16) % 4) as 0 | 1 | 2 | 3,
  };
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  const match = lightness - chroma / 2;

  const [r, g, b] =
    sector < 1
      ? [chroma, secondary, 0]
      : sector < 2
        ? [secondary, chroma, 0]
        : sector < 3
          ? [0, chroma, secondary]
          : sector < 4
            ? [0, secondary, chroma]
            : sector < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];

  return [
    Math.round((r + match) * 255),
    Math.round((g + match) * 255),
    Math.round((b + match) * 255),
  ];
}

function roundedBoxDistance(
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  radius: number,
): number {
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y) - halfH + radius;

  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function circleDistance(x: number, y: number, cx: number, cy: number, radius: number): number {
  return Math.hypot(x - cx, y - cy) - radius;
}

function puzzlePieceDistance(x: number, y: number): number {
  const s = BODY_HALF_SIZE;
  const k = KNOB_RADIUS;
  const offset = k * KNOB_OFFSET_RATIO;
  const neckHalf = NECK_HALF_WIDTH;

  let d = roundedBoxDistance(x, y, s, s, BODY_CORNER_RADIUS);

  const topKnob = Math.min(
    circleDistance(x, y, 0, -s - offset, k),
    roundedBoxDistance(x, y + s + offset / 2, neckHalf, offset / 2 + 1, 0),
  );

  const rightKnob = Math.min(
    circleDistance(x, y, s + offset, 0, k),
    roundedBoxDistance(x - s - offset / 2, y, offset / 2 + 1, neckHalf, 0),
  );

  d = Math.min(d, topKnob, rightKnob);

  const bottomSocket = Math.min(
    circleDistance(x, y, 0, s - offset, k),
    roundedBoxDistance(x, y - s + offset / 2, neckHalf, offset / 2 + 1, 0),
  );

  const leftSocket = Math.min(
    circleDistance(x, y, -s + offset, 0, k),
    roundedBoxDistance(x + s - offset / 2, y, offset / 2 + 1, neckHalf, 0),
  );

  return Math.max(d, -bottomSocket, -leftSocket);
}

function renderPixels(style: ThumbnailStyle): Uint8Array {
  const size = THUMBNAIL_SIZE;
  const pixels = new Uint8Array(size * size * 4);
  const [r, g, b] = hslToRgb(style.hue, SATURATION, LIGHTNESS);

  const knobExtension = KNOB_RADIUS * (1 + KNOB_OFFSET_RATIO);
  const centre = (size - 1) / 2;
  const shift = knobExtension / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let x = px - centre;
      let y = py - centre;

      for (let turn = 0; turn < style.quarterTurns; turn += 1) {
        [x, y] = [-y, x];
      }

      const d = puzzlePieceDistance(x + shift, y - shift);

      const coverage = Math.min(1, Math.max(0, 0.5 - d));

      if (coverage <= 0) {
        continue;
      }

      const i = (py * size + px) * 4;

      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = Math.round(coverage * 255);
    }
  }

  return pixels;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;

  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }

  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'latin1');
  const length = Buffer.alloc(4);

  length.writeUInt32BE(data.length);

  const crc = Buffer.alloc(4);

  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));

  return Buffer.concat([length, typeBytes, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `encodePng: expected ${String(width * height * 4)} bytes of RGBA for ${String(width)}x${String(height)}, got ${String(rgba.length)}`,
    );
  }

  const ihdr = Buffer.alloc(13);

  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

export function thumbnailBytes(apiName: string): Buffer {
  return encodePng(THUMBNAIL_SIZE, THUMBNAIL_SIZE, renderPixels(thumbnailStyle(apiName)));
}
