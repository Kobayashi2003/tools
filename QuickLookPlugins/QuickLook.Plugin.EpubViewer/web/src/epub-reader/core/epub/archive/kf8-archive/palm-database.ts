import { Kf8FormatError, latin1, u16, u32 } from './binary';

const HEADER_LENGTH = 78;
const RECORD_ENTRY_LENGTH = 8;

/** The Palm database container every MOBI/AZW3 file is stored in. */
export class PalmDatabase {
  private constructor(
    private readonly bytes: Uint8Array,
    private readonly offsets: readonly number[],
  ) {}

  static parse(bytes: Uint8Array, maxRecords: number): PalmDatabase {
    if (bytes.length < HEADER_LENGTH)
      throw new Kf8FormatError('The file is too short to be a Kindle book.');
    if (latin1(bytes, 60, 68) !== 'BOOKMOBI')
      throw new Kf8FormatError('The file is not a Kindle MOBI/AZW3 book.');
    const count = u16(bytes, 76);
    if (count === 0 || count > maxRecords)
      throw new Kf8FormatError(`Unsupported record count ${count}.`);
    const offsets: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = u32(bytes, HEADER_LENGTH + index * RECORD_ENTRY_LENGTH);
      const previous = offsets.at(-1) ?? 0;
      if (offset < previous || offset > bytes.length)
        throw new Kf8FormatError(`Record ${index} has an invalid offset.`);
      offsets.push(offset);
    }
    return new PalmDatabase(bytes, offsets);
  }

  get recordCount(): number {
    return this.offsets.length;
  }

  /** A view of one record; callers must not modify it. */
  record(index: number): Uint8Array {
    if (!Number.isInteger(index) || index < 0 || index >= this.offsets.length)
      throw new Kf8FormatError(`Record ${index} does not exist.`);
    const start = this.offsets[index]!;
    const end = this.offsets[index + 1] ?? this.bytes.length;
    return this.bytes.subarray(start, end);
  }
}
