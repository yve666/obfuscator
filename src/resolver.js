// Scope resolution pass: annotates Identifier nodes with {kind: 'local'|'upvalue'|'global', ...}
// and annotates local declarations with per-name escape info (captured by an inner function).
//
// Walked inline on the AST produced by parser.js.

'use strict';

function newFuncScope(parent, isMainChunk) {
  return {
    parent,
    isMainChunk: !!isMainChunk,
    // Flat list of locals declared anywhere in this function (in declaration order).
    locals: [],
    // Stack of block scopes; each is { start, names } where names is array of slot ids (indices into locals).
    blocks: [],
    // Upvalues this function captures. Each: { name, fromLocal, fromUpval, srcIndex }.
    upvalues: [],
    upvalIndex: new Map(),
    vararg: false,
  };
}

function newLocal(func, name) {
  const l = { name, escapes: false, slot: -1, func };
  func.locals.push(l);
  return l;
}

function beginBlock(func) { func.blocks.push({ locals: [] }); }

function endBlock(func) { func.blocks.pop(); }

function declareLocal(func, name) {
  const l = newLocal(func, name);
  func.blocks[func.blocks.length - 1].locals.push(l);
  return l;
}

function lookupLocal(func, name) {
  for (let i = func.blocks.length - 1; i >= 0; i--) {
    const blk = func.blocks[i];
    for (let j = blk.locals.length - 1; j >= 0; j--) {
      if (blk.locals[j].name === name) return blk.locals[j];
    }
  }
  return null;
}

// Find or create an upvalue in `func` for variable `name` that resolves in some ancestor.
function findOrCreateUpvalue(func, name) {
  if (func.upvalIndex.has(name)) return func.upvalIndex.get(name);
  if (!func.parent) return null;
  const parent = func.parent;
  const local = lookupLocal(parent, name);
  if (local) {
    local.escapes = true;
    const uv = { name, fromLocal: true, srcIndex: -1, srcLocal: local };
    const idx = func.upvalues.length;
    func.upvalues.push(uv);
    func.upvalIndex.set(name, idx);
    return idx;
  }
  const parentUv = findOrCreateUpvalue(parent, name);
  if (parentUv === null) return null;
  const uv = { name, fromLocal: false, srcIndex: parentUv };
  const idx = func.upvalues.length;
  func.upvalues.push(uv);
  func.upvalIndex.set(name, idx);
  return idx;
}

function resolve(ast) {
  const mainFunc = newFuncScope(null, true);
  mainFunc.vararg = true;
  beginBlock(mainFunc);
  walkBlock(ast.body, mainFunc);
  endBlock(mainFunc);
  ast._func = mainFunc;
  return mainFunc;
}

function walkBlock(stmts, func) {
  for (const s of stmts) walkStmt(s, func);
}

function walkStmt(s, func) {
  switch (s.type) {
    case 'LocalStatement': {
      for (const e of s.exprs) walkExpr(e, func);
      s._locals = [];
      for (const n of s.names) s._locals.push(declareLocal(func, n));
      return;
    }
    case 'LocalFunction': {
      // Lua semantics: local is in scope inside the function body.
      const loc = declareLocal(func, s.name);
      s._local = loc;
      walkFunc(s.func, func);
      return;
    }
    case 'FunctionDeclaration': {
      walkExpr(s.target, func);
      walkFunc(s.func, func);
      return;
    }
    case 'AssignStatement': {
      for (const t of s.targets) walkExpr(t, func);
      for (const v of s.values) walkExpr(v, func);
      return;
    }
    case 'ExpressionStatement': walkExpr(s.expr, func); return;
    case 'ReturnStatement': for (const e of s.args) walkExpr(e, func); return;
    case 'BreakStatement': return;
    case 'IfStatement': {
      for (const c of s.clauses) {
        walkExpr(c.cond, func);
        beginBlock(func); walkBlock(c.body, func); endBlock(func);
      }
      if (s.elseBody) { beginBlock(func); walkBlock(s.elseBody, func); endBlock(func); }
      return;
    }
    case 'WhileStatement': {
      walkExpr(s.cond, func);
      beginBlock(func); walkBlock(s.body, func); endBlock(func);
      return;
    }
    case 'RepeatStatement': {
      beginBlock(func);
      walkBlock(s.body, func);
      // cond is within the block
      walkExpr(s.cond, func);
      endBlock(func);
      return;
    }
    case 'DoStatement': {
      beginBlock(func); walkBlock(s.body, func); endBlock(func); return;
    }
    case 'NumericFor': {
      walkExpr(s.start, func); walkExpr(s.limit, func);
      if (s.step) walkExpr(s.step, func);
      beginBlock(func);
      s._local = declareLocal(func, s.name);
      walkBlock(s.body, func);
      endBlock(func);
      return;
    }
    case 'GenericFor': {
      for (const e of s.exprs) walkExpr(e, func);
      beginBlock(func);
      s._locals = [];
      for (const n of s.names) s._locals.push(declareLocal(func, n));
      walkBlock(s.body, func);
      endBlock(func);
      return;
    }
    default: throw new Error(`resolver: unknown stmt ${s.type}`);
  }
}

function walkFunc(fn, parentFunc) {
  const sub = newFuncScope(parentFunc, false);
  sub.vararg = fn.vararg;
  beginBlock(sub);
  fn._params = [];
  for (const p of fn.params) fn._params.push(declareLocal(sub, p));
  walkBlock(fn.body, sub);
  endBlock(sub);
  fn._func = sub;
}

function walkExpr(e, func) {
  if (!e) return;
  switch (e.type) {
    case 'Identifier': {
      const loc = lookupLocal(func, e.name);
      if (loc) { e._res = { kind: 'local', local: loc }; return; }
      const upvIdx = findOrCreateUpvalue(func, e.name);
      if (upvIdx !== null) { e._res = { kind: 'upvalue', index: upvIdx }; return; }
      e._res = { kind: 'global' };
      return;
    }
    case 'Index': walkExpr(e.object, func); walkExpr(e.index, func); return;
    case 'Call': walkExpr(e.func, func); for (const a of e.args) walkExpr(a, func); return;
    case 'MethodCall': walkExpr(e.object, func); for (const a of e.args) walkExpr(a, func); return;
    case 'Binary': walkExpr(e.left, func); walkExpr(e.right, func); return;
    case 'Unary': walkExpr(e.arg, func); return;
    case 'Paren': walkExpr(e.expr, func); return;
    case 'Table':
      for (const f of e.fields) {
        if (f.kind === 'kv') { walkExpr(f.key, func); walkExpr(f.value, func); }
        else walkExpr(f.value, func);
      }
      return;
    case 'FunctionExpression': walkFunc(e, func); return;
    case 'Vararg':
    case 'NilLiteral':
    case 'BoolLiteral':
    case 'NumberLiteral':
    case 'StringLiteral':
      return;
    default: throw new Error(`resolver: unknown expr ${e.type}`);
  }
}

module.exports = { resolve };
