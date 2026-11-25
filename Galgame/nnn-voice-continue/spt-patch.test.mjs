import assert from 'node:assert/strict';
import test from 'node:test';
import { patchScript } from './spt-patch.mjs';

const standardLayout = { headerSizes: [20], voiceStopSize: 6 };
const extendedLayout = { headerSizes: [32], voiceStopSize: 7 };
const messageIndex = [5, 0x66660007, 0x3333001b, 1, 8];
const dialogueStop = [6, 0x66660007, 0x33330008, 2, 0xffffffff, 0];
const skippedStop = [6, 0x66660001, ...dialogueStop.slice(2)];
const soundvoicePlay = [8, 0x66660007, 0x33330008, 4, 21, 2, 0, 1];
const soundvoiceStop = [6, 0x66660007, 0x33330008, 2, 0xffffffff, 3];
const soundEffect = [6, 0x66660007, 0x33330009, 2, 20, 0];
const text = [5, 0x66660006, 0x22220001, 7, 8];

function createScript(records, headerSize = 20) {
  const code = records.flat();
  const header = Array(headerSize).fill(0);
  header[0] = headerSize;
  header[1] = 0x66660001;
  header[2] = 0x55550001;
  header[9] = headerSize + code.length + 4;
  header[12] = 0x48545053;
  header[13] = 0x45444145;
  header[14] = 0x20203052;
  const words = [
    ...header,
    ...code,
    5,
    0x66660001,
    0x55550002,
    0x44440003,
    headerSize,
  ];
  const bytes = Buffer.alloc(words.length * 4);
  words.forEach((word, index) => bytes.writeUInt32LE(~word >>> 0, index * 4));
  return bytes;
}

test('continues dialogue on a page with soundvoice and ordinary effects', () => {
  const effects = [soundvoicePlay, soundvoiceStop, soundEffect];
  const original = createScript([messageIndex, dialogueStop, ...effects, text]);
  const expected = createScript([messageIndex, skippedStop, ...effects, text]);
  assert.deepEqual(patchScript(original, 'effects.spt', standardLayout), {
    patched: expected,
    changes: 1,
  });
});

test('preserves stops for new dialogue, the second dialogue channel, or timed messages', () => {
  const nextDialogue = [6, 0x66660007, 0x33330008, 2, 42, 0];
  const secondDialogueStop = [...dialogueStop.slice(0, -1), 1];
  const timedMessage = [5, 0x66660006, 0x22220004, 1, 8];
  for (const records of [
    [messageIndex, dialogueStop, soundvoicePlay, nextDialogue, text],
    [messageIndex, dialogueStop, soundvoiceStop, secondDialogueStop, text],
    [messageIndex, dialogueStop, timedMessage],
  ]) {
    const original = createScript(records);
    assert.deepEqual(patchScript(original, 'scene.spt', standardLayout), {
      patched: original,
      changes: 0,
    });
  }
});

test('supports the extended soundvoice record layout', () => {
  const stop = [7, ...dialogueStop.slice(1), 0];
  const soundvoice = [9, ...soundvoicePlay.slice(1), 0];
  const message = [6, ...text.slice(1), 0];
  const original = createScript([messageIndex, stop, soundvoice, message], 32);
  const expected = createScript(
    [messageIndex, [7, 0x66660001, ...stop.slice(2)], soundvoice, message],
    32,
  );
  assert.deepEqual(patchScript(original, 'extended.spt', extendedLayout), {
    patched: expected,
    changes: 1,
  });
});

test('rejects a script containing an already skipped dialogue stop', () => {
  const partial = createScript([
    messageIndex,
    skippedStop,
    text,
    messageIndex,
    dialogueStop,
    soundvoicePlay,
    text,
  ]);
  assert.throws(
    () => patchScript(partial, 'partial.spt', standardLayout),
    /Use the original SPT file/,
  );
});
