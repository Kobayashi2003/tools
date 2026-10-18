import {
  Kf8FormatError,
  latin1,
  NO_INDEX,
  startsWithAscii,
  u16,
  u32,
} from './binary';
import type { PalmDatabase } from './palm-database';

export type MobiCompression = 'none' | 'palmdoc' | 'huffcdic';

/** The fields of one MOBI header the KF8 reader relies on. */
export interface MobiHeader {
  /** Record index of this header; KF8 record indexes are relative to it. */
  readonly start: number;
  readonly version: number;
  readonly compression: MobiCompression;
  readonly encrypted: boolean;
  readonly textLength: number;
  readonly textRecordCount: number;
  readonly encoding: 'utf-8' | 'windows-1252';
  readonly title: string;
  /** Absolute record index of the first resource, or `null`. */
  readonly firstResource: number | null;
  readonly huffcdic: { readonly record: number; readonly count: number } | null;
  readonly trailingEntries: number;
  readonly multibyteTrailer: boolean;
  /** Absolute record indexes of the KF8 tables, or `null` when absent. */
  readonly fdst: number | null;
  readonly skeleton: number | null;
  readonly fragment: number | null;
  readonly ncx: number | null;
  readonly exth: ReadonlyMap<number, readonly Uint8Array[]>;
}

const BOUNDARY_RECORD = 'BOUNDARY';

/** Locate and parse the KF8 header, either at record 0 or after a MOBI7 part. */
export function readKf8Header(database: PalmDatabase): {
  readonly header: MobiHeader;
  /** The first header, whose resource table a combined file shares. */
  readonly primary: MobiHeader;
} {
  const primary = readMobiHeader(database, 0);
  if (primary.version >= 8) return { header: primary, primary };
  for (let index = 1; index < database.recordCount - 1; index += 1) {
    const record = database.record(index);
    if (record.length === 8 && latin1(record) === BOUNDARY_RECORD)
      return { header: readMobiHeader(database, index + 1), primary };
  }
  if (primary.encrypted) return { header: primary, primary };
  throw new Kf8FormatError(
    'This is an older Mobipocket book without a KF8 (AZW3) section.',
  );
}

function readMobiHeader(database: PalmDatabase, start: number): MobiHeader {
  const record = database.record(start);
  if (!startsWithAscii(record.subarray(16), 'MOBI'))
    throw new Kf8FormatError(`Record ${start} is not a MOBI header.`);
  const headerLength = u32(record, 20);
  const headerEnd = Math.min(record.length, 16 + headerLength);
  const field = (offset: number) =>
    offset + 4 <= headerEnd ? u32(record, offset) : NO_INDEX;
  const relative = (offset: number) => {
    const value = field(offset);
    return value === NO_INDEX ? null : start + value;
  };

  const compressionCode = u16(record, 0);
  const compression: MobiCompression =
    compressionCode === 1
      ? 'none'
      : compressionCode === 2
        ? 'palmdoc'
        : compressionCode === 0x4448
          ? 'huffcdic'
          : unsupportedCompression(compressionCode);
  const encoding = field(28) === 65001 ? 'utf-8' : 'windows-1252';

  // Trailing entries are declared only by headers new enough to carry them.
  const trailingFlags =
    headerLength >= 0xe4 && field(0x68) >= 5 && 0xf4 <= headerEnd
      ? u16(record, 0xf2)
      : 0;
  let trailingEntries = 0;
  for (let flags = trailingFlags >> 1; flags; flags >>= 1)
    trailingEntries += flags & 1;

  const exth =
    (field(128) & 0x40) !== 0 ? readExth(record, headerEnd) : new Map();
  const titleOffset = field(84);
  const titleLength = field(88);
  const decoder = new TextDecoder(encoding);
  const title =
    titleOffset !== NO_INDEX && titleOffset + titleLength <= record.length
      ? decoder.decode(record.subarray(titleOffset, titleOffset + titleLength))
      : '';
  const huffRecord = field(112);
  const fdstCount = field(196);

  return {
    start,
    version: field(36),
    compression,
    encrypted: u16(record, 12) !== 0,
    textLength: u32(record, 4),
    textRecordCount: u16(record, 8),
    encoding,
    title,
    firstResource: relative(108),
    huffcdic:
      compression === 'huffcdic' && huffRecord !== NO_INDEX
        ? { record: start + huffRecord, count: field(116) }
        : null,
    trailingEntries,
    multibyteTrailer: (trailingFlags & 1) === 1,
    // A one-flow book may carry a garbage FDST index.
    fdst: fdstCount !== NO_INDEX && fdstCount > 1 ? relative(192) : null,
    ncx: relative(0xf4),
    fragment: relative(0xf8),
    skeleton: relative(0xfc),
    exth,
  };
}

function readExth(
  record: Uint8Array,
  offset: number,
): Map<number, Uint8Array[]> {
  const entries = new Map<number, Uint8Array[]>();
  if (!startsWithAscii(record.subarray(offset), 'EXTH')) return entries;
  const count = u32(record, offset + 8);
  let position = offset + 12;
  for (
    let index = 0;
    index < count && position + 8 <= record.length;
    index += 1
  ) {
    const type = u32(record, position);
    const length = u32(record, position + 4);
    if (length < 8 || position + length > record.length) break;
    const values = entries.get(type) ?? [];
    values.push(record.subarray(position + 8, position + length));
    entries.set(type, values);
    position += length;
  }
  return entries;
}

function unsupportedCompression(code: number): never {
  throw new Kf8FormatError(`Unsupported text compression ${code}.`);
}

/** Well-known EXTH record types used to describe the publication. */
export const EXTH = {
  author: 100,
  publisher: 101,
  description: 103,
  isbn: 104,
  subject: 105,
  publishingDate: 106,
  contributor: 108,
  rights: 109,
  asin: 113,
  fixedLayout: 122,
  coverOffset: 201,
  title: 503,
  language: 524,
  writingMode: 525,
  pageProgression: 527,
} as const;

export function exthText(header: MobiHeader, type: number): readonly string[] {
  const decoder = new TextDecoder(header.encoding);
  return (header.exth.get(type) ?? [])
    .map((value) => decoder.decode(value).replace(/\0+$/u, '').trim())
    .filter(Boolean);
}

export function exthNumber(header: MobiHeader, type: number): number | null {
  const value = header.exth.get(type)?.[0];
  if (!value || value.length < 4) return null;
  const number = u32(value, value.length - 4);
  return number === NO_INDEX ? null : number;
}
