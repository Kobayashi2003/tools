import type {
  PublicationDiagnostic,
  PublicationPath,
} from '../publication/model';
import {
  normalizePublicationPath,
  validateArchiveEntryPath,
} from '../publication/path';
import type { PublicationArchive } from './publication-archive';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const MAX_EOCD_SEARCH = 0xffff + 22;

interface ZipEntry {
  readonly path: PublicationPath;
  readonly compression: number;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export type OcfCompatibilityMode = 'strict' | 'compatible';

export interface OcfArchiveOpenResult {
  readonly archive: OcfZipArchive | null;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export interface OcfZipLimits {
  /** Maximum compressed container size accepted by the in-memory ZIP reader. */
  readonly maxContainerBytes: number;
  /** Maximum number of non-directory entries exposed by one EPUB container. */
  readonly maxEntries: number;
  /** Maximum central-directory byte length. */
  readonly maxCentralDirectoryBytes: number;
  /** Maximum advertised uncompressed size for one entry. */
  readonly maxEntryUncompressedBytes: number;
  /** Maximum advertised uncompressed size across all entries. */
  readonly maxTotalUncompressedBytes: number;
  /** Maximum uncompressed/compressed ratio for a Deflate entry. */
  readonly maxCompressionRatio: number;
}

export const DEFAULT_OCF_ZIP_LIMITS: OcfZipLimits = Object.freeze({
  maxContainerBytes: 1024 * 1024 * 1024,
  maxEntries: 20_000,
  maxCentralDirectoryBytes: 64 * 1024 * 1024,
  maxEntryUncompressedBytes: 512 * 1024 * 1024,
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 1000,
});

/**
 * EPUB OCF ZIP reader. Supports Stored, Deflate and ZIP64 metadata without
 * pulling a generic ZIP library into the reading-system core.
 */
export class OcfZipArchive implements PublicationArchive {
  readonly entries: readonly PublicationPath[];
  private readonly byPath: ReadonlyMap<PublicationPath, ZipEntry>;

  private constructor(
    private readonly bytes: Uint8Array,
    entries: readonly ZipEntry[],
  ) {
    this.entries = entries.map((entry) => entry.path);
    this.byPath = new Map(entries.map((entry) => [entry.path, entry]));
  }

  static async open(
    input: Uint8Array | ArrayBuffer,
    limits: Partial<OcfZipLimits> = {},
    mode: OcfCompatibilityMode = 'compatible',
  ): Promise<OcfArchiveOpenResult> {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const diagnostics: PublicationDiagnostic[] = [];
    const effectiveLimits = { ...DEFAULT_OCF_ZIP_LIMITS, ...limits };

    if (bytes.byteLength > effectiveLimits.maxContainerBytes) {
      diagnostics.push(
        diag(
          'OCF_ZIP_CONTAINER_LIMIT_EXCEEDED',
          'fatal',
          `EPUB container is ${bytes.byteLength} bytes, above the configured ${effectiveLimits.maxContainerBytes}-byte safety limit.`,
        ),
      );
      return { archive: null, diagnostics };
    }

    try {
      const entries = readCentralDirectory(bytes, diagnostics, effectiveLimits);
      if (!entries) return { archive: null, diagnostics };
      const archive = new OcfZipArchive(bytes, entries);
      await validateOcfMimetype(archive, entries, bytes, diagnostics, mode);
      if (
        mode === 'strict' &&
        diagnostics.some(
          (diagnostic) =>
            diagnostic.severity === 'error' || diagnostic.severity === 'fatal',
        )
      ) {
        return { archive: null, diagnostics };
      }
      return { archive, diagnostics };
    } catch (cause) {
      diagnostics.push({
        code: 'OCF_ZIP_OPEN_FAILED',
        severity: 'fatal',
        phase: 'archive',
        message:
          cause instanceof Error
            ? cause.message
            : 'Failed to open EPUB ZIP container.',
        cause,
      });
      return { archive: null, diagnostics };
    }
  }

  has(path: PublicationPath): boolean {
    try {
      return this.byPath.has(validateArchiveEntryPath(path));
    } catch {
      return false;
    }
  }

