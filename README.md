# larpfuscator (lite)

A Roblox Lua obfuscator CLI. Compiles Lua 5.1 source into a custom
register-based bytecode, bundles it with a generated VM, and applies optional
variable renaming, string encryption, dead code injection, opaque predicates,
and closure wrapping.

> This is the **lite** branch. It deliberately tops out at level 2 and drops
> the L3 pipeline (bytecode cipher, range-coded compression, fake VMs, chunked
> loader, anti-tamper, size-floor padding). For the full pipeline see `trunk`.

## Install

```
npm install
```

Requires `lua5.1` on `PATH` for `--verify` and the test harness.

## Usage

```
larpfuscator obfuscate <input.lua> -o <output.lua> --level <0|1|2> [--seed <n>] [--verify]
larpfuscator verify <input.lua> <output.lua>
larpfuscator gui [--port 7331] [--host 127.0.0.1] [--no-open]
```

### Levels

| Level | Contents |
|-------|----------|
| 0 | Plain VM only (useful for debugging the compiler) |
| 1 | + variable renaming + string encryption |
| 2 | + dead code injection + opaque predicates + closure wrapping |

L0-L2 do not check the runtime environment, so output runs on plain `lua5.1`
without any Roblox stub.

### Pipeline (level 2)

```
Lua source
  → hand-rolled parser → AST
  → compiler → custom register-based bytecode (49-bit packed)
  → polymorphic VM template (cfg-driven dispatch shape, handler order)
  → string encryption pass (byte-array XOR decoders)
  → variable renaming pass (all locals → _0x####)
  → dead code + opaque predicates + closure wrap
  → output
```

### Seeds

`--seed <n>` makes output deterministic for a given input. Used for testing.

## Tests

```
npm test
```

Runs five fixtures (`hello`, `loops`, `functions`, `tables`, `varargs`) through
all three obfuscation levels and diffs stdout against a native `lua5.1`
execution of the original.

## Layout

```
src/
  cli.js           — commander CLI
  parser.js        — hand-rolled Lua 5.1 parser
  resolver.js      — scope / upvalue resolution
  compiler.js      — AST → custom bytecode
  opcodes.js       — 49-bit packed instruction format
  config.js        — per-build seeded PRNG
  vm-template.js   — generates the VM source
  dispatch.js      — polymorphic dispatch shape
  pipeline.js      — orchestrates passes
  passes/
    rename.js      — local variable renaming
    strings.js     — byte-array XOR string decoders
    deadcode.js    — always-false predicate injection
    predicates.js  — numeric literal → IIFE arithmetic chains
    closures.js    — nested closure wrappers
  gui/             — local web GUI served by `larpfuscator gui`
test/
  *.lua            — fixtures
  run.js           — test harness
```
