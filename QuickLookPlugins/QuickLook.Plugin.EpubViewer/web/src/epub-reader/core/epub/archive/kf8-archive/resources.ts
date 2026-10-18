import { latin1, startsWithAscii, u32 } from './binary';
import type { PalmDatabase } from './palm-database';

export interface Kf8Resource {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

const IMAGE_TYPES: readonly {
  readonly test: (bytes: Uint8Array) => boolean;
  readonly mediaType: string;
  readonly extension: string;
}[] = [
  {
    test: (bytes) =>
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    mediaType: 'image/jpeg',
    extension: 'jpg',
  },
  {
    test: (bytes) => bytes[0] === 0x89 && latin1(bytes, 1, 4) === 'PNG',
    mediaType: 'image/png',
    extension: 'png',
  },
  {
    test: (bytes) => latin1(bytes, 0, 4) === 'GIF8',
    mediaType: 'image/gif',
    extension: 'gif',
  },
  {
    test: (bytes) =>
      latin1(bytes, 0, 4) === 'RIFF' && latin1(bytes, 8, 12) === 'WEBP',
    mediaType: 'image/webp',
    extension: 'webp',
  },
  {
    test: (bytes) => latin1(bytes, 0, 2) === 'BM',
    mediaType: 'image/bmp',
    extension: 'bmp',
  },
];

/** Bytes of a font record that are XOR-obfuscated with the record's key. */
const FONT_OBFUSCATED_PREFIX = 1040;

/**
 * Resolve one resource by its 1-based `kindle:embed` number. Unknown record
 * kinds (resource containers, HD image containers, end markers) yield `null`.
 */
export async function readKf8Resource(
  database: PalmDatabase,
  firstResource: number,
  number: number,
): Promise<Kf8Resource | null> {
  const index = firstResource + number - 1;
  if (number < 1 || index >= database.recordCount) return null;
  const bytes = database.record(index);
  const name = String(number).padStart(5, '0');
  const image = IMAGE_TYPES.find((type) => type.test(bytes));
  if (image)
    return {
      path: `Images/image${name}.${image.extension}`,
      mediaType: image.mediaType,
      bytes: bytes.slice(),
    };
  if (startsWithAscii(bytes, 'FONT')) {
    const font = await readFont(bytes);
    if (!font) return null;
    const otf = latin1(font, 0, 4) === 'OTTO';
    return {
      path: `Fonts/font${name}.${otf ? 'otf' : 'ttf'}`,
      mediaType: otf ? 'font/otf' : 'font/ttf',
      bytes: font,
    };
  }
  return null;
}

async function readFont(record: Uint8Array): Promise<Uint8Array | null> {
  const flags = u32(record, 8);
  const dataStart = u32(record, 12);
  const keyLength = u32(record, 16);
  const keyStart = u32(record, 20);
  if (dataStart > record.length) return null;
  const data = record.slice(dataStart);
  if (flags & 0b10) {
    const key = record.subarray(keyStart, keyStart + keyLength);
    if (key.length === 0) return null;
    const extent = Math.min(data.length, FONT_OBFUSCATED_PREFIX);
    for (let index = 0; index < extent; index += 1)
      data[index] = data[index]! ^ key[index % key.length]!;
  }
  if (!(flags & 0b1)) return data;
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}
