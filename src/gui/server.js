// Local web GUI server for larpfuscator. No external dependencies — uses
// only Node's built-in `http`, `fs`, and `path`. Bind to 127.0.0.1 by
// default so the obfuscator endpoint is only reachable from the local
// machine.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { obfuscate } = require('../pipeline');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Cap input source size to keep this honest as a "local tool" — no need
// to invite someone hosting it on the internet to OOM their box. 4 MB
// is plenty for any realistic Lua script.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large (max 4 MB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeJoin(base, target) {
  // Resolve and verify the result stays inside `base`. Defensive against
  // path-traversal even though the routes only ever pass `req.url`.
  const resolved = path.resolve(base, '.' + target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const fp = safeJoin(PUBLIC_DIR, urlPath);
  if (!fp) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

async function handleObfuscate(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON: ' + e.message }));
    return;
  }
  const source = typeof payload.source === 'string' ? payload.source : '';
  const level = clampInt(payload.level, 0, 2, 2);
  const seed = (payload.seed === undefined || payload.seed === null || payload.seed === '')
    ? (Date.now() & 0xffffffff)
    : clampInt(payload.seed, 0, 0xffffffff, 1337);
  if (!source.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'source is empty' }));
    return;
  }
  const t0 = Date.now();
  let result;
  try {
    result = obfuscate(source, { level, seed });
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'obfuscation failed: ' + (e.stack || e.message) }));
    return;
  }
  const elapsed = Date.now() - t0;
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({
    code: result.code,
    inputBytes: Buffer.byteLength(source, 'utf8'),
    outputBytes: Buffer.byteLength(result.code, 'utf8'),
    level,
    seed,
    elapsedMs: elapsed,
  }));
}

function clampInt(v, lo, hi, def) {
  let n = (typeof v === 'number') ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  n = Math.floor(n);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function createServer() {
  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/obfuscate') {
      handleObfuscate(req, res).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal: ' + e.message }));
      });
      return;
    }
    if (url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: require('../../package.json').version }));
      return;
    }
    serveStatic(req, res);
  });
}

function start({ port = 7331, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: addr.port, host: addr.address });
    });
  });
}

module.exports = { start, createServer };
