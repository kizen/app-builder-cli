/**
 * Placeholder `thumbnail.png` for a freshly scaffolded plugin (KZN-17594).
 *
 * A thumbnail is not a packager rule - `validatePluginApp` never asks for one -
 * but plugin-wizard's `publishOnce` throws "Thumbnail is required for
 * publishing" on EVERY publish, preview or not, and only the exact filename
 * `thumbnail.png` is recognised. A shell without one cannot ship.
 *
 * The image is rendered at create-time rather than shipped as an asset: a
 * puzzle piece (echoing the host's own fallback icon when a plugin has no
 * thumbnail) on a transparent background, with its hue and orientation derived
 * from the plugin's api_name. Ten freshly scaffolded plugins therefore look
 * different from each other in the Marketplace while still obviously being
 * placeholders. Rendering is pure Node (`zlib` for the PNG's DEFLATE stream),
 * so it needs no image dependency and works in a headless CI run.
 *
 * The host renders thumbnails at 35-40px tall in tiles and pickers and up to
 * 200px wide on the details panel (react-app `Marketplace/styles.ts`,
 * `PluginIcon.tsx`), so the glyph is one bold shape sized to survive 35px and
 * the canvas is large enough to stay crisp at 200px on a retina display.
 */
import { deflateSync } from 'node:zlib';

/** Canvas edge in pixels. Square, because every host surface fits by height. */
export const THUMBNAIL_SIZE = 512;

/**
 * Half the puzzle piece's body edge, in pixels. With the knob extension below
 * this leaves roughly a 70px margin on every side of the canvas.
 */
const BODY_HALF_SIZE = 150;

const BODY_CORNER_RADIUS = 26;

/** Radius of the round knobs (added) and sockets (subtracted). */
const KNOB_RADIUS = 46;

/**
 * How far a knob's centre sits outside the body edge (and a socket's inside
 * it), as a fraction of KNOB_RADIUS. Below ~0.5 the knob is a shallow bump;
 * above ~0.75 the neck gets too thin to read at 35px.
 */
const KNOB_OFFSET_RATIO = 0.6;

/** Half-width of the neck joining a knob or socket to the body edge. */
const NECK_HALF_WIDTH = KNOB_RADIUS * 0.55;

/**
 * Fixed saturation/lightness so every generated hue sits in the same
 * mid-vivid band: legible on the Marketplace's white tiles without turning
 * neon, and consistent when several scaffolds appear side by side.
 */
const SATURATION = 0.55;

const LIGHTNESS = 0.47;

/** Deterministic visual parameters derived from a plugin's api_name. */
export interface ThumbnailStyle {
  /** Hue in degrees, 0-359. */
  hue: number;
  /** Rotation of the puzzle piece in quarter turns, 0-3. */
  quarterTurns: 0 | 1 | 2 | 3;
}

/** 32-bit FNV-1a. Tiny, dependency-free, and spreads similar names well. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);

    // Multiply by the FNV prime (16777619) in 32-bit arithmetic without
    // overflowing double precision.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }

  return hash;
}

export function thumbnailStyle(apiName: string): ThumbnailStyle {
  const hash = fnv1a(apiName);

  return {
    hue: hash % 360,
    // Use high bits for the rotation so it isn't correlated with the hue.
    quarterTurns: ((hash >>> 16) % 4) as 0 | 1 | 2 | 3,
  };
}

/** HSL (h in degrees, s and l in 0-1) to 8-bit RGB. */
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

/** Signed distance from (x, y) to an axis-aligned rounded box centred at 0. */
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

/**
 * Signed distance to the puzzle piece, in pixels, for a point already
 * translated so the piece's body is centred at the origin. Negative inside.
 *
 * Knobs (top and right) are a circle plus a neck rectangle unioned onto the
 * body; sockets (bottom and left) are the same shapes subtracted. Union is
 * `min`, subtraction is `max(a, -b)`.
 */
