import assert from 'node:assert/strict';
import test from 'node:test';
import { detectNnnEngine } from './nnn-engine.mjs';

function createExecutable() {
  const executable = Buffer.alloc(0x400);
  const pe = 0x40;
  const optionalSize = 0xe0;
  const section = pe + 24 + optionalSize;
  executable.writeUInt16LE(0x5a4d);
  executable.writeUInt32LE(pe, 0x3c);
  executable.writeUInt32LE(0x4550, pe);
  executable.writeUInt16LE(0x14c, pe + 4);
  executable.writeUInt16LE(1, pe + 6);
  executable.writeUInt16LE(optionalSize, pe + 20);
  executable.writeUInt16LE(0x10b, pe + 24);
  executable.writeUInt32LE(0x1000, section + 12);
  executable.writeUInt32LE(0x200, section + 16);
  executable.writeUInt32LE(0x200, section + 20);
  executable.writeUInt32LE(0x20000000, section + 36);
  const code = executable.subarray(0x200);
  code.write('81f9010066660f84', 0, 'hex');
  code.writeInt32LE(0x20 - 12, 8);
  code.write('03d8899e100900008b8610090000', 0x20, 'hex');
  code.write('81ff08003333751053558bcee8', 0x40, 'hex');
  code.writeInt32LE(0x80 - 0x51, 0x4d);
  code.write(
    '837c2414ff75218b8c900000000057e800000000c1e60689bc9000000000',
    0x80,
    'hex',
  );
  return { executable, code };
}

test('reports a unique skip instruction and voice dispatcher', () => {
  const { executable } = createExecutable();
  const engine = detectNnnEngine(executable);
  assert.equal(engine?.skipInstructionRva, 0x1000);
  assert.equal(engine?.voiceDispatchRva, 0x1040);
});

test('rejects two matching skip instructions in one executable section', () => {
  const { executable, code } = createExecutable();
  code.copy(code, 0xc0, 0, 8);
  code.writeInt32LE(0x20 - 0xcc, 0xc8);
  assert.equal(detectNnnEngine(executable), null);
});
