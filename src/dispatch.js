// Polymorphic dispatch generator for the VM.
//
// The original vm-template emitted a single if/elseif chain over every opcode.
// Across builds the chain text was identical except for the numeric opcode
// constants — handler bodies pattern-match perfectly between builds.
//
// This module takes the per-build seeded PRNG and:
//
//   - splits the opcode handlers into N buckets (N ∈ {3..6} per build);
//   - emits an outer `if/elseif` over `op % N`, with each bucket containing
//     an inner `if/elseif` over the actual opcode;
//   - shuffles bucket order AND the order of opcodes inside each bucket;
//   - optionally injects a small random-but-inert decoration before each
//     handler body (e.g. `local _0x#### = R[A]`) so two builds' handlers
//     don't have byte-identical bodies.
//
// The handler bodies themselves are stored here as fragments of Lua that
// reference the surrounding execute() locals (R, cst, prs, upvals, pc, top,
// varargs, nvararg, BIAS, SHIFT_*, RK_K_OFFSET, _mfloor, _sel, _unpack, _err,
// _glob, make_closure). Keep this module's identifiers in sync with
// vm-template.js if you change them there.

'use strict';

const { OPCODES } = require('./opcodes');

// Helper: given an opcode opMap plus a name, emit the raw integer literal for
// that opcode. Previously we emitted `OP_${name}` and relied on a plaintext
// `local OP_NAME = N` prelude that spelled out the entire opcode map for any
// reader. We now emit the raw integer (already randomized per build by
// makeOpcodeMap) and drop the prelude — an analyst can no longer pattern
// match an opcode name to a handler body.
function opLit(opMap, name) {
  const id = opMap.nameToId[name];
  if (id === undefined) throw new Error('no opcode id for ' + name);
  return String(id);
}