function puzzlePieceDistance(x: number, y: number): number {
  const s = BODY_HALF_SIZE;
  const k = KNOB_RADIUS;
  const offset = k * KNOB_OFFSET_RATIO;
  const neckHalf = NECK_HALF_WIDTH;

  let d = roundedBoxDistance(x, y, s, s, BODY_CORNER_RADIUS);

  // Knob on the top edge (negative y is up on the canvas).
  const topKnob = Math.min(
    circleDistance(x, y, 0, -s - offset, k),
    roundedBoxDistance(x, y + s + offset / 2, neckHalf, offset / 2 + 1, 0),
  );

  // Knob on the right edge.
  const rightKnob = Math.min(
    circleDistance(x, y, s + offset, 0, k),
    roundedBoxDistance(x - s - offset / 2, y, offset / 2 + 1, neckHalf, 0),
  );

  d = Math.min(d, topKnob, rightKnob);

  // Socket cut into the bottom edge.
  const bottomSocket = Math.min(
    circleDistance(x, y, 0, s - offset, k),
    roundedBoxDistance(x, y - s + offset / 2, neckHalf, offset / 2 + 1, 0),
  );

  // Socket cut into the left edge.
  const leftSocket = Math.min(
    circleDistance(x, y, -s + offset, 0, k),
    roundedBoxDistance(x + s - offset / 2, y, offset / 2 + 1, neckHalf, 0),
  );

  return Math.max(d, -bottomSocket, -leftSocket);
}

/**
 * Renders the puzzle piece into straight-alpha RGBA. The shape's bounding box
 * is asymmetric (knobs protrude on two sides, sockets recess on the others),
 * so the body is shifted by half the knob extension to centre the whole glyph
 * before the rotation is applied.
 */
function renderPixels(style: ThumbnailStyle): Uint8Array {
  const size = THUMBNAIL_SIZE;
  const pixels = new Uint8Array(size * size * 4);
  const [r, g, b] = hslToRgb(style.hue, SATURATION, LIGHTNESS);

  const knobExtension = KNOB_RADIUS * (1 + KNOB_OFFSET_RATIO);
  const centre = (size - 1) / 2;
  const shift = knobExtension / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      // Canvas coordinates relative to the centre, then rotated by quarter
      // turns. Rotating the sample point (not the shape) keeps the SDF simple.
      let x = px - centre;
      let y = py - centre;

      for (let turn = 0; turn < style.quarterTurns; turn += 1) {
        [x, y] = [-y, x];
      }

      // Undo the centring shift: the body sits down-left of the canvas centre
      // so that body + knobs is centred overall.
      const d = puzzlePieceDistance(x + shift, y - shift);

      // One-pixel anti-aliased edge.
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

/**
 * Encodes straight-alpha RGBA as an 8-bit truecolor-with-alpha PNG. Every
 * scanline uses filter type 0 (None): the image is mostly one flat colour on
 * transparency, so DEFLATE alone already brings it to a few kilobytes.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `encodePng: expected ${String(width * height * 4)} bytes of RGBA for ${String(width)}x${String(height)}, got ${String(rgba.length)}`,
    );
  }

  // Compression method, filter method and interlace (bytes 10-12) are all 0,
  // which Buffer.alloc already provides.
  const ihdr = Buffer.alloc(13);

  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolor with alpha

  // Each scanline is prefixed with a filter-type byte; 0 (None) is the
  // zero-fill, so only the pixel data needs copying in.
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

/**
 * Bytes for the scaffolded `thumbnail.png`: a puzzle piece whose colour and
 * orientation are a pure function of the plugin's api_name, so the same name
 * always produces the same file.
 */
export function thumbnailBytes(apiName: string): Buffer {
  return encodePng(THUMBNAIL_SIZE, THUMBNAIL_SIZE, renderPixels(thumbnailStyle(apiName)));
}
