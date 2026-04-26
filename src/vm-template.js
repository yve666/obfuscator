// Generates the Lua source of the VM that executes our custom bytecode.
// In "plain" mode (no obfuscation) the output is readable Lua. Obfuscation
// passes mutate this source afterwards.

'use strict';

const {
  OPCODES, BIAS, BIAS_A, BIAS_B, BIAS_C, FIELD_MASK, SHIFT_B, SHIFT_C, SHIFT_OP, RK_K_OFFSET,
} = require('./opcodes');
const { buildDispatch } = require('./dispatch');

function luaQuoteString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20 || c >= 0x7f) out += '\\' + c;
    else out += s[i];
  }
  return out + '"';
}

function luaNumber(n) {
  if (!isFinite(n)) {
    if (Number.isNaN(n)) return '(0/0)';
    return n > 0 ? '(1/0)' : '(-1/0)';
  }
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

function luaValue(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return luaNumber(v);
  if (typeof v === 'string') return luaQuoteString(v);
  throw new Error('luaValue: unsupported ' + typeof v);
}

// Packs a proto into a Lua table literal. `opMap` maps logical opcode names to integer ids.
function emitProto(proto, opMap, out, indent) {
  const pad = ' '.repeat(indent);
  out.push(pad + '{');
  out.push(pad + '  numparams = ' + proto.numParams + ',');
  out.push(pad + '  isvararg = ' + (proto.isVararg ? 'true' : 'false') + ',');
  out.push(pad + '  maxstack = ' + Math.max(proto.maxStack, 2) + ',');
  const instLines = [];
  for (const ins of proto.insns) {
    const opId = opMap.nameToId[ins.op];
    if (opId === undefined) throw new Error('no opcode id for ' + ins.op);
    const A = ((ins.a | 0) + BIAS) & FIELD_MASK;
    const B = ((ins.b | 0) + BIAS) & FIELD_MASK;
    const C = ((ins.c | 0) + BIAS) & FIELD_MASK;
    const packed = A + B * SHIFT_B + C * SHIFT_C + opId * SHIFT_OP;
    instLines.push(luaNumber(packed));
  }
  out.push(pad + '  insns = {' + instLines.join(',') + '},');
  out.push(pad + '  consts = {' + proto.consts.map(luaValue).join(',') + '},');
  if (proto.protos.length > 0) {
    out.push(pad + '  protos = {');
    for (let i = 0; i < proto.protos.length; i++) {
      emitProto(proto.protos[i], opMap, out, indent + 4);
      out.push(pad + '    ,');
    }
    out.push(pad + '  },');
  } else {
    out.push(pad + '  protos = {},');
  }
  const uvs = proto.upvalues.map(u => '{' + (u.fromLocal ? 'true' : 'false') + ',' + u.index + '}');
  out.push(pad + '  upvs = {' + uvs.join(',') + '},');
  out.push(pad + '}');
}

function emitOpcodeConstants(opMap) {
  const lines = [];
  lines.push('-- opcode ids');
  for (const name of OPCODES) {
    lines.push('local OP_' + name + ' = ' + opMap.nameToId[name]);
  }
  return lines.join('\n');
}

// Globals that the VM resolves via GETGLOBAL / SETGLOBAL at runtime.
// Roblox/Luau scripts have most of these in their *environment* (reachable
// via a bare-name lookup), not in `_G` (which is the separate shared-global
// table). We snapshot each one at the top of the VM preamble so the bare
// reference goes through the script env's __index chain at load time, then
// populate `_glob` from the locals. Any global the user references that's
// not listed here falls through to `_G` via a `pairs(_G)` loop at the end
// of the snapshot.
//
// Note: we deliberately do NOT snapshot `loadstring` / `load` / `setfenv` /
// `getfenv` / `getgenv` / `getrenv` by bare name. Those all either (a) live
// in `_G` in any env that has them (so the fallback loop picks them up), or
// (b) are gone in Luau. Including them by bare name would leak a plaintext
// `loadstring` token into the output, which is exactly the signature we
// spent the streaming-loader refactor removing.
const ROBLOX_GLOBALS = [
  // Standard Lua / Luau.
  'assert', 'collectgarbage', 'error', 'getmetatable', 'ipairs', 'next',
  'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen', 'rawset',
  'select', 'setmetatable', 'tonumber', 'tostring', 'type', 'unpack',
  'xpcall',
  // Library tables.
  'math', 'string', 'table', 'os', 'io', 'coroutine', 'debug', 'bit32',
  'utf8',
  // Roblox runtime.
  'game', 'workspace', 'script', 'shared', 'task', 'wait', 'delay',
  'spawn', 'warn', 'tick', 'time', 'typeof', 'Vector2', 'Vector3',
  'CFrame', 'Color3', 'UDim', 'UDim2', 'Instance', 'Enum', 'Ray',
  'Region3', 'BrickColor', 'NumberSequence', 'NumberSequenceKeypoint',
  'ColorSequence', 'ColorSequenceKeypoint', 'NumberRange', 'Rect',
  'TweenInfo', 'Random', 'PhysicalProperties', 'Faces', 'Axes',
  'RaycastParams', 'OverlapParams', 'DateTime',
];

// Decoy global names — bare-name references that resolve to nil in any env
// we care about (Roblox or stock lua5.1). Interleaved with real snapshots to
// hide the real list from static readers — a grep for "snapshotted Roblox
// globals" no longer returns a clean contiguous list of in-use APIs.
const DECOY_GLOBALS = [
  'HttpService', 'UserInputService', 'RunService', 'ReplicatedStorage',
  'Players', 'Lighting', 'SoundService', 'Teams', 'Chat', 'MarketplaceService',
  'DataStoreService', 'BadgeService', 'TeleportService', 'MessagingService',
  'CollectionService', 'ContentProvider', 'InsertService', 'TweenService',
  'TextService', 'PhysicsService', 'PolicyService', 'StarterGui',
  'StarterPack', 'StarterPlayer', 'ServerStorage', 'ServerScriptService',
];

function randSnapLocal(rand) {
  return '_v' + Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0');
}

function emitGlobSnapshot(cfg) {
  const rand = cfg && cfg.rand ? cfg.rand : null;

  // No-cfg path (L0): deterministic, readable, legacy shape.
  if (!rand) {
    const lines = [];
    lines.push('-- snapshot script-env globals into a synthetic _glob table.');
    lines.push('local _glob = {}');
    for (const g of ROBLOX_GLOBALS) {
      lines.push(`do local _v = ${g}; if _v ~= nil then _glob.${g} = _v end end`);
    }
    lines.push('for k, v in pairs(_G) do if _glob[k] == nil then _glob[k] = v end end');
    return lines.join('\n');
  }

  // Polymorphic path: shuffle the snapshot order, mix in decoy lookups for
  // never-present names (each executor/env varies, so "nil" is normal),
  // and randomize every temp local name so pattern matching on `local _v =`
  // no longer betrays which lines are part of the snapshot.
  const entries = [];
  for (const g of ROBLOX_GLOBALS) entries.push({ name: g, real: true });
  for (const g of DECOY_GLOBALS) {
    // Include every decoy name once with ~50% probability.
    if (rand() < 0.5) entries.push({ name: g, real: false });
  }
  // Shuffle entries in place.
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = entries[i]; entries[i] = entries[j]; entries[j] = t;
  }

  const lines = [];
  lines.push('local _glob = {}');
  for (const e of entries) {
    const tmp = randSnapLocal(rand);
    // 3 plausible shapes per entry — chosen at random per line. All three
    // are semantically identical but produce visually different lines.
    const shape = Math.floor(rand() * 3);
    if (shape === 0) {
      lines.push(`do local ${tmp} = ${e.name}; if ${tmp} ~= nil then _glob.${e.name} = ${tmp} end end`);
    } else if (shape === 1) {
      lines.push(`do local ${tmp} = ${e.name}; if ${tmp} ~= nil then _glob["${e.name}"] = ${tmp} end end`);
    } else {
      lines.push(`do local ${tmp} = ${e.name}; _glob[${tmp} ~= nil and "${e.name}" or false] = ${tmp} end`);
    }
  }
  // Fall back to _G for anything we didn't snapshot (stock lua5.1, user
  // globals). Still required for correctness.
  lines.push('for k, v in pairs(_G) do if _glob[k] == nil then _glob[k] = v end end');
  // Scrub the `false` sentinel key produced by shape 2 above.
  lines.push('_glob[false] = nil');
  return lines.join('\n');
}