// Each handler body assumes A, B, C, op are already decoded in the dispatch
// loop's local scope. They mutate R / pc / top / etc. as needed.
const HANDLERS = {
  MOVE: 'R[A] = R[B]',
  LOADK: 'R[A] = cst[B + 1]',
  LOADBOOL: 'R[A] = (B ~= 0); if C ~= 0 then pc = pc + 1 end',
  LOADNIL: 'for i = A, B do R[i] = nil end',
  GETGLOBAL: 'R[A] = _glob[cst[B + 1]]',
  SETGLOBAL: '_glob[cst[B + 1]] = R[A]',
  GETUPVAL: 'R[A] = upvals[B + 1].v',
  SETUPVAL: 'upvals[B + 1].v = R[A]',
  GETTABLE: 'R[A] = R[B][rk(R, cst, C)]',
  SETTABLE: 'R[A][rk(R, cst, B)] = rk(R, cst, C)',
  NEWTABLE: 'R[A] = {}',
  SELF: 'do local obj = R[B]; R[A + 1] = obj; R[A] = obj[rk(R, cst, C)] end',
  ADD: 'R[A] = rk(R, cst, B) + rk(R, cst, C)',
  SUB: 'R[A] = rk(R, cst, B) - rk(R, cst, C)',
  MUL: 'R[A] = rk(R, cst, B) * rk(R, cst, C)',
  DIV: 'R[A] = rk(R, cst, B) / rk(R, cst, C)',
  MOD: 'R[A] = rk(R, cst, B) % rk(R, cst, C)',
  POW: 'R[A] = rk(R, cst, B) ^ rk(R, cst, C)',
  UNM: 'R[A] = -R[B]',
  NOT: 'R[A] = not R[B]',
  LEN: 'R[A] = #R[B]',
  CONCAT: 'do local s = R[B]; for i = B + 1, C do s = s .. R[i] end; R[A] = s end',
  JMP: 'pc = pc + B',
  EQ: 'do local eq = (rk(R, cst, B) == rk(R, cst, C)); if not (eq == (A ~= 0)) then pc = pc + 1 end end',
  LT: 'do local lt = (rk(R, cst, B) < rk(R, cst, C)); if not (lt == (A ~= 0)) then pc = pc + 1 end end',
  LE: 'do local le = (rk(R, cst, B) <= rk(R, cst, C)); if not (le == (A ~= 0)) then pc = pc + 1 end end',
  TEST: 'do local cond = not not R[A]; if not (cond == (C ~= 0)) then pc = pc + 1 end end',
  CALL: `do
      local f = R[A]
      local nargs_call
      if B == 0 then nargs_call = top - A - 1 else nargs_call = B - 1 end
      local args = {}
      for i = 1, nargs_call do args[i] = R[A + i] end
      local results = { f(_unpack(args, 1, nargs_call)) }
      local got = #results
      if C == 0 then
        for i = 1, got do R[A + i - 1] = results[i] end
        for i = got + 1, got + 4 do R[A + i - 1] = nil end
        top = A + got
      elseif C == 1 then
        -- drop all
      else
        local want = C - 1
        for i = 1, want do R[A + i - 1] = results[i] end
        for i = got + 1, want do R[A + i - 1] = nil end
      end
    end`,
  TAILCALL: `do
      local f = R[A]
      local nargs_call
      if B == 0 then nargs_call = top - A - 1 else nargs_call = B - 1 end
      local args = {}
      for i = 1, nargs_call do args[i] = R[A + i] end
      return f(_unpack(args, 1, nargs_call))
    end`,
  RETURN: `do
      if B == 0 then
        local res = {}
        local n = top - A
        for i = 0, n - 1 do res[i + 1] = R[A + i] end
        return _unpack(res, 1, n)
      elseif B == 1 then
        return
      else
        local n = B - 1
        local res = {}
        for i = 0, n - 1 do res[i + 1] = R[A + i] end
        return _unpack(res, 1, n)
      end
    end`,
  FORLOOP: `do
      R[A] = R[A] + R[A + 2]
      local step = R[A + 2]
      if (step > 0 and R[A] <= R[A + 1]) or (step <= 0 and R[A] >= R[A + 1]) then
        pc = pc + B
        R[A + 3] = R[A]
      end
    end`,
  FORPREP: 'R[A] = R[A] - R[A + 2]; pc = pc + B',
  TFORLOOP: `do
      local f = R[A]
      local s = R[A + 1]
      local var = R[A + 2]
      local results = { f(s, var) }
      local nres = C
      for i = 1, nres do R[A + 2 + i] = results[i] end
      if R[A + 3] ~= nil then
        R[A + 2] = R[A + 3]
      else
        pc = pc + 1
      end
    end`,
  SETLIST: `do
      local t = R[A]
      local n = (B == 0) and (top - A - 1) or B
      local offset = (C - 1) * 50
      for i = 1, n do t[offset + i] = R[A + i] end
    end`,
  CLOSE: '-- no-op under our box model',
  // CLOSURE's body has to read the upvalue-binding opcode of the following
  // pseudo-instructions inline. The id comparison against OP_MOVE /
  // OP_GETUPVAL used to be by symbol; we now rewrite the body at build time
  // via __CLOSURE_OP_MOVE__ / __CLOSURE_OP_GETUPVAL__ placeholders so the
  // builder can plug in the raw integer ids for this build.
  CLOSURE: `do
      local sub_proto = prs[B + 1]
      local _uvs = {}
      for i = 1, #sub_proto.upvs do
        local ui = ins[pc]
        local uB = (_mfloor(ui / SHIFT_B) % SHIFT_B) - BIAS
        local uop = _mfloor(ui / SHIFT_OP)
        pc = pc + 1
        if uop == __CLOSURE_OP_MOVE__ then
          _uvs[i] = R[uB]
        elseif uop == __CLOSURE_OP_GETUPVAL__ then
          _uvs[i] = upvals[uB + 1]
        else
          _err("bad upvalue binding opcode " .. tostring(uop))
        end
      end
      R[A] = make_closure(sub_proto, _uvs)
    end`,
  VARARG: `do
      if B == 0 then
        for i = 1, nvararg do R[A + i - 1] = varargs[i] end
        for i = nvararg + 1, nvararg + 4 do R[A + i - 1] = nil end
        top = A + nvararg
      else
        local want = B - 1
        for i = 1, want do
          if i <= nvararg then R[A + i - 1] = varargs[i] else R[A + i - 1] = nil end
        end
      end
    end`,
  NEWBOX: 'R[A] = { v = R[A] }',
  GETBOX: 'R[A] = R[B].v',
  SETBOX: 'R[B].v = R[A]',
};

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function randHexName(rand) {
  return '_0x' + Math.floor(rand() * 0xffff).toString(16).padStart(4, '0');
}

