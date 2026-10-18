import {
  concatBytes,
  Kf8FormatError,
  readBackwardVarLength,
  startsWithAscii,
  u16,
  u32,
} from './binary';
import type { MobiHeader } from './mobi-header';
import type { PalmDatabase } from './palm-database';

/**
 * Decompress every text record of a header into the raw markup stream that
 * the FDST table splits into flows. The header's declared text length is not
 * an upper bound in real books (HUFF/CDIC books exceed it), so output is
 * capped by the configured size limit instead.
 */
export function readRawText(
  database: PalmDatabase,
  header: MobiHeader,
  maxBytes: number,
): Uint8Array {
  if (header.textLength > maxBytes)
    throw new Kf8FormatError(
      'The book text exceeds the configured size limit.',
    );
  const decompress =
    header.compression === 'none'
      ? (bytes: Uint8Array) => bytes
      : header.compression === 'palmdoc'
        ? decompressPalmDoc
        : createHuffCdicDecoder(database, header);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let index = 1; index <= header.textRecordCount; index += 1) {
    const record = trimTrailingEntries(
      database.record(header.start + index),
      header,
    );
    const text = decompress(record);
    total += text.length;
    if (total > maxBytes)
      throw new Kf8FormatError(
        'The book text exceeds the configured size limit.',
      );
    parts.push(text);
  }
  return concatBytes(parts);
}

function trimTrailingEntries(
  record: Uint8Array,
  header: MobiHeader,
): Uint8Array {
  let end = record.length;
  for (let index = 0; index < header.trailingEntries; index += 1)
    end -= readBackwardVarLength(record.subarray(0, end));
  if (header.multibyteTrailer && end > 0) end -= (record[end - 1]! & 0b11) + 1;
  return record.subarray(0, Math.max(0, end));
}

/** PalmDOC LZ77: literals, back references and space-prefixed characters. */
export function decompressPalmDoc(input: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < input.length;) {
    const byte = input[index++]!;
    if (byte === 0 || (byte >= 0x09 && byte <= 0x7f)) {
      output.push(byte);
    } else if (byte <= 0x08) {
      for (let count = 0; count < byte && index < input.length; count += 1)
        output.push(input[index++]!);
    } else if (byte >= 0xc0) {
      output.push(0x20, byte ^ 0x80);
    } else {
      if (index >= input.length) break;
      const pair = (byte << 8) | input[index++]!;
      const distance = (pair >> 3) & 0x7ff;
      const length = (pair & 0x07) + 3;
      if (distance === 0 || distance > output.length)
        throw new Kf8FormatError('Invalid PalmDOC back reference.');
      for (let count = 0; count < length; count += 1)
        output.push(output[output.length - distance]!);
    }
  }
  return Uint8Array.from(output);
}

interface HuffCode {
  readonly codeLength: number;
  readonly terminal: boolean;
  readonly maxCode: number;
}

/**
 * Huffman/dictionary text compression. Dictionary entries may themselves be
 * compressed; they are expanded on first use and cached.
 */
function createHuffCdicDecoder(
  database: PalmDatabase,
  header: MobiHeader,
): (input: Uint8Array) => Uint8Array {
  const location = header.huffcdic;
  if (!location || location.count < 2)
    throw new Kf8FormatError('HUFF/CDIC records are missing.');
  const huff = database.record(location.record);
  if (!startsWithAscii(huff, 'HUFF'))
    throw new Kf8FormatError('Invalid HUFF record.');
  const table1Offset = u32(huff, 8);
  const table2Offset = u32(huff, 12);
  const lookup: HuffCode[] = [];
  for (let index = 0; index < 256; index += 1) {
    const value = u32(huff, table1Offset + index * 4);
    lookup.push({
      codeLength: value & 0x1f,
      terminal: (value & 0x80) !== 0,
      maxCode: value >>> 8,
    });
  }
  const minCodes: number[] = [0];
  const maxCodes: number[] = [0];
  for (let length = 1; length <= 32; length += 1) {
    const offset = table2Offset + (length - 1) * 8;
    minCodes.push(u32(huff, offset));
    maxCodes.push(u32(huff, offset + 4));
  }

  const dictionary: { bytes: Uint8Array; expanded: boolean }[] = [];
  for (let index = 1; index < location.count; index += 1) {
    const cdic = database.record(location.record + index);
    if (!startsWithAscii(cdic, 'CDIC'))
      throw new Kf8FormatError('Invalid CDIC record.');
    const headerLength = u32(cdic, 4);
    const total = u32(cdic, 8);
    const bits = u32(cdic, 12);
    const body = cdic.subarray(headerLength);
    const count = Math.min(1 << bits, total - dictionary.length);
    for (let entry = 0; entry < count; entry += 1) {
      const offset = u16(body, entry * 2);
      const descriptor = u16(body, offset);
      const length = descriptor & 0x7fff;
      dictionary.push({
        bytes: body.subarray(offset + 2, offset + 2 + length),
        expanded: (descriptor & 0x8000) !== 0,
      });
    }
  }

  const decode = (input: Uint8Array, depth: number): Uint8Array => {
    if (depth > 32)
      throw new Kf8FormatError('HUFF/CDIC recursion is too deep.');
    const parts: Uint8Array[] = [];
    const totalBits = input.length * 8;
    for (let position = 0; position < totalBits;) {
      const code = read32Bits(input, position);
      const huffCode = lookup[code >>> 24]!;
      let { codeLength, maxCode } = huffCode;
      if (!huffCode.terminal) {
        while (
          codeLength < 32 &&
          code >>> (32 - codeLength) < minCodes[codeLength]!
        )
          codeLength += 1;
        maxCode = maxCodes[codeLength]!;
      }
      if (codeLength === 0) throw new Kf8FormatError('Invalid Huffman code.');
      position += codeLength;
      if (position > totalBits) break;
      const entry = dictionary[maxCode - (code >>> (32 - codeLength))];
      if (!entry) throw new Kf8FormatError('Huffman code outside dictionary.');
      if (!entry.expanded) {
        entry.bytes = decode(entry.bytes, depth + 1);
        entry.expanded = true;
      }
      parts.push(entry.bytes);
    }
    return concatBytes(parts);
  };
  return (input) => decode(input, 0);
}

/** 32 bits starting at an arbitrary bit offset, zero-padded past the end. */
function read32Bits(bytes: Uint8Array, bitOffset: number): number {
  const byteOffset = bitOffset >> 3;
  const shift = bitOffset & 7;
  let value = 0n;
  for (let index = 0; index < 5; index += 1)
    value = (value << 8n) | BigInt(bytes[byteOffset + index] ?? 0);
  return Number((value >> BigInt(8 - shift)) & 0xffffffffn);
}
