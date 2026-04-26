// Level 1 pass: rename locals in the generated VM source to `_0x####` hex names.
// The VM template uses a controlled vocabulary of local names; we enumerate them
// and replace each with a unique random name. Field accesses (e.g. `proto.insns`)
// are NOT renamed because we use a negative-lookbehind for `.`.

'use strict';

const { OPCODES } = require('../opcodes');

// Full list of top-level locals declared in the VM template + pre-rename
// passes. Any identifier in this list gets replaced with `_0x####` during
// the rename pass, so there's no human-readable name left for an analyst
// (or AI model) to grep for.
const VM_LOCALS = [
  // ----- vm-template.js locals -----
  '_mfloor', '_sel', '_tp', '_smt', '_gmt', '_unpack', '_err', '_glob',
  'BIAS', 'FIELD_MASK', 'SHIFT_B', 'SHIFT_C', 'SHIFT_OP', 'RK_K_OFFSET',
  'execute', 'rk', 'make_closure',
  'MAIN',
  // Inside execute (distinct from field-key names):
  'prt', 'ins', 'cst', 'prs', 'mstk', 'R', 'nargs', 'nparams',
  'argsArr', 'varargs', 'nvararg', 'pc', 'top', 'ninst', 'inst', 'A', 'B', 'C',
  'op', 'upvals', 'sub_proto', '_uvs', 'ui', 'uB', 'uop',
  'f', 'args', 'results', 'got', 'want', 'nargs_call', 'n', 't', 'step',
  'eq', 'lt', 'le', 'cond', 'res', 's', 'var', 'box', 'obj',
  // Inside rk:
  'K', 'x',
  // Polymorphic dispatch helper.
  '_bk',
  // ----- cipher.js helpers -----
  // These names used to survive rename untouched, giving an analyst a
  // plaintext map of the inner decode pipeline (`_decrypt`, `_xor25`,
  // `_enc`, `_lo`, `_hi`, …). Include them here so rename normalises them
  // to the same `_0x####` namespace as every other local.
  '_decrypt', '_xor25', '_mod', '_C1', '_C2', '_C3', '_C4',
  '_enc', '_lo', '_hi',
  // Lazy-decrypt box + per-fetch cipher locals (pass B). The box itself
  // holds all persistent state; the inline fetch block just needs short
  // local names for intermediate XOR values.
  '_ibox', '_lv',
  '_e', '_el', '_eh', '_m1l', '_m1h', '_al', '_ah',
  // ----- compress.js helpers -----
  '_b85dec', '_rcdec', '_int7',
  // Internal locals of the base85 decoder emitted by luaBase85Decoder. These
  // are concatenated with `_b85dec` as a prefix in the template, so they
  // appear in output as a single identifier that rename's word-boundary
  // regex wouldn't otherwise touch.
  '_b85dec_alpha', '_b85dec_rev',
];

// OP_NAME constants used to be a plaintext prelude for L1+ builds; rename
// replaced them alongside other locals. vm-template.js now only emits that
// prelude for L0 (where rename does not run), so these are redundant — but
// left in for defence-in-depth in case a future pass re-introduces them.
for (const op of OPCODES) VM_LOCALS.push('OP_' + op);

function randomHexName(rand, used) {
  for (let i = 0; i < 10; i++) {
    const n = Math.floor(rand() * 0x10000);
    const name = '_0x' + n.toString(16).padStart(4, '0');
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  // Fallback with 8 digits.
  const n = Math.floor(rand() * 0x100000000);
  const name = '_0x' + n.toString(16).padStart(8, '0');
  used.add(name);
  return name;
}

function renamePass(src, cfg) {
  const used = new Set();
  const map = {};
  for (const name of VM_LOCALS) {
    map[name] = randomHexName(cfg.rand, used);
  }
  // Sort keys by length descending so that longer names are replaced first.
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`(?<![.\\w])${escapeRegExp(k)}(?![\\w])`, 'g');
    src = src.replace(re, map[k]);
  }
  return src;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { renamePass, VM_LOCALS };