// Handler-local alias names use a distinct `_h####` prefix so they can't
// collide with the `_0x####` namespace that the rename pass owns (rename
// may reuse a given hex for a VM-wide local, which would shadow our local
// alias and break the handler).
function randHandlerAlias(rand) {
  return '_h' + Math.floor(rand() * 0xfffff).toString(16).padStart(5, '0');
}

// Random inert prologue for a handler body. Returns a string of Lua that
// has no observable effect — reads a register, computes an unused arithmetic
// expression — but makes byte-identical handler bodies between builds rare.
function inertPrologue(rand) {
  if (rand() < 0.4) return ''; // skip about 40% of the time
  const name = randHexName(rand);
  const pick = Math.floor(rand() * 4);
  if (pick === 0) return `local ${name} = R[A]`;
  if (pick === 1) return `local ${name} = (A * ${1 + Math.floor(rand() * 50)} + ${1 + Math.floor(rand() * 50)})`;
  if (pick === 2) return `local ${name} = pc + ${1 + Math.floor(rand() * 100)}; ${name} = ${name} - ${name}`;
  return `local ${name} = #ins`;
}

// Per-handler aliasing: wrap the body in a do/end with per-build random
// locals aliasing `R`, `cst`, and `rk`. Each real opcode gets a different
// set of aliases, so two handlers that implement conceptually similar ops
// (e.g. MOVE and LOADK) don't share an identical reference pattern. This
// breaks AI pattern-matching that keys on `R[A] = ...` style bodies since
// the actual token is no longer `R` but a per-build random hex name.
function mutateHandlerBody(body, rand) {
  // Every identifier we might alias — only substitute whole-word tokens
  // that aren't field accesses (prevents trampling `proto.R` etc., though
  // we don't have those here, defensive).
  const subs = {};
  const decls = [];
  const maybe = (id, prob) => {
    if (rand() < prob) {
      const nm = randHandlerAlias(rand);
      subs[id] = nm;
      decls.push(`local ${nm} = ${id}`);
    }
  };
  // `R` is in ~95% of handler bodies — alias often.
  maybe('R', 0.75);
  // `cst` in ~40% — alias sometimes.
  maybe('cst', 0.45);
  // `rk` in ~40% — alias sometimes.
  maybe('rk', 0.30);

  let mutated = body;
  for (const [k, v] of Object.entries(subs)) {
    const re = new RegExp(`(?<![.\\w])${k}(?![\\w])`, 'g');
    mutated = mutated.replace(re, v);
  }

  // Extra visual noise: with 30% chance, prepend a decoy local read that
  // could plausibly belong to a real op (makes static diffing of matching
  // handlers across builds produce a lot of spurious differences).
  if (rand() < 0.3) {
    const nm = randHandlerAlias(rand);
    const lhsIdx = subs['R'] || 'R';
    const pick = Math.floor(rand() * 3);
    if (pick === 0) decls.push(`local ${nm} = ${lhsIdx}[A]`);
    else if (pick === 1) decls.push(`local ${nm} = A + ${1 + Math.floor(rand() * 40)}`);
    else decls.push(`local ${nm} = (pc + B) % ${7 + Math.floor(rand() * 30)}`);
  }

  if (decls.length === 0) return body;
  // Newline before the body and before `end` is mandatory: some handler
  // bodies begin or end with a `--` comment (e.g. CLOSE, the elseif C==1
  // branch of CALL), and a comment-to-end-of-line would otherwise swallow
  // the trailing `end` if everything is on one line.
  return `do ${decls.join('; ')}\n${mutated}\nend`;
}

// Bodies of plausible-looking decoy handlers. Each is valid Lua that
// references the surrounding execute() locals, but is never executed because
// the opcode id we attach to it is unused. Mixed into each bucket alongside
// real handlers so an analyst cannot tell real from decoy without dynamic
// tracing.
const DECOY_BODIES = [
  'R[A] = rk(R, cst, B) + rk(R, cst, C)',
  'R[A] = R[B] - cst[C + 1]',
  'R[A] = (R[B] == R[C])',
  'R[A] = cst[B + 1]; pc = pc + 1',
  'do local t = R[B]; R[A] = t and t[rk(R, cst, C)] end',
  'R[A] = #cst',
  'pc = pc + B; R[A] = R[A + 1]',
  'R[A] = -rk(R, cst, B)',
  'R[A] = not R[B]',
  'do local s = R[A]; for i = B, C do s = s .. tostring(R[i]) end; R[A] = s end',
];

