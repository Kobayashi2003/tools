import {
  Kf8FormatError,
  latin1,
  readForwardVarLength,
  startsWithAscii,
  u16,
  u32,
  u8,
} from './binary';
import type { PalmDatabase } from './palm-database';

export interface IndexEntry {
  readonly name: string;
  readonly tags: ReadonlyMap<number, readonly number[]>;
}

export interface IndexTable {
  readonly entries: readonly IndexEntry[];
  /** Strings referenced from entries by their offset in the CNCX records. */
  readonly strings: ReadonlyMap<number, string>;
}

interface TagDefinition {
  readonly tag: number;
  readonly valuesPerEntry: number;
  readonly mask: number;
  readonly endOfControlByte: boolean;
}

/**
 * Read a KF8 index (skeleton, fragment, NCX): a header INDX record holding the
 * TAGX schema, followed by entry records and CNCX string records.
 */
export function readIndexTable(
  database: PalmDatabase,
  start: number,
  encoding: string,
): IndexTable {
  const header = database.record(start);
  if (!startsWithAscii(header, 'INDX'))
    throw new Kf8FormatError(`Record ${start} is not an INDX record.`);
  const headerLength = u32(header, 4);
  const entryRecordCount = u32(header, 24);
  const stringRecordCount = u32(header, 52);
  const { controlByteCount, definitions } = readTagx(header, headerLength);
  const ordt = readOrdt(header);

  const decoder = new TextDecoder(
    encoding === 'utf-8' ? 'utf-8' : 'windows-1252',
  );
  const strings = new Map<number, string>();
  for (let index = 0; index < stringRecordCount; index += 1) {
    const record = database.record(start + entryRecordCount + 1 + index);
    const base = index * 0x10000;
    for (let offset = 0; offset < record.length && record[offset] !== 0;) {
      const { value, length } = readForwardVarLength(record, offset);
      const textStart = offset + length;
      strings.set(
        base + offset,
        decoder.decode(record.subarray(textStart, textStart + value)),
      );
      offset = textStart + value;
    }
  }

  const entries: IndexEntry[] = [];
  for (let index = 0; index < entryRecordCount; index += 1) {
    const record = database.record(start + 1 + index);
    if (!startsWithAscii(record, 'INDX'))
      throw new Kf8FormatError('Invalid INDX entry record.');
    const idxt = u32(record, 20);
    const count = u32(record, 24);
    const positions: number[] = [];
    for (let entry = 0; entry < count; entry += 1)
      positions.push(u16(record, idxt + 4 + entry * 2));
    positions.push(idxt);
    for (let entry = 0; entry < count; entry += 1) {
      const position = positions[entry]!;
      const nameLength = u8(record, position);
      const nameBytes = record.subarray(
        position + 1,
        position + 1 + nameLength,
      );
      const name = ordt
        ? String.fromCharCode(
            ...Array.from(nameBytes, (byte) => ordt[byte] ?? byte),
          )
        : latin1(nameBytes);
      entries.push({
        name,
        tags: readTagValues(
          record,
          position + 1 + nameLength,
          controlByteCount,
          definitions,
        ),
      });
    }
  }
  return { entries, strings };
}

function readTagx(
  record: Uint8Array,
  offset: number,
): { controlByteCount: number; definitions: TagDefinition[] } {
  const tagx = record.subarray(offset);
  if (!startsWithAscii(tagx, 'TAGX'))
    throw new Kf8FormatError('INDX record has no TAGX section.');
  const length = u32(tagx, 4);
  const definitions: TagDefinition[] = [];
  for (let position = 12; position + 4 <= length; position += 4)
    definitions.push({
      tag: u8(tagx, position),
      valuesPerEntry: u8(tagx, position + 1),
      mask: u8(tagx, position + 2),
      endOfControlByte: u8(tagx, position + 3) === 1,
    });
  return { controlByteCount: u32(tagx, 8), definitions };
}

/** Some indexes remap entry-name bytes through the header's ORDT table. */
function readOrdt(record: Uint8Array): readonly number[] | null {
  if (record.length < 0xb8) return null;
  const tableCount = u32(record, 0xa4);
  const entryCount = u32(record, 0xa8);
  const secondTable = u32(record, 0xb0);
  if (tableCount === 0 && entryCount === 0) return null;
  if (!startsWithAscii(record.subarray(secondTable), 'ORDT')) return null;
  return Array.from({ length: entryCount }, (_, index) =>
    u16(record, secondTable + 4 + index * 2),
  );
}

function readTagValues(
  record: Uint8Array,
  start: number,
  controlByteCount: number,
  definitions: readonly TagDefinition[],
): Map<number, number[]> {
  const pending: {
    tag: number;
    valueCount: number | null;
    byteCount: number | null;
    valuesPerEntry: number;
  }[] = [];
  let controlByte = 0;
  let position = start + controlByteCount;
  for (const definition of definitions) {
    if (definition.endOfControlByte) {
      controlByte += 1;
      continue;
    }
    let value = u8(record, start + controlByte) & definition.mask;
    if (value === 0) continue;
    if (value === definition.mask && countBits(definition.mask) > 1) {
      const { value: byteCount, length } = readForwardVarLength(
        record,
        position,
      );
      position += length;
      pending.push({
        tag: definition.tag,
        valueCount: null,
        byteCount,
        valuesPerEntry: definition.valuesPerEntry,
      });
    } else {
      let mask = definition.mask;
      while ((mask & 1) === 0) {
        mask >>= 1;
        value >>= 1;
      }
      pending.push({
        tag: definition.tag,
        valueCount: value,
        byteCount: null,
        valuesPerEntry: definition.valuesPerEntry,
      });
    }
  }

  const tags = new Map<number, number[]>();
  for (const item of pending) {
    const values: number[] = [];
    if (item.valueCount != null) {
      for (
        let count = 0;
        count < item.valueCount * item.valuesPerEntry;
        count += 1
      ) {
        const { value, length } = readForwardVarLength(record, position);
        values.push(value);
        position += length;
      }
    } else {
      for (let consumed = 0; consumed < item.byteCount!;) {
        const { value, length } = readForwardVarLength(record, position);
        values.push(value);
        position += length;
        consumed += length;
      }
    }
    tags.set(item.tag, values);
  }
  return tags;
}

function countBits(value: number): number {
  let count = 0;
  for (let bits = value; bits; bits >>= 1) count += bits & 1;
  return count;
}
