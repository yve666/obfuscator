// Level 1 pass: replace every double-quoted string literal with a runtime call
// to a byte-array decoder. Each byte is XORed with two per-build keys before
// being joined back into a string. The decoder function is injected at the top
// of the VM source.

'use strict';

function findStringLiterals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // skip long comments and line comments
    if (c === '-' && src[i + 1] === '-') {
      // long-comment?
      if (src[i + 2] === '[' && src[i + 3] === '[') {
        i += 4;
        while (i < n && !(src[i] === ']' && src[i + 1] === ']')) i++;
        i += 2;
        continue;
      }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let value = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') {
          const esc = src[i + 1];
          if (esc === 'n') { value += '\n'; i += 2; }
          else if (esc === 'r') { value += '\r'; i += 2; }
          else if (esc === 't') { value += '\t'; i += 2; }
          else if (esc === '"') { value += '"'; i += 2; }
          else if (esc === '\\') { value += '\\'; i += 2; }
          else if (/\d/.test(esc)) {
            let num = esc;
            i += 2;
            for (let k = 0; k < 2 && /\d/.test(src[i]); k++) { num += src[i]; i++; }
            value += String.fromCharCode(parseInt(num, 10));
          } else {
            value += esc;
            i += 2;
          }
        } else {
          if (src[i] === '\n') break; // unterminated, bail
          value += src[i];
          i++;
        }
      }
      if (src[i] === '"') {
        i++;
        out.push({ start, end: i, value });
      }
      continue;
    }
    i++;
  }
  return out;
}

function stringPass(src, cfg) {
  const keyA = cfg.strKeyA;
  const keyB = cfg.strKeyB;
  const decoderName = '_sdec_' + Math.floor(cfg.rand() * 0xffff).toString(16);
  const literals = findStringLiterals(src);
  // Replace from end so offsets remain stable.
  let result = src;
  for (let j = literals.length - 1; j >= 0; j--) {
    const { start, end, value } = literals[j];
    const bytes = [];
    for (let k = 0; k < value.length; k++) {
      const c = value.charCodeAt(k);
      const enc = xor8(xor8(c, keyA), keyB);
      bytes.push(enc);
    }
    const rep = `${decoderName}({${bytes.join(',')}})`;
    result = result.slice(0, start) + rep + result.slice(end);
  }
  // Prepend decoder.
  const decoder = `
local function ${decoderName}(b)
  local _k = ${keyA ^ keyB}
  local _xor = function(a, bb)
    local r, p = 0, 1
    for _ = 1, 8 do
      local ab, cb = a % 2, bb % 2
      if ab ~= cb then r = r + p end
      a = (a - ab) / 2
      bb = (bb - cb) / 2
      p = p * 2
    end
    return r
  end
  local t = {}
  for i = 1, #b do t[i] = string.char(_xor(b[i], _k)) end
  return table.concat(t)
end
`;
  return decoder + '\n' + result;
}

function xor8(a, b) {
  return a ^ b;
}

module.exports = { stringPass };