// Pick a fake opcode id that is in [0..127] but doesn't collide with any real
// opcode id assigned by makeOpcodeMap.
function pickDecoyId(opMap, used, rand) {
  for (let tries = 0; tries < 200; tries++) {
    const id = Math.floor(rand() * 128);
    if (used.has(id)) continue;
    used.add(id);
    return id;
  }
  return null;
}

// Build the dispatch body. `opMap` is the opcode-id map. Returns Lua source
// fragments to inline into vm-template's execute() function.
function buildDispatch(opMap, cfg) {
  const rand = cfg.rand;
  // Pick bucket count between 3 and 6 (inclusive) per build.
  const N = 3 + Math.floor(rand() * 4);
  // Each entry is { kind: 'real'|'decoy', name?: opName, id: number, body: string }
  const buckets = [];
  for (let i = 0; i < N; i++) buckets.push([]);

  // Resolve CLOSURE's opcode-id placeholders once so the inner upvalue-binding
  // switch is also a raw integer comparison with no visible symbol name.
  const closureMoveId = opLit(opMap, 'MOVE');
  const closureUpvalId = opLit(opMap, 'GETUPVAL');

  const usedIds = new Set();
  for (const opName of OPCODES) {
    const id = opMap.nameToId[opName];
    if (id === undefined) throw new Error('no opcode id for ' + opName);
    usedIds.add(id);
    let body = HANDLERS[opName];
    if (opName === 'CLOSURE') {
      body = body
        .replace('__CLOSURE_OP_MOVE__', closureMoveId)
        .replace('__CLOSURE_OP_GETUPVAL__', closureUpvalId);
    }
    // Per-handler shape randomization: wrap body in a do/end with
    // per-build random aliases for R/cst/rk (see mutateHandlerBody). Real
    // and decoy handlers both get this treatment so they remain visually
    // interchangeable.
    body = mutateHandlerBody(body, rand);
    buckets[id % N].push({ kind: 'real', name: opName, id, body });
  }

  // For each bucket inject 1–3 decoy handlers with random unused opcode ids.
  for (const b of buckets) {
    const decoyCount = 1 + Math.floor(rand() * 3);
    for (let d = 0; d < decoyCount; d++) {
      const id = pickDecoyId(opMap, usedIds, rand);
      if (id === null) break;
      let body = DECOY_BODIES[Math.floor(rand() * DECOY_BODIES.length)];
      body = mutateHandlerBody(body, rand);
      // Ensure the decoy lives in the right bucket (id % N).
      buckets[id % N].push({ kind: 'decoy', id, body });
    }
  }

  // Shuffle ordering inside each bucket (real and decoys interleave).
  for (const b of buckets) shuffle(b, rand);
  // Build a permutation of bucket indices for the outer `if`.
  const bucketOrder = [];
  for (let i = 0; i < N; i++) bucketOrder.push(i);
  shuffle(bucketOrder, rand);

  const lines = [];
  lines.push(`local _bk = op % ${N}`);
  let firstBucket = true;
  for (const bIdx of bucketOrder) {
    const arms = buckets[bIdx];
    if (arms.length === 0) continue;
    lines.push((firstBucket ? 'if' : 'elseif') + ` _bk == ${bIdx} then`);
    firstBucket = false;
    let firstArm = true;
    for (const arm of arms) {
      const head = firstArm ? '  if' : '  elseif';
      firstArm = false;
      // Real arms reference OP_X constants; decoy arms use raw integer ids
      // so they look just like a normal handler from a static-analysis
      // perspective (no symbol to grep for).
      // Both real and decoy arms compare against a raw integer literal,
      // so an analyst can no longer distinguish "named" handlers from
      // decoys by looking at the comparison RHS. All ids are already
      // scrambled per build.
      lines.push(`${head} op == ${arm.id} then`);
      const pre = inertPrologue(rand);
      if (pre) lines.push('    ' + pre);
      lines.push('    ' + arm.body);
    }
    lines.push('  else _err("bad opcode " .. tostring(op) .. " at pc " .. tostring(pc - 1)) end');
  }
  lines.push('else _err("bad bucket " .. tostring(_bk)) end');
  return lines.join('\n');
}

module.exports = { buildDispatch, HANDLERS, randHexName };
