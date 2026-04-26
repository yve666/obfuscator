// Level 2 pass: wrap the whole VM source in three nested closure layers with
// fake environment decoy tables.
//
// Originally this pass used `setmetatable({decoys}, {__index=_G, __newindex=_G})`
// + `setfenv(...)` per spec. That's hostile to Luau/Roblox executors for two
// reasons:
//   - `setfenv` / `getfenv` were removed in Luau.
//   - Some executor sandboxes (e.g. Seliware) either don't expose
//     `setmetatable` in the script env at the point the outermost chunk runs,
//     or freeze `_G` against `__newindex` writes — resulting in an
//     "attempt to call a nil value" on the `setmetatable` line.
// So the wrapper is now Luau-safe: no `setmetatable`, no `setfenv`, no `_G`
// writes. Each layer still emits plausible-looking decoy locals / fake env
// reads so an analyst can't immediately dismiss the wrapper, but the logic
// is pure Lua 5.1 / Luau portable code.

'use strict';

function closurePass(src, cfg) {
  const layers = 3;
  let wrapped = src;
  for (let i = 0; i < layers; i++) {
    const decoyCount = 4 + Math.floor(cfg.rand() * 3);
    const decoys = [];
    const decoyKeys = [];
    for (let j = 0; j < decoyCount; j++) {
      const key = '_d' + Math.floor(cfg.rand() * 0xffff).toString(16);
      const val = Math.floor(cfg.rand() * 0xffff);
      decoys.push(`${key}=${val}`);
      decoyKeys.push(key);
    }
    // Pick one decoy key to "read" to give the wrapper a plausible side effect.
    const readKey = decoyKeys[Math.floor(cfg.rand() * decoyKeys.length)];
    const sinkName = '_s' + Math.floor(cfg.rand() * 0xffff).toString(16);
    wrapped = `return (function(...)
  local _env = {${decoys.join(',')}}
  local ${sinkName} = _env.${readKey}
  local _fn = function(...)
${wrapped}
  end
  return _fn(...)
end)(...)`;
  }
  return wrapped;
}

module.exports = { closurePass };