function buildVM(mainProto, opMap, cfg) {
  const out = [];
  out.push('-- larpfuscator runtime (plain)');
  out.push('local _mfloor = math.floor');
  out.push('local _sel = select');
  out.push('local _tp = type');
  out.push('local _smt = setmetatable');
  out.push('local _gmt = getmetatable');
  out.push('local _unpack = table.unpack or unpack');
  out.push('local _err = error');
  out.push(emitGlobSnapshot(cfg));
  out.push('');
  // Polymorphic builds (cfg provided, i.e. L1+) skip the plaintext
  // `local OP_NAME = id` prelude entirely — dispatch.js inlines the raw
  // opcode ids directly. That prelude is a one-line map of handler name →
  // opcode id and makes AI pattern-matching trivial. L0 (no cfg) keeps
  // it for debuggability.
  if (!cfg) {
    out.push(emitOpcodeConstants(opMap));
    out.push('');
  }
  out.push('local BIAS = ' + BIAS);
  out.push('local FIELD_MASK = ' + FIELD_MASK);
  out.push('local SHIFT_B = ' + SHIFT_B);
  out.push('local SHIFT_C = ' + SHIFT_C);
  out.push('local SHIFT_OP = ' + SHIFT_OP);
  out.push('local RK_K_OFFSET = ' + RK_K_OFFSET);
  out.push('');
  // If we have a config we generate a polymorphic dispatch (per-build buckets,
  // shuffled handler order, random inert prologues). Otherwise (callers that
  // pass no cfg, e.g. tests inspecting the plain template) fall back to the
  // monolithic if/elseif chain in VM_BODY.
  if (cfg) {
    out.push(makePolyVMBody(opMap, cfg));
  } else {
    out.push(VM_BODY);
  }
  out.push('');
  out.push('local MAIN = ');
  emitProto(mainProto, opMap, out, 0);
  out.push('');
  out.push('return execute(MAIN, {}, {...}, _sel("#", ...))');
  return out.join('\n');
}

