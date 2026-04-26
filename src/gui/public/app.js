// Frontend for the larpfuscator local GUI. No frameworks, no build step.
'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  src: $('src'),
  out: $('out'),
  go: $('btn-go'),
  copy: $('btn-copy'),
  download: $('btn-download'),
  load: $('btn-load'),
  sample: $('btn-sample'),
  clearIn: $('btn-clear-in'),
  file: $('file'),
  seed: $('seed'),
  seedRand: $('btn-seed-rand'),
  levelSeg: $('level-seg'),
  levelHint: $('level-hint'),
  status: $('status'),
  srcStats: $('src-stats'),
  outStats: $('out-stats'),
  ver: $('ver'),
  paneInput: document.querySelector('.pane-input'),
};

const SAMPLE = `print("Hello, World!")

local function fib(n)
  if n < 2 then return n end
  return fib(n - 1) + fib(n - 2)
end

for i = 1, 10 do
  print(i, fib(i))
end
`;

const LEVEL_HINTS = {
  0: 'L0: readable VM, no transforms.',
  1: 'L1: + rename + string encryption.',
  2: 'L2: + dead code + opaque predicates + closure layers.',
};

let level = 2;
let lastResult = null;

// ---------- helpers ----------

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function setStatus(msg, kind) {
  els.status.textContent = msg || '';
  els.status.classList.remove('ok', 'err', 'warn');
  if (kind) els.status.classList.add(kind);
}

function updateSrcStats() {
  const n = new Blob([els.src.value]).size;
  els.srcStats.textContent = fmtBytes(n);
}

function setLevel(v) {
  level = v;
  for (const b of els.levelSeg.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', parseInt(b.dataset.v, 10) === v);
  }
  els.levelHint.textContent = LEVEL_HINTS[v] || '';
}

function randSeed() {
  return Math.floor(Math.random() * 0xffffffff);
}

// ---------- actions ----------

async function obfuscate() {
  const source = els.src.value;
  if (!source.trim()) {
    setStatus('input is empty', 'err');
    return;
  }
  let seed = els.seed.value.trim();
  if (seed === '') {
    seed = randSeed();
    els.seed.value = String(seed);
  } else {
    const n = parseInt(seed, 10);
    if (!Number.isFinite(n) || n < 0) {
      setStatus('seed must be a non-negative integer', 'err');
      return;
    }
    seed = n;
  }

  els.go.disabled = true;
  els.go.classList.add('busy');
  els.go.textContent = 'obfuscating…';
  setStatus('running…');

  const t0 = performance.now();
  let resp, body;
  try {
    resp = await fetch('/api/obfuscate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, level, seed }),
    });
    body = await resp.json();
  } catch (e) {
    setStatus('network error: ' + e.message, 'err');
    resetGoBtn();
    return;
  }
  if (!resp.ok) {
    setStatus(body.error || ('http ' + resp.status), 'err');
    resetGoBtn();
    return;
  }
  const elapsed = performance.now() - t0;
  lastResult = body;
  els.out.value = body.code;
  els.outStats.textContent = `${fmtBytes(body.outputBytes)}  ·  L${body.level}  ·  seed=${body.seed}  ·  ${body.elapsedMs} ms`;
  els.copy.disabled = false;
  els.download.disabled = false;
  const ratio = body.inputBytes > 0 ? (body.outputBytes / body.inputBytes).toFixed(1) : '∞';
  setStatus(`done in ${Math.round(elapsed)} ms  ·  ${fmtBytes(body.inputBytes)} → ${fmtBytes(body.outputBytes)}  (${ratio}×)`, 'ok');
  resetGoBtn();
}

function resetGoBtn() {
  els.go.disabled = false;
  els.go.classList.remove('busy');
  els.go.textContent = 'obfuscate';
}

async function copyOutput() {
  if (!els.out.value) return;
  try {
    await navigator.clipboard.writeText(els.out.value);
    setStatus('copied to clipboard', 'ok');
  } catch (e) {
    // fallback for non-https / older browsers
    els.out.select();
    document.execCommand('copy');
    els.out.setSelectionRange(0, 0);
    setStatus('copied to clipboard (legacy)', 'ok');
  }
}

function downloadOutput() {
  if (!els.out.value) return;
  const seed = (lastResult && lastResult.seed) || 'out';
  const lvl = (lastResult && lastResult.level) !== undefined ? lastResult.level : level;
  const fname = `larpfuscated-L${lvl}-${seed}.lua`;
  const blob = new Blob([els.out.value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    els.src.value = String(reader.result || '');
    updateSrcStats();
    setStatus('loaded ' + file.name, 'ok');
  };
  reader.onerror = () => setStatus('failed to read file', 'err');
  reader.readAsText(file);
}

// ---------- wire-up ----------

els.go.addEventListener('click', obfuscate);
els.copy.addEventListener('click', copyOutput);
els.download.addEventListener('click', downloadOutput);

els.load.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  const f = els.file.files && els.file.files[0];
  if (f) loadFile(f);
  els.file.value = '';
});

els.sample.addEventListener('click', () => {
  els.src.value = SAMPLE;
  updateSrcStats();
});
els.clearIn.addEventListener('click', () => {
  els.src.value = '';
  updateSrcStats();
});

els.src.addEventListener('input', updateSrcStats);

els.levelSeg.addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  setLevel(parseInt(b.dataset.v, 10));
});

els.seedRand.addEventListener('click', () => {
  els.seed.value = String(randSeed());
});

// drag and drop onto the input pane
['dragenter', 'dragover'].forEach((evt) => {
  els.paneInput.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.paneInput.classList.add('dropping');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  els.paneInput.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.paneInput.classList.remove('dropping');
  });
});
els.paneInput.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

// Ctrl/Cmd+Enter triggers obfuscate from anywhere in the page
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    obfuscate();
  }
});

// version probe
fetch('/api/health').then((r) => r.json()).then((j) => {
  if (j && j.version) els.ver.textContent = 'v' + j.version;
}).catch(() => {});

setLevel(3);
updateSrcStats();
