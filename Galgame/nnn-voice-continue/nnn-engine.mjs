function pattern(hex) {
  if (!/^[0-9a-f]{2}(?:\s+(?:[0-9a-f]{2}|\?\?))*$/i.test(hex)) {
    throw new Error(`Invalid engine signature: ${hex}`);
  }
  const bytes = hex
    .split(/\s+/)
    .map((byte) => (byte === '??' ? null : parseInt(byte, 16)));
  const wildcard = bytes.indexOf(null);
  return {
    bytes,
    prefix: Buffer.from(wildcard < 0 ? bytes : bytes.slice(0, wildcard)),
  };
}

function matches(code, offset, { bytes }) {
  return (
    offset >= 0 &&
    offset + bytes.length <= code.length &&
    bytes.every((byte, i) => byte === null || code[offset + i] === byte)
  );
}

function* findMatches(code, signature) {
  for (
    let offset = code.indexOf(signature.prefix);
    offset !== -1;
    offset = code.indexOf(signature.prefix, offset + 1)
  ) {
    if (matches(code, offset, signature)) yield offset;
  }
}

// The VM compares the record type with 0x66660001. On equality it adds
// the record length to its program counter at this+0x910.
const skipJump = pattern('81 f9 01 00 66 66 0f 84');
const addRecordLength = pattern('03 d8 89 9e 10 09 00 00 8b 86 10 09 00 00');
const leaRecordLength = pattern('8d 04 1a 89 86 10 09 00 00 8b 86 10 09 00 00');
const inlineRecordLength = pattern(
  '81 7d fc 01 00 66 66 75 38 8b 8d ?? ?? ff ff 8b 91 10 09 00 00 ' +
    '8b 85 ?? ?? ff ff 8b 88 08 09 00 00 8b 85 ?? ?? ff ff 8b 80 10 09 00 00 ' +
    '03 04 91 8b 8d ?? ?? ff ff 89 81 10 09 00 00',
);

const layouts = [
  {
    id: 'spt-20-word-header',
    headerSizes: [20],
    voiceStopSize: 6,
    skipTarget: addRecordLength,
    voiceDispatch: pattern('81 ff 08 00 33 33 75 10 53 55 8b ce e8'),
    stopBranches: [
      pattern(
        '83 7c 24 14 ff 75 21 8b 8c ?? ?? ?? 00 00 57 e8 ?? ?? ?? ?? ' +
          'c1 ?? 06 89 bc ?? ?? ?? 00 00',
      ),
    ],
  },
  {
    id: 'spt-20-or-32-word-header',
    headerSizes: [20, 32],
    voiceStopSize: 6,
    voiceDispatch: pattern(
      '81 7d 08 08 00 33 33 75 10 8b ?? 10 ?? 8b ?? 0c ?? 8b 4d ?? e8',
    ),
    stopBranches: [
      pattern(
        '83 7d ?? ff 75 2d 6a 00 8b ?? ?? 8b ?? ?? 8b 8c ?? ?? ?? 00 00 e8 ?? ?? ?? ?? 8b ?? ?? c1 ?? 04',
      ),
      pattern(
        '83 7d ?? ff 75 37 8b 45 ?? 8b 88 ?? ?? 00 00 51 6a 00 8b 55 ?? 52 8b 45 ?? 8b 88 ?? ?? 00 00 e8',
      ),
    ],
  },
  {
    id: 'spt-32-word-header-extended-voice',
    headerSizes: [32],
    voiceStopSize: 7,
    skipTarget: leaRecordLength,
    voiceDispatch: pattern(
      '81 ff 08 00 33 33 75 15 ff 75 14 8b ce 53 ff 75 0c e8',
    ),
    stopBranches: [
      pattern(
        '83 f9 ff 75 2b ff b7 ?? ?? 00 00 51 8b 8f ?? ?? 00 00 56 e8 ?? ?? ?? ?? ' +
          '8b 87 ?? ?? 00 00 c1 e6 06 8b 40 14 c7 04 06 00 00 00 00',
      ),
    ],
  },
];

function* executableSections(exe) {
  if (exe.length < 64 || exe.readUInt16LE(0) !== 0x5a4d) return;
  const pe = exe.readUInt32LE(0x3c);
  if (
    pe + 24 > exe.length ||
    exe.readUInt32LE(pe) !== 0x4550 ||
    exe.readUInt16LE(pe + 4) !== 0x14c ||
    exe.readUInt16LE(pe + 22) & 0x2000
  )
    return;

  const optionalSize = exe.readUInt16LE(pe + 20);
  const table = pe + 24 + optionalSize;
  const count = exe.readUInt16LE(pe + 6);
  if (
    optionalSize < 2 ||
    table + count * 40 > exe.length ||
    exe.readUInt16LE(pe + 24) !== 0x10b
  )
    return;

  for (let entry = table; entry < table + count * 40; entry += 40) {
    const size = exe.readUInt32LE(entry + 16);
    const start = exe.readUInt32LE(entry + 20);
    const flags = exe.readUInt32LE(entry + 36);
    if (
      flags & 0x20000000 &&
      size > 0 &&
      start >= table + count * 40 &&
      start + size <= exe.length
    ) {
      yield {
        code: exe.subarray(start, start + size),
        rva: exe.readUInt32LE(entry + 12),
      };
    }
  }
}

function relativeTarget(code, displacement) {
  if (displacement + 4 > code.length) return -1;
  const target = displacement + 4 + code.readInt32LE(displacement);
  return target >= 0 && target < code.length ? target : -1;
}

function* findSkips(code, skipTarget) {
  if (!skipTarget) {
    yield* findMatches(code, inlineRecordLength);
    return;
  }
  for (const offset of findMatches(code, skipJump)) {
    if (
      matches(
        code,
        relativeTarget(code, offset + skipJump.bytes.length),
        skipTarget,
      )
    )
      yield offset;
  }
}

function* findVoiceDispatches(code, { voiceDispatch, stopBranches }) {
  for (const offset of findMatches(code, voiceDispatch)) {
    const handler = relativeTarget(code, offset + voiceDispatch.bytes.length);
    if (handler < 0) continue;
    const body = code.subarray(handler, handler + 0x500);
    if (stopBranches.some((branch) => !findMatches(body, branch).next().done))
      yield offset;
  }
}

export function detectNnnEngine(exe) {
  const sections = [...executableSections(exe)];
  const detected = [];
  for (const layout of layouts) {
    for (const { code, rva } of sections) {
      const skips = [...findSkips(code, layout.skipTarget)];
      if (skips.length === 0) continue;
      const dispatches = [...findVoiceDispatches(code, layout)];
      if (dispatches.length === 0) continue;
      if (skips.length !== 1 || dispatches.length !== 1) return null;
      detected.push({
        id: layout.id,
        headerSizes: layout.headerSizes,
        voiceStopSize: layout.voiceStopSize,
        skipInstructionRva: rva + skips[0],
        voiceDispatchRva: rva + dispatches[0],
      });
    }
  }
  return detected.length === 1 ? detected[0] : null;
}
