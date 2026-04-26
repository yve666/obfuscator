// Level 2 pass: rewrite numeric literals as multi-step IIFE arithmetic chains.
// Very targeted — we only rewrite integer literals (0..2^31) appearing in
// bytecode instruction arrays and opcode constants. This keeps the pass safe
// while still scattering constant-derivation chains throughout the output.

'use strict';

function obfNumber(n, rand) {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    return String(n);
  }
  // 3-4 step chain: ((a + b) * c - d) where final result = n.
  const steps = 3 + Math.floor(rand() * 2);
  let val = n;
  const ops = [];
  for (let i = 0; i < steps; i++) {
    const pick = Math.floor(rand() * 3);
    if (pick === 0) {
      const delta = Math.floor(rand() * 0x10000);
      ops.push({ kind: '+', arg: delta });
      val -= delta;
    } else if (pick === 1) {
      const delta = Math.floor(rand() * 0x1000);
      ops.push({ kind: '-', arg: delta });
      val += delta;
    } else {
      const mult = 2 + Math.floor(rand() * 6);
      if (val % mult === 0 && val / mult < 0x7fffffff) {
        ops.push({ kind: '*', arg: mult });
        val = val / mult;
      }
    }
  }
  // Build expression: start with val, then unwind ops.
  let expr = String(val);
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (o.kind === '+') expr = '(' + expr + '+' + o.arg + ')';
    else if (o.kind === '-') expr = '(' + expr + '-' + o.arg + ')';
    else expr = '(' + expr + '*' + o.arg + ')';
  }
  return expr;
}

function predicatePass(src, cfg) {
  // Replace numeric literals only inside `insns = { ... }` blocks.
  return src.replace(/insns\s*=\s*\{([^{}]*)\}/g, (match, inner) => {
    const obf = inner.replace(/-?\d+/g, (numStr) => obfNumber(parseInt(numStr, 10), cfg.rand));
    return 'insns={' + obf + '}';
  });
}

module.exports = { predicatePass };
