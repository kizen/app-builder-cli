import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePng, THUMBNAIL_SIZE, thumbnailBytes, thumbnailStyle } from './createThumbnail.js';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Independent CRC-32 so the encoder's checksum is verified against a second
 * implementation rather than itself.
 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

interface Chunk {
  type: string;
  data: Buffer;
  crcValid: boolean;
}

function readChunks(png: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 8;

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);

    chunks.push({
      type,
      data,
      crcValid: crc === crc32(png.subarray(offset + 4, offset + 8 + length)),
    });

    offset += 12 + length;
  }

  return chunks;
}

interface DecodedImage {
  width: number;
  height: number;
  /** Straight RGBA, filter bytes stripped. */
  rgba: Buffer;
}

/** Decodes the narrow PNG subset the encoder emits: 8-bit RGBA, filter None. */
function decode(png: Buffer): DecodedImage {
  const chunks = readChunks(png);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');

  if (!ihdr) {
    throw new Error('missing IHDR');
  }

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);

  const idat = Buffer.concat(
    chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data),
  );
  const raw = inflateSync(idat);
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (stride + 1)], `filter byte on row ${String(y)}`).toBe(0);

    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }

  return { width, height, rgba };
}

function pixelAt(image: DecodedImage, x: number, y: number): [number, number, number, number] {
  const i = (y * image.width + x) * 4;

  return [
    image.rgba[i] ?? 0,
    image.rgba[i + 1] ?? 0,
    image.rgba[i + 2] ?? 0,
    image.rgba[i + 3] ?? 0,
  ];
}

describe('encodePng', () => {
  it('emits the PNG signature and a well-formed IHDR/IDAT/IEND sequence', () => {
    const png = encodePng(2, 2, new Uint8Array(16));
    const chunks = readChunks(png);

    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks.every((chunk) => chunk.crcValid)).toBe(true);
  });

  it('declares 8-bit truecolor with alpha, no interlace', () => {
    const [ihdr] = readChunks(encodePng(3, 5, new Uint8Array(60)));

    expect(ihdr?.data.readUInt32BE(0)).toBe(3);
    expect(ihdr?.data.readUInt32BE(4)).toBe(5);
    expect([...(ihdr?.data.subarray(8) ?? [])]).toEqual([8, 6, 0, 0, 0]);
  });

  it('round-trips pixel data exactly', () => {
    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const image = decode(encodePng(2, 2, rgba));

    expect([...image.rgba]).toEqual([...rgba]);
  });

  it('rejects a buffer whose length does not match the dimensions', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(/expected 16 bytes/);
  });
});

describe('thumbnailStyle', () => {
  it('is deterministic for the same api_name', () => {
    expect(thumbnailStyle('my_plugin')).toEqual(thumbnailStyle('my_plugin'));
  });

  it('keeps hue and rotation within range', () => {
    for (const name of ['a', 'ab', 'my_plugin', 'hello_world', 'x'.repeat(64)]) {
      const style = thumbnailStyle(name);

      expect(style.hue).toBeGreaterThanOrEqual(0);
      expect(style.hue).toBeLessThan(360);
      expect([0, 1, 2, 3]).toContain(style.quarterTurns);
    }
  });

  // The whole point of deriving the style from the name: neighbouring
  // scaffolds in the Marketplace should not all look identical.
  it('spreads different names across hues', () => {
    const hues = new Set(
      ['smoke_test', 'my_plugin', 'hello_world', 'postgres', 'slack_notifier', 'kitchen_sink'].map(
        (name) => thumbnailStyle(name).hue,
      ),
    );

    expect(hues.size).toBeGreaterThanOrEqual(5);
  });
});

describe('thumbnailBytes', () => {
  const png = thumbnailBytes('my_plugin');
  const image = decode(png);

  it('is a valid PNG with every chunk CRC intact', () => {
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(readChunks(png).every((chunk) => chunk.crcValid)).toBe(true);
  });

  it(`renders a ${String(THUMBNAIL_SIZE)}px square`, () => {
    expect(image.width).toBe(THUMBNAIL_SIZE);
    expect(image.height).toBe(THUMBNAIL_SIZE);
  });

  // The host renders thumbnails on white tiles; an opaque background would
  // show as a coloured block. Corners are far outside the glyph.
  it('leaves the background fully transparent', () => {
    const edge = THUMBNAIL_SIZE - 1;

    for (const [x, y] of [
      [0, 0],
      [edge, 0],
      [0, edge],
      [edge, edge],
    ] as const) {
      expect(pixelAt(image, x, y)[3], `alpha at ${String(x)},${String(y)}`).toBe(0);
    }
  });

  it('paints the glyph body fully opaque at the centre', () => {
    const centre = Math.floor(THUMBNAIL_SIZE / 2);
    const [, , , alpha] = pixelAt(image, centre, centre);

    expect(alpha).toBe(255);
  });

  it('anti-aliases the edge rather than stepping straight from 0 to 255', () => {
    const alphas = new Set<number>();

    for (let i = 3; i < image.rgba.length; i += 4) {
      alphas.add(image.rgba[i] ?? 0);
    }

    expect(alphas.size).toBeGreaterThan(2);
  });

  it('uses a single flat colour for every visible pixel', () => {
    const colours = new Set<string>();

    for (let i = 0; i < image.rgba.length; i += 4) {
      if ((image.rgba[i + 3] ?? 0) > 0) {
        colours.add([image.rgba[i], image.rgba[i + 1], image.rgba[i + 2]].join(','));
      }
    }

    expect(colours.size).toBe(1);
  });

  it('is byte-for-byte deterministic', () => {
    expect(thumbnailBytes('my_plugin').equals(png)).toBe(true);
  });

  it('differs between plugins with different api_names', () => {
    expect(thumbnailBytes('hello_world').equals(png)).toBe(false);
  });

  // The scaffold is checked into every new plugin repo; keep it small.
  it('stays under 16 KB', () => {
    expect(png.length).toBeLessThan(16 * 1024);
  });
});
