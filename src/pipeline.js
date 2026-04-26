// Orchestrates the obfuscation pipeline (lite variant — L0-L2 only).
//
// This branch deliberately drops the L3 hardening (cipher, range-coded
// compress, chunker, fake VMs, size-floor padding). Maximum level is 2.

'use strict';

const { parse } = require('./parser');
const { compile } = require('./compiler');
const { buildVM } = require('./vm-template');
const { makeConfig } = require('./config');

const MAX_LEVEL = 2;

function obfuscate(source, options = {}) {
  let { level = MAX_LEVEL, seed = Date.now() & 0xffffffff } = options;
  if (level < 0) level = 0;
  if (level > MAX_LEVEL) level = MAX_LEVEL;
  const cfg = makeConfig(seed);
  const ast = parse(source);
  const proto = compile(ast, '=input');

  // Level 0/plain: emit the readable VM (no polymorphism).
  if (level === 0) {
    return { code: buildVM(proto, cfg.opMap), cfg };
  }

  // Level 1+: emit the polymorphic VM (cfg drives dispatch shape, handler
  // order, inert prologues).
  let luaSrc = buildVM(proto, cfg.opMap, cfg);

  // Level 1+: variable renaming + string encryption.
  // Strings must run BEFORE rename so rename doesn't mangle identifiers that
  // happen to live inside string literals.
  if (level >= 1) {
    const { renamePass } = require('./passes/rename');
    const { stringPass } = require('./passes/strings');
    luaSrc = stringPass(luaSrc, cfg);
    luaSrc = renamePass(luaSrc, cfg);
  }

  // Level 2: dead code + predicates + closures.
  if (level >= 2) {
    const { deadCodePass } = require('./passes/deadcode');
    const { predicatePass } = require('./passes/predicates');
    const { closurePass } = require('./passes/closures');
    luaSrc = deadCodePass(luaSrc, cfg);
    luaSrc = predicatePass(luaSrc, cfg);
    luaSrc = closurePass(luaSrc, cfg);
  }

  return { code: luaSrc, cfg };
}

module.exports = { obfuscate, MAX_LEVEL };