// Generate the VM body with a per-build polymorphic dispatch loop.
function makePolyVMBody(opMap, cfg) {
  const dispatch = buildDispatch(opMap, cfg);
  return `
local execute

local function rk(R, K, x)
  if x >= RK_K_OFFSET then return K[x - RK_K_OFFSET + 1] end
  return R[x]
end

local function make_closure(sub_proto, _uvs)
  return function(...)
    local n = _sel("#", ...)
    return execute(sub_proto, _uvs, { ... }, n)
  end
end

execute = function(prt, upvals, argsArr, nargs)
  local ins = prt.insns
  local cst = prt.consts
  local prs = prt.protos
  local mstk = prt.maxstack or 64
  local R = {}
  for i = 0, mstk + 16 do R[i] = nil end
  nargs = nargs or 0
  local nparams = prt.numparams
  for i = 1, nparams do R[i - 1] = argsArr[i] end
  local varargs = nil
  local nvararg = 0
  if prt.isvararg then
    varargs = {}
    nvararg = nargs - nparams
    if nvararg < 0 then nvararg = 0 end
    for i = 1, nvararg do varargs[i] = argsArr[nparams + i] end
  end
  local pc = 1
  local top = nparams
  local ninst = #ins
  while pc <= ninst do
    local inst = ins[pc]
    local A = (inst % SHIFT_B) - BIAS
    local B = (_mfloor(inst / SHIFT_B) % SHIFT_B) - BIAS
    local C = (_mfloor(inst / SHIFT_C) % SHIFT_B) - BIAS
    local op = _mfloor(inst / SHIFT_OP)
    pc = pc + 1
${dispatch}
  end
end
`;
}