  async read(path: PublicationPath): Promise<Uint8Array> {
    const normalized = validateArchiveEntryPath(path);
    const entry = this.byPath.get(normalized);
    if (!entry) throw new Error(`Archive entry not found: ${normalized}`);
    if ((entry.flags & 0x1) !== 0)
      throw new Error(`Encrypted ZIP entry is not supported: ${normalized}`);

    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
    const offset = entry.localHeaderOffset;
    ensureRange(this.bytes, offset, 30);
    if (view.getUint32(offset, true) !== SIG_LOCAL)
      throw new Error(`Invalid local ZIP header: ${normalized}`);

    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    ensureRange(this.bytes, dataStart, entry.compressedSize);
    const compressed = this.bytes.subarray(
      dataStart,
      dataStart + entry.compressedSize,
    );

    let output: Uint8Array;
    if (entry.compression === 0) output = compressed.slice();
    else if (entry.compression === 8) output = await inflateRaw(compressed);
    else
      throw new Error(
        `Unsupported ZIP compression method ${entry.compression} for ${normalized}`,
      );

    if (output.byteLength !== entry.uncompressedSize) {
      throw new Error(
        `Uncompressed size mismatch for ${normalized}: expected ${entry.uncompressedSize}, got ${output.byteLength}`,
      );
    }
    const actualCrc = crc32(output);
    if (actualCrc !== entry.crc32) {
      throw new Error(`CRC32 mismatch for ${normalized}`);
    }
    return output;
  }

  async readText(path: PublicationPath, encoding = 'utf-8'): Promise<string> {
    return new TextDecoder(encoding).decode(await this.read(path));
  }
}

function readCentralDirectory(
  bytes: Uint8Array,
  diagnostics: PublicationDiagnostic[],
  limits: OcfZipLimits,
): ZipEntry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocd(bytes, view);
  if (eocdOffset < 0) {
    diagnostics.push(
      diag(
        'OCF_ZIP_EOCD_MISSING',
        'fatal',
        'ZIP end-of-central-directory record was not found.',
      ),
    );
    return null;
  }

  let entryCount = view.getUint16(eocdOffset + 10, true);
  let centralSize = view.getUint32(eocdOffset + 12, true);
  let centralOffset = view.getUint32(eocdOffset + 16, true);
  const disk = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  if (disk !== 0 || centralDisk !== 0) {
    diagnostics.push(
      diag(
        'OCF_ZIP_MULTIDISK_UNSUPPORTED',
        'fatal',
        'Multi-disk ZIP containers are not supported.',
      ),
    );
    return null;
  }

  const needsZip64 =
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff;
  if (needsZip64) {
    const locatorOffset = eocdOffset - 20;
    if (
      locatorOffset < 0 ||
      view.getUint32(locatorOffset, true) !== SIG_ZIP64_LOCATOR
    ) {
      diagnostics.push(
        diag('OCF_ZIP64_LOCATOR_MISSING', 'fatal', 'ZIP64 locator is missing.'),
      );
      return null;
    }
    const zip64Offset = bigintToSafeNumber(
      view.getBigUint64(locatorOffset + 8, true),
      'ZIP64 EOCD offset',
    );
    ensureRange(bytes, zip64Offset, 56);
    if (view.getUint32(zip64Offset, true) !== SIG_ZIP64_EOCD) {
      diagnostics.push(
        diag(
          'OCF_ZIP64_EOCD_INVALID',
          'fatal',
          'ZIP64 end-of-central-directory record is invalid.',
        ),
      );
      return null;
    }
    const zip64Disk = view.getUint32(zip64Offset + 16, true);
    const zip64CentralDisk = view.getUint32(zip64Offset + 20, true);
    if (zip64Disk !== 0 || zip64CentralDisk !== 0) {
      diagnostics.push(
        diag(
          'OCF_ZIP64_MULTIDISK_UNSUPPORTED',
          'fatal',
          'Multi-disk ZIP64 containers are not supported.',
        ),
      );
      return null;
    }
    entryCount = bigintToSafeNumber(
      view.getBigUint64(zip64Offset + 32, true),
      'ZIP64 entry count',
    );
    centralSize = bigintToSafeNumber(
      view.getBigUint64(zip64Offset + 40, true),
      'ZIP64 central size',
    );
    centralOffset = bigintToSafeNumber(
      view.getBigUint64(zip64Offset + 48, true),
      'ZIP64 central offset',
    );
  }

  if (entryCount > limits.maxEntries) {
    diagnostics.push(
      diag(
        'OCF_ZIP_ENTRY_COUNT_LIMIT_EXCEEDED',
        'fatal',
        `ZIP advertises ${entryCount} entries, above the configured ${limits.maxEntries}-entry safety limit.`,
      ),
    );
    return null;
  }
  if (centralSize > limits.maxCentralDirectoryBytes) {
    diagnostics.push(
      diag(
        'OCF_ZIP_CENTRAL_DIRECTORY_LIMIT_EXCEEDED',
        'fatal',
        `ZIP central directory is ${centralSize} bytes, above the configured ${limits.maxCentralDirectoryBytes}-byte safety limit.`,
      ),
    );
    return null;
  }

