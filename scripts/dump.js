#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { parse } = require('../src/parser');
const { compile } = require('../src/compiler');

const src = fs.readFileSync(process.argv[2], 'utf8');
const proto = compile(parse(src));

function dump(p, depth) {
  const pad = '  '.repeat(depth);
  console.log(`${pad}Proto: params=${p.numParams} vararg=${p.isVararg} maxstack=${p.maxStack}`);
  console.log(`${pad}Consts: ${JSON.stringify(p.consts)}`);
  if (p.upvalues.length) {
    console.log(`${pad}Upvs: ` + p.upvalues.map((u, i) => `${i}:${u.fromLocal ? 'L' : 'U'}${u.index}`).join(' '));
  }
  for (let i = 0; i < p.insns.length; i++) {
    const ins = p.insns[i];
    console.log(`${pad}  ${i}: ${ins.op} a=${ins.a} b=${ins.b} c=${ins.c}`);
  }
  for (let i = 0; i < p.protos.length; i++) {
    console.log(`${pad}-- proto ${i} --`);
    dump(p.protos[i], depth + 1);
  }
}
dump(proto, 0);
