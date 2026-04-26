#!/usr/bin/env node
// End-to-end test runner. For each .lua fixture and each level in [0,1,2],
// obfuscates and then compares lua5.1 stdout against the original.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { obfuscate } = require('../src/pipeline');

const FIXTURES = ['hello', 'loops', 'functions', 'tables', 'varargs'];
const LEVELS = [0, 1, 2];
const SEED = 0xdeadbeef;

// L0-L2 don't reference `game`; the stub plumbing is kept for symmetry but
// unused at these levels.
const ROBLOX_STUB = 'game = {}\n';

function runLua(file) {
  try {
    return execFileSync('lua5.1', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return '<ERROR>\n' + (err.stderr || err.message);
  }
}

function runLuaWithStub(file) {
  // Prepend `game = {}` to the file before exec.
  const orig = fs.readFileSync(file, 'utf8');
  const tmp = file + '.stub';
  fs.writeFileSync(tmp, ROBLOX_STUB + orig);
  const r = runLua(tmp);
  fs.unlinkSync(tmp);
  return r;
}

let failures = 0;
for (const name of FIXTURES) {
  const fixture = path.join(__dirname, `${name}.lua`);
  const expected = runLua(fixture);
  for (const level of LEVELS) {
    const src = fs.readFileSync(fixture, 'utf8');
    const out = path.join('/tmp', `ls_${name}_L${level}.lua`);
    let code;
    try {
      const r = obfuscate(src, { level, seed: SEED + level });
      code = r.code;
    } catch (err) {
      console.error(`[${name} L${level}] obfuscate failed:`, err.message);
      failures++;
      continue;
    }
    fs.writeFileSync(out, code);
    const got = (level >= 3) ? runLuaWithStub(out) : runLua(out);
    if (got === expected) {
      console.log(`ok   ${name} L${level} (${code.length}B)`);
    } else {
      console.error(`FAIL ${name} L${level}`);
      console.error('  expected:');
      console.error('    ' + expected.split('\n').join('\n    '));
      console.error('  got:');
      console.error('    ' + got.split('\n').join('\n    '));
      failures++;
    }
  }
}

if (failures) { console.error(`${failures} failures`); process.exit(1); }
console.log('all tests passed');
