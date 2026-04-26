// Packed instruction layout (49 bits total):
//
//   bits  0-13 : A     (14 bits, biased by 4096 → logical [-4096, 12287])
//   bits 14-27 : B     (14 bits, biased by 4096 → logical [-4096, 12287])
//   bits 28-41 : C     (14 bits, biased by 4096 → logical [-4096, 12287])
//   bits 42-48 : opcode (7 bits, 0..127)
//
// All three operand fields share the same -4096 bias so any field can carry a
// register index, a K-index (via RK_K_OFFSET) or a signed jump offset.
// The cipher modulus (2^25) decomposes any 49-bit instruction as lo (<2^25) +
// hi*2^25 with hi < 2^24, which stays comfortably inside the modulus.

'use strict';

const OPCODES = [
  'MOVE', 'LOADK', 'LOADBOOL', 'LOADNIL',
  'GETGLOBAL', 'SETGLOBAL', 'GETUPVAL', 'SETUPVAL',
  'GETTABLE', 'SETTABLE', 'NEWTABLE', 'SELF',
  'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'POW',
  'UNM', 'NOT', 'LEN', 'CONCAT',
  'JMP', 'EQ', 'LT', 'LE', 'TEST',
  'CALL', 'TAILCALL', 'RETURN',
  'FORLOOP', 'FORPREP', 'TFORLOOP', 'SETLIST',
  'CLOSE', 'CLOSURE', 'VARARG',
  'NEWBOX', 'GETBOX', 'SETBOX',
];

const BIAS = 4096;
const FIELD_MASK = 0x3fff; // 14 bits
const SHIFT_B = Math.pow(2, 14);
const SHIFT_C = Math.pow(2, 28);
const SHIFT_OP = Math.pow(2, 42);
const OPCODE_MAX = 127;

// Values >= RK_K_OFFSET in operand fields encode constants: K[operand - RK_K_OFFSET + 1].
const RK_K_OFFSET = 8192;

function makeOpcodeMap(rand) {
  const ids = [];
  for (let i = 0; i <= OPCODE_MAX; i++) ids.push(i);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const nameToId = {};
  const idToName = {};
  OPCODES.forEach((name, i) => {
    nameToId[name] = ids[i];
    idToName[ids[i]] = name;
  });
  return { nameToId, idToName };
}

function pack(opId, a, b, c) {
  const A = (a + BIAS) & FIELD_MASK;
  const B = (b + BIAS) & FIELD_MASK;
  const C = (c + BIAS) & FIELD_MASK;
  return A + B * SHIFT_B + C * SHIFT_C + opId * SHIFT_OP;
}

function unpack(inst) {
  const A = (inst % SHIFT_B) - BIAS;
  const B = (Math.floor(inst / SHIFT_B) % SHIFT_B) - BIAS;
  const C = (Math.floor(inst / SHIFT_C) % SHIFT_B) - BIAS;
  const op = Math.floor(inst / SHIFT_OP);
  return { op, A, B, C };
}

module.exports = {
  OPCODES,
  BIAS,
  BIAS_A: BIAS, BIAS_B: BIAS, BIAS_C: BIAS,
  FIELD_MASK,
  SHIFT_B, SHIFT_C, SHIFT_OP,
  RK_K_OFFSET,
  makeOpcodeMap, pack, unpack,
};
