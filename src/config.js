// Per-build randomization. Given a seed, produces deterministic numeric
// constants used across the pipeline (opcode ids, cipher seeds, etc.).

'use strict';

const { makeOpcodeMap } = require('./opcodes');

// Mulberry32 PRNG — tiny, deterministic.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeConfig(seed) {
  const rand = mulberry32(seed >>> 0);
  const randInt = (n) => Math.floor(rand() * n);
  const opMap = makeOpcodeMap(rand);
  const MODULUS = Math.pow(2, 25);
  const cfg = {
    seed: seed >>> 0,
    rand,
    randInt,
    opMap,
    cipher: {
      modulus: MODULUS,
      seed_a: randInt(MODULUS),
      seed_b: randInt(MODULUS),
      salt_a: randInt(MODULUS),
      salt_b: randInt(MODULUS),
      C1: 1 + randInt(MODULUS - 1),
      C2: randInt(MODULUS),
      C3: 1 + randInt(MODULUS - 1),
      C4: randInt(MODULUS),
      envConst: 1 + randInt(0xffffff),
    },
    // Opaque predicate / variable naming randomness.
    namePrefix: '_0x',
    nameSuffixBits: 16,
    // Dispatch bucket count.
    buckets: 3 + randInt(4), // 3..6
    // Chunker rolling key seed.
    chunkKey: randInt(MODULUS),
    chunkSize: 180 + randInt(80),
    // String key pair.
    strKeyA: 1 + randInt(255),
    strKeyB: 1 + randInt(255),
  };
  return cfg;
}

module.exports = { makeConfig, mulberry32 };
