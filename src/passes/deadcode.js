// Level 2 pass: inject dead-code branches (always-false predicates) between
// statements in the generated VM source. Also sprinkles calls to realistic
// Roblox API lookups so analysts see plausible behaviour.

'use strict';

// Realistic-looking noise expressions, pinned to `_G` accesses or simple math.
const NOISE_EXPRS = [
  '_G["game"]',
  '_G["workspace"]',
  '_G["script"]',
  '_G["Vector3"]',
  '_G["CFrame"]',
  'math.pi',
  'math.huge',
  '"__" .. tostring(os.time())',
  'string.byte("x")',
];

function pickPredicate(rand) {
  // Always-false predicates.
  const n = Math.floor(rand() * 3);
  if (n === 0) return '((function() return 1 end)()) ~= ((function() return 1 end)())';
  if (n === 1) return '((function() return "a" end)()) == ((function() return 1 end)())';
  return '((function() return false end)())';
}

function deadBlock(rand) {
  const body = [];
  const count = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < count; i++) {
    const expr = NOISE_EXPRS[Math.floor(rand() * NOISE_EXPRS.length)];
    body.push('    local _ = ' + expr);
  }
  return 'if ' + pickPredicate(rand) + ' then\n' + body.join('\n') + '\n  end';
}

function deadCodePass(src, cfg) {
  // Inject between top-level statements (identified by newlines at column 0 ending on `;`/end/return/do/etc.)
  // Simple heuristic: inject after every ~400 characters at a safe boundary.
  const blocks = src.split('\n');
  const result = [];
  let charCount = 0;
  const interval = 800 + Math.floor(cfg.rand() * 400);
  for (let i = 0; i < blocks.length; i++) {
    const line = blocks[i];
    result.push(line);
    charCount += line.length + 1;
    if (charCount > interval && /^(end|[%w_]+%s*=)/.test(line) === false) {
      // Skip injecting mid-expression; only after lines that end with `end` or are blank.
      const trimmed = line.trim();
      if (trimmed === 'end' || trimmed === '' || trimmed.endsWith(',')) {
        // Only inject at chunk level (outside functions) — too risky mid-function.
        // For safety, inject as a top-level no-op only when we see a blank line.
        if (trimmed === '') {
          result.push(deadBlock(cfg.rand));
          charCount = 0;
        }
      }
    }
  }
  return result.join('\n');
}

module.exports = { deadCodePass };
