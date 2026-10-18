/** Thrown for structurally invalid Kindle data; converted to a diagnostic by the facade. */
export class Kf8FormatError extends Error {
  override readonly name = 'Kf8FormatError';
}

export const NO_INDEX = 0xffffffff;

export function u8(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset >= bytes.length)
    throw new Kf8FormatError(`Read beyond record end at ${offset}.`);
  return bytes[offset]!;
}

export function u16(bytes: Uint8Array, offset: number): number {
  return (u8(bytes, offset) << 8) | u8(bytes, offset + 1);
}

export function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((u8(bytes, offset) << 24) |
      (u8(bytes, offset + 1) << 16) |
      (u8(bytes, offset + 2) << 8) |
      u8(bytes, offset + 3)) >>>
    0
  );
}

/** Latin-1 view of bytes; one character per byte, so offsets are preserved. */
export function latin1(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): string {
  let text = '';
  const stop = Math.min(end, bytes.length);
  for (let index = start; index < stop; index += 0x8000)
    text += String.fromCharCode(
      ...bytes.subarray(index, Math.min(stop, index + 0x8000)),
    );
  return text;
}

/**
 * Forward variable-width integer used by index entries: seven bits per byte,
 * the high bit marks the final byte.
 */
export function readForwardVarLength(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly length: number } {
  let value = 0;
  for (let length = 1; length <= 5; length += 1) {
    const byte = u8(bytes, offset + length - 1);
    value = value * 128 + (byte & 0x7f);
    if (byte & 0x80) return { value, length };
  }
  throw new Kf8FormatError('Unterminated variable-width integer.');
}

/** Backward variable-width integer that sizes a text record's trailing entry. */
export function readBackwardVarLength(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes.subarray(Math.max(0, bytes.length - 4))) {
    if (byte & 0x80) value = 0;
    value = (value << 7) | (byte & 0x7f);
  }
  return value;
}

/** Kindle link numbers use base 32 with the digits 0-9 and A-V. */
export function parseBase32(text: string): number {
  const value = Number.parseInt(text, 32);
  if (!Number.isFinite(value) || value < 0)
    throw new Kf8FormatError(`Invalid base-32 number: ${text}`);
  return value;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function startsWithAscii(bytes: Uint8Array, magic: string): boolean {
  if (bytes.length < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1)
    if (bytes[index] !== magic.charCodeAt(index)) return false;
  return true;
}