const VM_BODY = `
local execute

local function rk(R, K, x)
  if x >= RK_K_OFFSET then return K[x - RK_K_OFFSET + 1] end
  return R[x]
end

local function make_closure(sub_proto, _uvs)
  return function(...)
    local n = _sel("#", ...)
    return execute(sub_proto, _uvs, { ... }, n)
  end
end

execute = function(prt, upvals, argsArr, nargs)
  local ins = prt.insns
  local cst = prt.consts
  local prs = prt.protos
  local mstk = prt.maxstack or 64
  local R = {}
  for i = 0, mstk + 16 do R[i] = nil end
  nargs = nargs or 0
  local nparams = prt.numparams
  for i = 1, nparams do R[i - 1] = argsArr[i] end
  local varargs = nil
  local nvararg = 0
  if prt.isvararg then
    varargs = {}
    nvararg = nargs - nparams
    if nvararg < 0 then nvararg = 0 end
    for i = 1, nvararg do varargs[i] = argsArr[nparams + i] end
  end
  local pc = 1
  local top = nparams
  local ninst = #ins
  while pc <= ninst do
    local inst = ins[pc]
    local A = (inst % SHIFT_B) - BIAS
    local B = (_mfloor(inst / SHIFT_B) % SHIFT_B) - BIAS
    local C = (_mfloor(inst / SHIFT_C) % SHIFT_B) - BIAS
    local op = _mfloor(inst / SHIFT_OP)
    pc = pc + 1
    if op == OP_MOVE then
      R[A] = R[B]
    elseif op == OP_LOADK then
      R[A] = cst[B + 1]
    elseif op == OP_LOADBOOL then
      R[A] = (B ~= 0)
      if C ~= 0 then pc = pc + 1 end
    elseif op == OP_LOADNIL then
      for i = A, B do R[i] = nil end
    elseif op == OP_GETGLOBAL then
      R[A] = _glob[cst[B + 1]]
    elseif op == OP_SETGLOBAL then
      _glob[cst[B + 1]] = R[A]
    elseif op == OP_GETUPVAL then
      R[A] = upvals[B + 1].v
    elseif op == OP_SETUPVAL then
      upvals[B + 1].v = R[A]
    elseif op == OP_GETTABLE then
      R[A] = R[B][rk(R, cst, C)]
    elseif op == OP_SETTABLE then
      R[A][rk(R, cst, B)] = rk(R, cst, C)
    elseif op == OP_NEWTABLE then
      R[A] = {}
    elseif op == OP_SELF then
      local obj = R[B]
      R[A + 1] = obj
      R[A] = obj[rk(R, cst, C)]
    elseif op == OP_ADD then
      R[A] = rk(R, cst, B) + rk(R, cst, C)
    elseif op == OP_SUB then
      R[A] = rk(R, cst, B) - rk(R, cst, C)
    elseif op == OP_MUL then
      R[A] = rk(R, cst, B) * rk(R, cst, C)
    elseif op == OP_DIV then
      R[A] = rk(R, cst, B) / rk(R, cst, C)
    elseif op == OP_MOD then
      R[A] = rk(R, cst, B) % rk(R, cst, C)
    elseif op == OP_POW then
      R[A] = rk(R, cst, B) ^ rk(R, cst, C)
    elseif op == OP_UNM then
      R[A] = -R[B]
    elseif op == OP_NOT then
      R[A] = not R[B]
    elseif op == OP_LEN then
      R[A] = #R[B]
    elseif op == OP_CONCAT then
      local s = R[B]
      for i = B + 1, C do s = s .. R[i] end
      R[A] = s
    elseif op == OP_JMP then
      pc = pc + B
    elseif op == OP_EQ then
      local eq = (rk(R, cst, B) == rk(R, cst, C))
      if not (eq == (A ~= 0)) then pc = pc + 1 end
    elseif op == OP_LT then
      local lt = (rk(R, cst, B) < rk(R, cst, C))
      if not (lt == (A ~= 0)) then pc = pc + 1 end
    elseif op == OP_LE then
      local le = (rk(R, cst, B) <= rk(R, cst, C))
      if not (le == (A ~= 0)) then pc = pc + 1 end
    elseif op == OP_TEST then
      local cond = not not R[A]
      if not (cond == (C ~= 0)) then pc = pc + 1 end
    elseif op == OP_CALL then
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
    elseif op == OP_TAILCALL then
      local f = R[A]
      local nargs_call
      if B == 0 then nargs_call = top - A - 1 else nargs_call = B - 1 end
      local args = {}
      for i = 1, nargs_call do args[i] = R[A + i] end
      return f(_unpack(args, 1, nargs_call))
    elseif op == OP_RETURN then
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
    elseif op == OP_FORLOOP then
      R[A] = R[A] + R[A + 2]
      local step = R[A + 2]
      if (step > 0 and R[A] <= R[A + 1]) or (step <= 0 and R[A] >= R[A + 1]) then
        pc = pc + B
        R[A + 3] = R[A]
      end
    elseif op == OP_FORPREP then
      R[A] = R[A] - R[A + 2]
      pc = pc + B
    elseif op == OP_TFORLOOP then
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
    elseif op == OP_SETLIST then
      local t = R[A]
      local n = (B == 0) and (top - A - 1) or B
      local offset = (C - 1) * 50
      for i = 1, n do t[offset + i] = R[A + i] end
    elseif op == OP_CLOSE then
      -- no-op under our box model
    elseif op == OP_CLOSURE then
      local sub_proto = prs[B + 1]
      local _uvs = {}
      for i = 1, #sub_proto.upvs do
        local ui = ins[pc]
        local uB = (_mfloor(ui / SHIFT_B) % SHIFT_B) - BIAS
        local uop = _mfloor(ui / SHIFT_OP)
        pc = pc + 1
        if uop == OP_MOVE then
          _uvs[i] = R[uB]
        elseif uop == OP_GETUPVAL then
          _uvs[i] = upvals[uB + 1]
        else
          _err("bad upvalue binding opcode " .. tostring(uop))
        end
      end
      R[A] = make_closure(sub_proto, _uvs)
    elseif op == OP_VARARG then
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
    elseif op == OP_NEWBOX then
      R[A] = { v = R[A] }
    elseif op == OP_GETBOX then
      R[A] = R[B].v
    elseif op == OP_SETBOX then
      R[B].v = R[A]
    else
      _err("bad opcode " .. tostring(op) .. " at pc " .. tostring(pc - 1))
    end
  end
end
`;

module.exports = { buildVM, emitProto, emitOpcodeConstants, luaValue, luaQuoteString, luaNumber, VM_BODY };
