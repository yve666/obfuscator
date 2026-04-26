#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { program } = require('commander');
const chalk = require('chalk');
const { obfuscate } = require('./pipeline');

function readFile(p) { return fs.readFileSync(p, 'utf8'); }

function runLua(sourcePath, withRobloxStub) {
  try {
    let target = sourcePath;
    if (withRobloxStub) {
      target = sourcePath + '.stub';
      fs.writeFileSync(target, 'game = {}\n' + fs.readFileSync(sourcePath, 'utf8'));
    }
    const out = execFileSync('lua5.1', [target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (withRobloxStub) fs.unlinkSync(target);
    return out;
  } catch (err) {
    return { error: err.stderr || err.message };
  }
}

program
  .name('larpfuscator')
  .description('Roblox Lua obfuscator')
  .version('0.1.0');

program
  .command('obfuscate')
  .argument('<input>', 'input Lua file')
  .requiredOption('-o, --output <file>', 'output Lua file')
  .option('-l, --level <n>', 'obfuscation level (0|1|2|3)', '3')
  .option('-s, --seed <n>', 'PRNG seed (deterministic)')
  .option('--verify', 'run output through lua5.1 and diff vs original')
  .action((input, opts) => {
    const src = readFile(input);
    let level = parseInt(opts.level, 10);
    if (!Number.isFinite(level) || level < 0 || level > 2) {
      console.error(chalk.red(`invalid --level ${opts.level}: must be 0, 1, or 2`));
      process.exit(2);
    }
    const seed = opts.seed ? parseInt(opts.seed, 10) : (Date.now() & 0xffffffff);
    const { code } = obfuscate(src, { level, seed });
    fs.writeFileSync(opts.output, code, 'utf8');
    console.log(chalk.green(`wrote ${opts.output} (${code.length} bytes) level=${level} seed=${seed}`));
    if (opts.verify) runVerify(input, opts.output, level);
  });

program
  .command('gui')
  .description('start the local web GUI')
  .option('-p, --port <n>', 'port to listen on', '7331')
  .option('-H, --host <host>', 'host to bind (default 127.0.0.1)', '127.0.0.1')
  .option('--no-open', 'do not open the browser automatically')
  .action(async (opts) => {
    const { start } = require('./gui/server');
    const port = parseInt(opts.port, 10);
    let info;
    try {
      info = await start({ port, host: opts.host });
    } catch (e) {
      console.error(chalk.red('failed to start gui: ' + e.message));
      process.exit(1);
    }
    const url = `http://${info.host === '0.0.0.0' ? 'localhost' : info.host}:${info.port}`;
    console.log(chalk.green(`larpfuscator gui listening at ${url}`));
    console.log(chalk.gray('press ctrl+c to stop'));
    if (opts.open !== false) {
      tryOpenBrowser(url);
    }
  });

program
  .command('verify')
  .argument('<input>', 'original Lua file')
  .argument('<output>', 'obfuscated Lua file')
  .action((input, output) => {
    runVerify(input, output);
  });

function runVerify(input, output, level) {
  const orig = runLua(input, false);
  const obf = runLua(output, false);
  const origOut = typeof orig === 'string' ? orig : '';
  const obfOut = typeof obf === 'string' ? obf : '';
  if (typeof orig !== 'string') console.error(chalk.red('original failed: ' + orig.error));
  if (typeof obf !== 'string') console.error(chalk.red('obfuscated failed: ' + obf.error));
  if (origOut === obfOut && typeof orig === 'string' && typeof obf === 'string') {
    console.log(chalk.green('verify: stdout matches (' + origOut.length + ' bytes)'));
    process.exit(0);
  } else {
    console.error(chalk.red('verify: MISMATCH'));
    console.error('--- original ---');
    console.error(origOut);
    console.error('--- obfuscated ---');
    console.error(obfOut);
    process.exit(1);
  }
}

function tryOpenBrowser(url) {
  // best-effort browser open; never fail if no GUI is available.
  const { spawn } = require('child_process');
  let cmd, args;
  if (process.platform === 'darwin') {
    cmd = 'open'; args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open'; args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch (_) { /* ignore */ }
}

program.parse(process.argv);
