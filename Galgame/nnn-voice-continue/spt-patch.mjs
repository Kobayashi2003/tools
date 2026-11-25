const skipRecord = 0x66660001;
const messageRecord = 0x66660006;
const commandRecord = 0x66660007;
const messageIndex = 0x3333001b;
const voiceCommand = 0x33330008;
const soundEffectCommand = 0x33330009;
const textOpcodes = new Set([0x22220001, 0x22220002, 0x22220003]);
const noVoice = 0xffffffff;

function readRecords(bytes, name, headerSizes) {
  const word = (index) => ~bytes.readUInt32LE(index * 4) >>> 0;
  if (
    bytes.length < 80 ||
    bytes.length % 4 !== 0 ||
    !headerSizes.includes(word(0)) ||
    word(1) !== skipRecord ||
    word(2) !== 0x55550001 ||
    word(12) !== 0x48545053 ||
    word(13) !== 0x45444145 ||
    word(14) !== 0x20203052
  ) {
    throw new Error(`${name}: unrecognized SPT header`);
  }

  const headerSize = word(0);
  const labelTable = word(9);
  const codeEnd = labelTable - 4;
  if (
    codeEnd < headerSize ||
    labelTable >= bytes.length / 4 ||
    word(codeEnd + 1) !== skipRecord ||
    word(codeEnd + 2) !== 0x55550002 ||
    word(codeEnd + 3) !== 0x44440003
  ) {
    throw new Error(`${name}: invalid SPT label table`);
  }

  const records = [];
  for (let index = headerSize; index < codeEnd;) {
    const size = word(index);
    const kind = word(index + 1);
    if (size < 3 || index + size > codeEnd || kind >>> 16 !== 0x6666) {
      throw new Error(`${name}: invalid SPT record at byte ${index * 4}`);
    }
    records.push({ index, size, kind, opcode: word(index + 2) });
    index += size;
  }
  const operand = (record, offset) => word(record.index + 3 + offset);
  return { records, operand, messageSize: headerSize === 20 ? 5 : 6 };
}

function isDialogueStop(record, operand, voiceStopSize) {
  return (
    record.opcode === voiceCommand &&
    record.size === voiceStopSize &&
    operand(record, 0) === 2 &&
    operand(record, 1) === noVoice &&
    operand(record, 2) === 0 &&
    (voiceStopSize === 6 || operand(record, 3) === 0)
  );
}

export function patchScript(bytes, name, { headerSizes, voiceStopSize }) {
  const { records, operand, messageSize } = readRecords(
    bytes,
    name,
    headerSizes,
  );
  const patched = Buffer.from(bytes);
  let changes = 0;

  for (const [i, marker] of records.entries()) {
    if (
      marker.kind === skipRecord &&
      isDialogueStop(marker, operand, voiceStopSize)
    ) {
      throw new Error(
        `${name}: already contains a skipped dialogue stop. Use the original SPT file.`,
      );
    }
    if (
      marker.kind !== commandRecord ||
      marker.opcode !== messageIndex ||
      marker.size !== 5 ||
      operand(marker, 0) !== 1 ||
      operand(marker, 1) === noVoice
    ) {
      continue;
    }

    const dialogueStops = [];
    let next = i + 1;
    for (; next < records.length; next++) {
      const record = records[next];
      if (record.kind !== commandRecord) break;
      if (record.opcode === soundEffectCommand) continue;
      if (isDialogueStop(record, operand, voiceStopSize)) {
        dialogueStops.push(record);
        continue;
      }
      if (
        record.opcode !== voiceCommand ||
        record.size < voiceStopSize ||
        record.size !== voiceStopSize + operand(record, 0) - 2
      ) {
        break;
      }
      // Soundvoice uses channels 2 and 3 independently of dialogue.
      const channel = operand(record, 2);
      if (channel !== 2 && channel !== 3) break;
    }

    const message = records[next];
    if (
      dialogueStops.length === 0 ||
      message?.kind !== messageRecord ||
      !textOpcodes.has(message.opcode) ||
      message.size !== messageSize ||
      operand(message, 1) !== operand(marker, 1)
    ) {
      continue;
    }

    for (const { index } of dialogueStops) {
      // Keep the original length so VM offsets and jumps stay valid.
      patched.writeUInt32LE(~skipRecord >>> 0, (index + 1) * 4);
      changes++;
    }
  }
  return { patched, changes };
}