  ensureRange(bytes, centralOffset, centralSize);
  const entries: ZipEntry[] = [];
  let totalUncompressedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    ensureRange(bytes, cursor, 46);
    if (view.getUint32(cursor, true) !== SIG_CENTRAL) {
      diagnostics.push(
        diag(
          'OCF_ZIP_CENTRAL_INVALID',
          'fatal',
          `Invalid central directory entry at index ${index}.`,
        ),
      );
      return null;
    }

    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    let compressedSize = view.getUint32(cursor + 20, true);
    let uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    let localHeaderOffset = view.getUint32(cursor + 42, true);
    ensureRange(bytes, cursor + 46, nameLength + extraLength + commentLength);

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeZipName(nameBytes, flags, diagnostics);
    const extra = bytes.subarray(
      cursor + 46 + nameLength,
      cursor + 46 + nameLength + extraLength,
    );

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const zip64 = parseZip64Extra(extra, {
        compressedSize: compressedSize === 0xffffffff,
        uncompressedSize: uncompressedSize === 0xffffffff,
        localHeaderOffset: localHeaderOffset === 0xffffffff,
      });
      if (!zip64) throw new Error(`ZIP64 extra field missing for ${name}`);
      if (uncompressedSize === 0xffffffff)
        uncompressedSize = zip64.uncompressedSize!;
      if (compressedSize === 0xffffffff) compressedSize = zip64.compressedSize!;
      if (localHeaderOffset === 0xffffffff)
        localHeaderOffset = zip64.localHeaderOffset!;
    }

    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      diagnostics.push(
        diag(
          'OCF_ZIP_ENTRY_SIZE_LIMIT_EXCEEDED',
          'fatal',
          `Entry ${name} advertises ${uncompressedSize} uncompressed bytes, above the configured ${limits.maxEntryUncompressedBytes}-byte safety limit.`,
          normalizePublicationPath(name),
        ),
      );
      return null;
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      diagnostics.push(
        diag(
          'OCF_ZIP_TOTAL_SIZE_LIMIT_EXCEEDED',
          'fatal',
          `ZIP advertises more than ${limits.maxTotalUncompressedBytes} total uncompressed bytes.`,
        ),
      );
      return null;
    }
    if (compression === 8 && uncompressedSize > 0) {
      const ratio =
        compressedSize === 0
          ? Number.POSITIVE_INFINITY
          : uncompressedSize / compressedSize;
      if (ratio > limits.maxCompressionRatio) {
        diagnostics.push(
          diag(
            'OCF_ZIP_COMPRESSION_RATIO_LIMIT_EXCEEDED',
            'fatal',
            `Entry ${name} advertises compression ratio ${Number.isFinite(ratio) ? ratio.toFixed(1) : 'infinite'}, above the configured ${limits.maxCompressionRatio}:1 safety limit.`,
            normalizePublicationPath(name),
          ),
        );
        return null;
      }
    }

    if (compression !== 0 && compression !== 8) {
      diagnostics.push(
        diag(
          'OCF_ZIP_COMPRESSION_UNSUPPORTED',
          'error',
          `Entry ${name} uses unsupported compression method ${compression}; EPUB OCF permits only Stored (0) and Deflate (8).`,
          normalizePublicationPath(name),
        ),
      );
    }
    if ((flags & 0x1) !== 0) {
      diagnostics.push(
        diag(
          'OCF_ZIP_ENTRY_ENCRYPTED',
          'error',
          `Entry ${name} is ZIP-encrypted.`,
          normalizePublicationPath(name),
        ),
      );
    }

    if (!name.endsWith('/')) {
      let path: PublicationPath;
      try {
        path = validateArchiveEntryPath(name);
      } catch (cause) {
        diagnostics.push({
          ...diag(
            'OCF_ZIP_ENTRY_PATH_INVALID',
            'error',
            `ZIP entry has an invalid OCF path: ${name}.`,
          ),
          cause,
        });
        cursor += 46 + nameLength + extraLength + commentLength;
        continue;
      }
      if (entries.some((entry) => entry.path === path)) {
        diagnostics.push(
          diag(
            'OCF_ZIP_ENTRY_DUPLICATE',
            'error',
            `ZIP contains a duplicate entry path: ${path}.`,
            path,
          ),
        );
        cursor += 46 + nameLength + extraLength + commentLength;
        continue;
      }
      entries.push({
        path,
        compression,
        flags,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function validateOcfMimetype(
  archive: OcfZipArchive,
  entries: readonly ZipEntry[],
  bytes: Uint8Array,
  diagnostics: PublicationDiagnostic[],
  mode: OcfCompatibilityMode,
): Promise<void> {
  const firstByOffset = [...entries].sort(
    (a, b) => a.localHeaderOffset - b.localHeaderOffset,
  )[0];
  if (!firstByOffset || firstByOffset.path !== 'mimetype') {
    diagnostics.push(
      mode === 'compatible'
        ? {
            code: 'OCF_MIMETYPE_NOT_FIRST',
            severity: 'warning',
            phase: 'archive',
            message:
              'The `mimetype` file is not the first ZIP entry; compatibility mode accepts the otherwise valid stored mimetype.',
            repair: {
              strategy: 'accept-misordered-ocf-mimetype',
              description:
                'Accept a valid uncompressed EPUB mimetype entry even when its ZIP ordering violates OCF.',
              confidence: 0.99,
            },
          }
        : diag(
            'OCF_MIMETYPE_NOT_FIRST',
            'error',
            'The `mimetype` file is not the first ZIP entry.',
          ),
    );
  }

  const mimetype = entries.find((entry) => entry.path === 'mimetype');
  if (!mimetype) {
    diagnostics.push(
      diag(
        'OCF_MIMETYPE_MISSING',
        'error',
        'The required `mimetype` file is missing.',
      ),
    );
    return;
  }
  if (mimetype.compression !== 0) {
    diagnostics.push(
      diag(
        'OCF_MIMETYPE_COMPRESSED',
        'error',
        'The `mimetype` file must be stored without compression.',
      ),
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  ensureRange(bytes, mimetype.localHeaderOffset, 30);
  const extraLength = view.getUint16(mimetype.localHeaderOffset + 28, true);
  if (extraLength !== 0)
    diagnostics.push(
      diag(
        'OCF_MIMETYPE_HAS_EXTRA_FIELD',
        'error',
        'The `mimetype` local header must not contain an extra field.',
      ),
    );

  try {
    const value = await archive.readText('mimetype', 'ascii');
    if (value !== 'application/epub+zip') {
      diagnostics.push(
        diag(
          'OCF_MIMETYPE_INVALID',
          'error',
          `Unexpected EPUB mimetype value: ${JSON.stringify(value)}.`,
        ),
      );
    }
  } catch (cause) {
    diagnostics.push({
      ...diag(
        'OCF_MIMETYPE_READ_FAILED',
        'error',
        'Failed to read the EPUB `mimetype` file.',
      ),
      cause,
    });
  }
}

function findEocd(bytes: Uint8Array, view: DataView): number {
  const min = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

function parseZip64Extra(
  extra: Uint8Array,
  requested: {
    uncompressedSize: boolean;
    compressedSize: boolean;
    localHeaderOffset: boolean;
  },
): {
  uncompressedSize?: number;
  compressedSize?: number;
  localHeaderOffset?: number;
} | null {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    cursor += 4;
    ensureRange(extra, cursor, size);
    if (id !== 0x0001) {
      cursor += size;
      continue;
    }

    const end = cursor + size;
    const out: {
      uncompressedSize?: number;
      compressedSize?: number;
      localHeaderOffset?: number;
    } = {};
    if (requested.uncompressedSize) {
      if (cursor + 8 > end) return null;
      out.uncompressedSize = bigintToSafeNumber(
        view.getBigUint64(cursor, true),
        'ZIP64 uncompressed size',
      );
      cursor += 8;
    }
    if (requested.compressedSize) {
      if (cursor + 8 > end) return null;
      out.compressedSize = bigintToSafeNumber(
        view.getBigUint64(cursor, true),
        'ZIP64 compressed size',
      );
      cursor += 8;
    }
    if (requested.localHeaderOffset) {
      if (cursor + 8 > end) return null;
      out.localHeaderOffset = bigintToSafeNumber(
        view.getBigUint64(cursor, true),
        'ZIP64 local header offset',
      );
    }
    return out;
  }
  return null;
}

function decodeZipName(
  bytes: Uint8Array,
  flags: number,
  diagnostics: PublicationDiagnostic[],
): string {
  try {
    // OCF file names are UTF-8. The ZIP language flag is still observed for
    // diagnostics because malformed legacy EPUBs sometimes omit it.
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if ((flags & 0x800) === 0 && bytes.some((byte) => byte >= 0x80)) {
      diagnostics.push(
        diag(
          'OCF_ZIP_UTF8_FLAG_MISSING',
          'warning',
          `Non-ASCII ZIP name ${name} does not set the UTF-8 language flag.`,
        ),
      );
    }
    return name;
  } catch {
    diagnostics.push(
      diag(
        'OCF_ZIP_FILENAME_INVALID_UTF8',
        'error',
        'ZIP entry name is not valid UTF-8.',
      ),
    );
    return new TextDecoder().decode(bytes);
  }
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([copyToArrayBuffer(compressed)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function bigintToSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${label} exceeds JavaScript safe integer range.`);
  return Number(value);
}

function ensureRange(bytes: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  ) {
    throw new Error(
      `ZIP structure points outside container bounds (${offset}+${length}/${bytes.byteLength}).`,
    );
  }
}

function diag(
  code: string,
  severity: PublicationDiagnostic['severity'],
  message: string,
  path?: PublicationPath,
): PublicationDiagnostic {
  return { code, severity, phase: 'archive', message, path };
}

export const __zipTestUtils = { crc32 };
