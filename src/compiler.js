// Lua AST -> custom bytecode compiler (register-based, Lua 5.1-ish semantics).

'use strict';

const { resolve } = require('./resolver');
const { RK_K_OFFSET } = require('./opcodes');

class Proto {
  constructor(parent) {
    this.parent = parent || null;
    this.insns = []; // {op, a, b, c} (unmapped opcode names; packed/mapped later).
    this.consts = []; // Array of constants.
    this.constIndex = new Map(); // key string -> index.
    this.protos = []; // nested Proto.
    this.numParams = 0;
    this.isVararg = false;
    this.maxStack = 0;
    this.frameTop = 0;
    // Upvalue descriptors: each {fromLocal:bool, index:int}.
    this.upvalues = [];
    // Source name for debug.
    this.sourceName = null;
  }

  emit(op, a = 0, b = 0, c = 0) {
    this.insns.push({ op, a, b, c });
    return this.insns.length - 1;
  }

  setInsn(idx, fields) {
    Object.assign(this.insns[idx], fields);
  }

  reserveReg(n = 1) {
    const r = this.frameTop;
    this.frameTop += n;
    if (this.frameTop > this.maxStack) this.maxStack = this.frameTop;
    return r;
  }

  freeReg(n = 1) { this.frameTop -= n; }

  constKey(v) {
    if (v === null || v === undefined) return 'n:nil';
    if (typeof v === 'boolean') return 'b:' + v;
    if (typeof v === 'number') return 'd:' + v;
    if (typeof v === 'string') return 's:' + v;
    throw new Error('bad const ' + typeof v);
  }

  addConst(v) {
    const k = this.constKey(v);
    if (this.constIndex.has(k)) return this.constIndex.get(k);
    const idx = this.consts.length;
    this.consts.push(v);
    this.constIndex.set(k, idx);
    return idx;
  }
}

class Compiler {
  constructor() { this.mainProto = null; }

  compile(ast, sourceName) {
    resolve(ast);
    const p = new Proto(null);
    p.sourceName = sourceName || 'chunk';
    p.isVararg = true;
    p.numParams = 0;
    this.compileFuncBody(p, ast._func, ast.body, null, []);
    // Emit final return if not already.
    const last = p.insns[p.insns.length - 1];
    if (!last || last.op !== 'RETURN') p.emit('RETURN', 0, 1, 0);
    this.mainProto = p;
    return p;
  }

  // `func` is the resolver's scope object. Its locals array has already been populated (declaration order).
  // But their slots are -1; we assign slots as we visit declarations here.
  compileFuncBody(proto, func, body, fnExpr, paramLocals) {
    // Parameter locals occupy slots 0..numParams-1.
    for (let i = 0; i < paramLocals.length; i++) {
      paramLocals[i].slot = i;
      proto.frameTop++;
      if (paramLocals[i].escapes) {
        proto.emit('NEWBOX', i);
      }
    }
    if (paramLocals.length > proto.maxStack) proto.maxStack = paramLocals.length;

    this.compileBlock(proto, body);
    // closing RETURN appended by caller if needed
  }

  compileBlock(proto, stmts) {
    const savedFrame = proto.frameTop;
    const blockLocals = [];
    for (const s of stmts) {
      this.compileStmt(proto, s, blockLocals);
    }
    // Close locals declared in this block (important if any escape).
    let closeSlot = -1;
    for (const l of blockLocals) if (l.escapes) { closeSlot = closeSlot < 0 ? l.slot : Math.min(closeSlot, l.slot); }
    if (closeSlot >= 0) proto.emit('CLOSE', closeSlot);
    proto.frameTop = savedFrame;
  }

  compileStmt(proto, s, blockLocals) {
    switch (s.type) {
      case 'LocalStatement': return this.compileLocal(proto, s, blockLocals);
      case 'LocalFunction': return this.compileLocalFunction(proto, s, blockLocals);
      case 'FunctionDeclaration': return this.compileFunctionDecl(proto, s);
      case 'AssignStatement': return this.compileAssign(proto, s);
      case 'ExpressionStatement': return this.compileExprStmt(proto, s);
      case 'ReturnStatement': return this.compileReturn(proto, s);
      case 'BreakStatement': return this.compileBreak(proto, s);
      case 'IfStatement': return this.compileIf(proto, s);
      case 'WhileStatement': return this.compileWhile(proto, s);
      case 'RepeatStatement': return this.compileRepeat(proto, s);
      case 'DoStatement': return this.compileBlock(proto, s.body);
      case 'NumericFor': return this.compileNumericFor(proto, s);
      case 'GenericFor': return this.compileGenericFor(proto, s);
      default: throw new Error('compile: unknown stmt ' + s.type);
    }
  }

  compileLocal(proto, s, blockLocals) {
    const nvars = s.names.length;
    const nexps = s.exprs.length;
    // Emit expressions into fresh temps stacked at top, sized to nvars.
    const base = proto.frameTop;
    if (nexps === 0) {
      for (let i = 0; i < nvars; i++) {
        proto.reserveReg();
      }
      proto.emit('LOADNIL', base, base + nvars - 1);
    } else {
      // Evaluate exprs 1..nexps-1 to consecutive regs.
      for (let i = 0; i < nexps - 1; i++) {
        const r = proto.reserveReg();
        this.exprToReg(proto, s.exprs[i], r);
      }
      const last = s.exprs[nexps - 1];
      const want = nvars - (nexps - 1);
      this.exprIntoTopMulti(proto, last, want);
      const got = proto.frameTop - base;
      if (got < nvars) {
        // fill with nils
        const need = nvars - got;
        const start = proto.frameTop;
        for (let i = 0; i < need; i++) proto.reserveReg();
        proto.emit('LOADNIL', start, start + need - 1);
      } else if (got > nvars) {
        proto.freeReg(got - nvars);
      }
    }
    // Assign slots
    for (let i = 0; i < nvars; i++) {
      const loc = s._locals[i];
      loc.slot = base + i;
      blockLocals.push(loc);
      if (loc.escapes) {
        proto.emit('NEWBOX', loc.slot);
      }
    }
  }

  compileLocalFunction(proto, s, blockLocals) {
    const slot = proto.reserveReg();
    s._local.slot = slot;
    blockLocals.push(s._local);
    if (s._local.escapes) proto.emit('NEWBOX', slot);
    const sub = this.compileClosure(proto, s.func);
    const pIdx = proto.protos.push(sub) - 1;
    // Create closure into a temp, then store into local.
    const tmp = proto.reserveReg();
    proto.emit('CLOSURE', tmp, pIdx);
    this.emitCloseUpvalues(proto, s.func._func);
    this.storeToLocal(proto, s._local, tmp);
    proto.freeReg(1);
  }

  compileFunctionDecl(proto, s) {
    const sub = this.compileClosure(proto, s.func);
    const pIdx = proto.protos.push(sub) - 1;
    const tmp = proto.reserveReg();
    proto.emit('CLOSURE', tmp, pIdx);
    this.emitCloseUpvalues(proto, s.func._func);
    this.assignTarget(proto, s.target, tmp);
    proto.freeReg(1);
  }

  compileClosure(proto, fnExpr) {
    const sub = new Proto(proto);
    sub.numParams = fnExpr.params.length;
    sub.isVararg = !!fnExpr.vararg;
    // Populate upvalue descriptors in codegen order matching fnExpr._func.upvalues.
    for (const uv of fnExpr._func.upvalues) {
      if (uv.fromLocal) sub.upvalues.push({ fromLocal: true, index: -1, _srcLocal: uv.srcLocal });
      else sub.upvalues.push({ fromLocal: false, index: uv.srcIndex });
    }
    this.compileFuncBody(sub, fnExpr._func, fnExpr.body, fnExpr, fnExpr._params);
    const last = sub.insns[sub.insns.length - 1];
    if (!last || last.op !== 'RETURN') sub.emit('RETURN', 0, 1, 0);
    return sub;
  }

  // Emit pseudo-instructions right after CLOSURE to bind upvalues.
  // We use op='PSEUDO_MOVE' or op='PSEUDO_UPVAL' which the packer translates:
  // For binding, MOVE A B (A=0 means "this is closure-binding") uses parent local slot in B.
  // GETUPVAL A B binds parent's upvalue index B.
  emitCloseUpvalues(proto, subFunc) {
    for (const uv of subFunc.upvalues) {
      if (uv.fromLocal) {
        // parent's local slot
        const loc = uv.srcLocal;
        // resolver ensures this local is in `proto`'s function scope. We rely on slot assignments at codegen time.
        proto.emit('MOVE', 0, loc.slot, 0);
      } else {
        proto.emit('GETUPVAL', 0, uv.srcIndex, 0);
      }
    }
  }

  compileAssign(proto, s) {
    const n = s.targets.length;
    const m = s.values.length;
    // Evaluate values into a consecutive top-of-stack region.
    const base = proto.frameTop;
    if (m === 0) {
      throw new Error('empty assignment');
    }
    for (let i = 0; i < m - 1; i++) {
      const r = proto.reserveReg();
      this.exprToReg(proto, s.values[i], r);
    }
    const last = s.values[m - 1];
    const want = n - (m - 1);
    this.exprIntoTopMulti(proto, last, want);
    const got = proto.frameTop - base;
    if (got < n) {
      const need = n - got;
      const start = proto.frameTop;
      for (let i = 0; i < need; i++) proto.reserveReg();
      proto.emit('LOADNIL', start, start + need - 1);
    } else if (got > n) {
      proto.freeReg(got - n);
    }
    // Now assign from base+0 .. base+n-1 to each target (last-first so index computations are safe).
    for (let i = n - 1; i >= 0; i--) {
      this.assignTarget(proto, s.targets[i], base + i);
    }
    proto.freeReg(n);
  }

  assignTarget(proto, t, srcReg) {
    if (t.type === 'Identifier') {
      const res = t._res;
      if (res.kind === 'local') { this.storeToLocal(proto, res.local, srcReg); return; }
      if (res.kind === 'upvalue') { proto.emit('SETUPVAL', srcReg, res.index); return; }
      // global
      const k = proto.addConst(t.name);
      proto.emit('SETGLOBAL', srcReg, k);
      return;
    }
    if (t.type === 'Index') {
      const objReg = this.exprToAnyReg(proto, t.object);
      const { rk: idxRK } = this.exprToRK(proto, t.index);
      proto.emit('SETTABLE', objReg, idxRK, srcReg);
      this.freeRegIfTemp(proto, objReg);
      this.freeRKIfTemp(proto, t.index, idxRK);
      return;
    }
    throw new Error('bad assign target ' + t.type);
  }

  storeToLocal(proto, loc, srcReg) {
    if (loc.escapes) proto.emit('SETBOX', srcReg, loc.slot);
    else if (srcReg !== loc.slot) proto.emit('MOVE', loc.slot, srcReg);
  }

  compileExprStmt(proto, s) {
    // Only function calls at stmt level (enforced by parser). Discard return values.
    this._compileCallExpr(proto, s.expr, 0);
  }

  // nresults: number of values expected (-1 for "all", 0 for "no returns kept"==1 in CALL-speak).
  compileCall(proto, e, nresults) {
    const base = proto.frameTop;
    if (e.type === 'Call') {
      this.exprToReg(proto, e.func, base);
      proto.reserveReg(1);
      this.emitCallArgs(proto, e.args, base + 1);
      const nargs = proto.frameTop - (base + 1);
      const lastArg = e.args[e.args.length - 1];
      const isTailMulti = lastArg && (lastArg.type === 'Call' || lastArg.type === 'MethodCall' || lastArg.type === 'Vararg');
      const B = isTailMulti ? 0 : (nargs + 1); // B=0 means use top as param end
      proto.emit('CALL', base, B, nresults + 1);
    } else if (e.type === 'MethodCall') {
      this.exprToReg(proto, e.object, base);
      proto.reserveReg(1); // func slot
      proto.reserveReg(1); // self slot
      const kIdx = proto.addConst(e.method);
      proto.emit('SELF', base, base, RK_K_OFFSET + kIdx);
      this.emitCallArgs(proto, e.args, base + 2);
      const nargs = proto.frameTop - (base + 1); // includes self
      const lastArg = e.args[e.args.length - 1];
      const isTailMulti = lastArg && (lastArg.type === 'Call' || lastArg.type === 'MethodCall' || lastArg.type === 'Vararg');
      const B = isTailMulti ? 0 : (nargs + 1);
      proto.emit('CALL', base, B, nresults + 1);
    } else throw new Error('compileCall: not a call ' + e.type);
    // After CALL, frame top is base + nresults (known results) or base + whatever (unknown). For nresults == -1 we leave it undefined.
    if (nresults === -1) {
      proto.frameTop = base; // variable; caller manages.
    } else {
      proto.frameTop = base + nresults;
    }
    if (proto.frameTop > proto.maxStack) proto.maxStack = proto.frameTop;
    return base;
  }

  emitCallArgs(proto, args, base) {
    if (args.length === 0) return;
    proto.frameTop = base;
    for (let i = 0; i < args.length - 1; i++) {
      const r = proto.reserveReg();
      this.exprToReg(proto, args[i], r);
    }
    const last = args[args.length - 1];
    if (last.type === 'Call' || last.type === 'MethodCall') {
      this.compileCall(proto, last, -1); // multi returns
    } else if (last.type === 'Vararg') {
      const r = base + args.length - 1;
      proto.frameTop = r;
      proto.emit('VARARG', r, 0); // all
    } else {
      const r = proto.reserveReg();
      this.exprToReg(proto, last, r);
    }
  }

  compileReturn(proto, s) {
    const base = proto.frameTop;
    if (s.args.length === 0) { proto.emit('RETURN', 0, 1); return; }
    for (let i = 0; i < s.args.length - 1; i++) {
      const r = proto.reserveReg();
      this.exprToReg(proto, s.args[i], r);
    }
    const last = s.args[s.args.length - 1];
    let B;
    if (last.type === 'Call' || last.type === 'MethodCall') {
      this.compileCall(proto, last, -1);
      B = 0;
    } else if (last.type === 'Vararg') {
      const r = proto.reserveReg();
      proto.frameTop = r;
      proto.emit('VARARG', r, 0);
      B = 0;
    } else {
      const r = proto.reserveReg();
      this.exprToReg(proto, last, r);
      B = s.args.length + 1;
    }
    proto.emit('RETURN', base, B);
    proto.frameTop = base;
  }

  compileBreak(proto, s) {
    // Encode break as JMP with marker; loops patch all break jumps.
    const idx = proto.emit('JMP', 0, 0);
    if (!this._breakList) this._breakList = [];
    this._breakList[this._breakList.length - 1].push(idx);
  }

  withBreaks(proto, fn) {
    if (!this._breakList) this._breakList = [];
    this._breakList.push([]);
    fn();
    const breaks = this._breakList.pop();
    for (const b of breaks) {
      proto.setInsn(b, { b: proto.insns.length - b - 1 });
    }
  }

  compileIf(proto, s) {
    const endJumps = [];
    for (let i = 0; i < s.clauses.length; i++) {
      const c = s.clauses[i];
      const jmpAfter = this.emitCondJump(proto, c.cond, /* jumpIfFalse */ true);
      this.compileBlock(proto, c.body);
      if (i < s.clauses.length - 1 || s.elseBody) {
        const j = proto.emit('JMP', 0, 0);
        endJumps.push(j);
      }
      proto.setInsn(jmpAfter, { b: proto.insns.length - jmpAfter - 1 });
    }
    if (s.elseBody) this.compileBlock(proto, s.elseBody);
    for (const j of endJumps) proto.setInsn(j, { b: proto.insns.length - j - 1 });
  }

  compileWhile(proto, s) {
    this.withBreaks(proto, () => {
      const loopStart = proto.insns.length;
      const exitJmp = this.emitCondJump(proto, s.cond, true);
      this.compileBlock(proto, s.body);
      const back = proto.emit('JMP', 0, 0);
      proto.setInsn(back, { b: loopStart - back - 1 });
      proto.setInsn(exitJmp, { b: proto.insns.length - exitJmp - 1 });
    });
  }

  compileRepeat(proto, s) {
    this.withBreaks(proto, () => {
      const loopStart = proto.insns.length;
      // Note: body and cond share scope in Lua; we compile as a block with cond at end.
      const savedFrame = proto.frameTop;
      const blockLocals = [];
      for (const st of s.body) this.compileStmt(proto, st, blockLocals);
      const exitJmp = this.emitCondJump(proto, s.cond, false); // exit when cond is true
      const back = proto.emit('JMP', 0, 0);
      proto.setInsn(back, { b: loopStart - back - 1 });
      proto.setInsn(exitJmp, { b: proto.insns.length - exitJmp - 1 });
      // close escaping locals
      let closeSlot = -1;
      for (const l of blockLocals) if (l.escapes) closeSlot = closeSlot < 0 ? l.slot : Math.min(closeSlot, l.slot);
      if (closeSlot >= 0) proto.emit('CLOSE', closeSlot);
      proto.frameTop = savedFrame;
    });
  }

  compileNumericFor(proto, s) {
    this.withBreaks(proto, () => {
      const base = proto.frameTop;
      const rStart = proto.reserveReg();
      this.exprToReg(proto, s.start, rStart);
      const rLimit = proto.reserveReg();
      this.exprToReg(proto, s.limit, rLimit);
      const rStep = proto.reserveReg();
      if (s.step) this.exprToReg(proto, s.step, rStep);
      else proto.emit('LOADK', rStep, proto.addConst(1));
      const rVar = proto.reserveReg(); // loop variable
      const prep = proto.emit('FORPREP', base, 0);
      const bodyStart = proto.insns.length;
      s._local.slot = rVar;
      if (s._local.escapes) proto.emit('NEWBOX', rVar);
      this.compileBlock(proto, s.body);
      const loop = proto.emit('FORLOOP', base, 0);
      proto.setInsn(prep, { b: loop - prep - 1 });
      proto.setInsn(loop, { b: bodyStart - loop - 1 });
      proto.freeReg(4);
    });
  }

  compileGenericFor(proto, s) {
    this.withBreaks(proto, () => {
      const base = proto.frameTop;
      // 3 state regs + N loop vars
      const rFunc = proto.reserveReg();
      const rState = proto.reserveReg();
      const rCtrl = proto.reserveReg();
      // Evaluate s.exprs with multi-results, producing exactly 3 values at [rFunc..rFunc+2]
      // Strategy: emit exprs into consecutive regs starting at rFunc, using multiret on last.
      this.emitExpListExact(proto, s.exprs, rFunc, 3);
      // Now loop variables
      const firstLoop = proto.frameTop;
      for (let i = 0; i < s.names.length; i++) proto.reserveReg();
      // Assign slot to loop-control locals
      for (let i = 0; i < s._locals.length; i++) {
        s._locals[i].slot = firstLoop + i;
        if (s._locals[i].escapes) proto.emit('NEWBOX', s._locals[i].slot);
      }
      const jmpToTest = proto.emit('JMP', 0, 0);
      const bodyStart = proto.insns.length;
      this.compileBlock(proto, s.body);
      proto.setInsn(jmpToTest, { b: proto.insns.length - jmpToTest - 1 });
      // TFORLOOP A C: calls R[A](R[A+1], R[A+2]); places results in R[A+3..A+2+C]; if R[A+3] ~= nil then R[A+2] = R[A+3] else pc++
      proto.emit('TFORLOOP', base, 0, s.names.length);
      const back = proto.emit('JMP', 0, 0);
      proto.setInsn(back, { b: bodyStart - back - 1 });
      proto.freeReg(3 + s.names.length);
    });
  }

  emitExpListExact(proto, exprs, base, n) {
    proto.frameTop = base;
    for (let i = 0; i < exprs.length - 1; i++) {
      const r = proto.reserveReg();
      this.exprToReg(proto, exprs[i], r);
    }
    if (exprs.length === 0) {
      for (let i = 0; i < n; i++) proto.reserveReg();
      proto.emit('LOADNIL', base, base + n - 1);
      return;
    }
    const last = exprs[exprs.length - 1];
    const filled = exprs.length - 1;
    const want = n - filled;
    this.exprIntoTopMulti(proto, last, want);
    const got = proto.frameTop - base;
    if (got < n) {
      const need = n - got;
      const start = proto.frameTop;
      for (let i = 0; i < need; i++) proto.reserveReg();
      proto.emit('LOADNIL', start, start + need - 1);
    } else if (got > n) proto.freeReg(got - n);
  }

  exprIntoTopMulti(proto, e, nwant) {
    // Appends values to top of stack; for multi-return expressions respects nwant (-1 for all).
    if (e.type === 'Call' || e.type === 'MethodCall') {
      const start = proto.frameTop;
      const produced = nwant; // fixed nwant
      // compile as call that returns `nwant` values.
      this._compileCallExpr(proto, e, nwant);
      // _compileCallExpr sets frameTop to start+nwant.
      return;
    }
    if (e.type === 'Vararg') {
      const r = proto.reserveReg();
      proto.frameTop = r;
      if (nwant === -1) proto.emit('VARARG', r, 0);
      else proto.emit('VARARG', r, nwant + 1);
      proto.frameTop = r + nwant;
      if (proto.frameTop > proto.maxStack) proto.maxStack = proto.frameTop;
      return;
    }
    // scalar
    const r = proto.reserveReg();
    this.exprToReg(proto, e, r);
  }

  _compileCallExpr(proto, e, nresults) {
    const base = proto.frameTop;
    if (e.type === 'Call') {
      this.exprToReg(proto, e.func, base);
      proto.reserveReg(1);
      this.emitCallArgs(proto, e.args, base + 1);
      const nargs = proto.frameTop - (base + 1);
      const lastArg = e.args[e.args.length - 1];
      const isTailMulti = lastArg && (lastArg.type === 'Call' || lastArg.type === 'MethodCall' || lastArg.type === 'Vararg');
      const B = isTailMulti ? 0 : (nargs + 1);
      proto.emit('CALL', base, B, nresults + 1);
    } else if (e.type === 'MethodCall') {
      this.exprToReg(proto, e.object, base);
      proto.reserveReg(1);
      proto.reserveReg(1);
      const kIdx = proto.addConst(e.method);
      proto.emit('SELF', base, base, RK_K_OFFSET + kIdx);
      this.emitCallArgs(proto, e.args, base + 2);
      const nargs = proto.frameTop - (base + 1);
      const lastArg = e.args[e.args.length - 1];
      const isTailMulti = lastArg && (lastArg.type === 'Call' || lastArg.type === 'MethodCall' || lastArg.type === 'Vararg');
      const B = isTailMulti ? 0 : (nargs + 1);
      proto.emit('CALL', base, B, nresults + 1);
    }
    if (nresults === -1) proto.frameTop = base;
    else proto.frameTop = base + nresults;
    if (proto.frameTop > proto.maxStack) proto.maxStack = proto.frameTop;
  }

  // Evaluate conditional; emit a JMP that is taken when the test fails the branch direction
  // (jumpIfFalse==true: jump when cond is false). Returns the jump instruction index.
  emitCondJump(proto, e, jumpIfFalse) {
    // Basic form: TEST A C + JMP. C is 0 to jump if R[A] is false, 1 to jump if true (Lua 5.1: TEST A C = "if not (R[A] <=> C) then pc++").
    // Implementation detail: we support 'and', 'or', comparisons, 'not'. Fall back to generic TEST for others.
    if (e.type === 'Binary' && (e.op === '==' || e.op === '~=' || e.op === '<' || e.op === '<=' || e.op === '>' || e.op === '>=')) {
      return this.emitCompareJump(proto, e, jumpIfFalse);
    }
    if (e.type === 'Unary' && e.op === 'not') {
      return this.emitCondJump(proto, e.arg, !jumpIfFalse);
    }
    // Logical and/or are trickier. For now use materialization fallback.
    const r = this.exprToAnyReg(proto, e);
    // TEST A C: if (bool(R[A]) != C) pc++ then JMP follows -- we encode via two insns.
    const C = jumpIfFalse ? 1 : 0; // if jumpIfFalse, we want to jump when value is false; TEST c=1 skips next when bool is false, fallthrough when true. We want opposite: emit TEST c=0 to skip JMP when value is false... let me just define:
    // Semantics we implement: TEST A C => if (toBool(R[A]) == (C != 0)) then execute next (the JMP); else skip next.
    // jumpIfFalse=true means we want JMP taken when R[A] is false, i.e., TEST with C=0.
    // jumpIfFalse=false means JMP taken when R[A] is true, i.e., TEST with C=1.
    proto.emit('TEST', r, 0, jumpIfFalse ? 0 : 1);
    this.freeRegIfTemp(proto, r);
    return proto.emit('JMP', 0, 0);
  }

  emitCompareJump(proto, e, jumpIfFalse) {
    // Map ops to {op, swap, negate}
    let op, swap = false, negate = false;
    switch (e.op) {
      case '==': op = 'EQ'; break;
      case '~=': op = 'EQ'; negate = true; break;
      case '<':  op = 'LT'; break;
      case '<=': op = 'LE'; break;
      case '>':  op = 'LT'; swap = true; break;
      case '>=': op = 'LE'; swap = true; break;
    }
    const left = swap ? e.right : e.left;
    const right = swap ? e.left : e.right;
    const l = this.exprToRK(proto, left);
    const r = this.exprToRK(proto, right);
    // Our VM semantics (we control the VM): emit `op A B C` where:
    //   if ((RK(B) <op> RK(C)) == (A != 0)) then fallthrough else skip next.
    // So to "jump if the compare is true" (jumpIfFalse == false), set A = 0 (fallthrough on true is wrong).
    // Simpler: we always emit the compare with A chosen so that the following JMP is taken iff we want to branch.
    // "branch taken" <=> (RK(B) <op> RK(C)) == (A != 0).
    // We want branch-taken-iff jumpIfFalse==true means branch when compare is false; jumpIfFalse==false means branch when compare is true.
    // Combine with `negate` (for ~=): flip the "compare true" interpretation.
    let wantCmpTrue = !jumpIfFalse;
    if (negate) wantCmpTrue = !wantCmpTrue;
    const A = wantCmpTrue ? 1 : 0;
    proto.emit(op, A, l.rk, r.rk);
    this.freeRKIfTemp(proto, left, l.rk);
    this.freeRKIfTemp(proto, right, r.rk);
    return proto.emit('JMP', 0, 0);
  }

  // --------------- Expression emission -----------------

  exprToReg(proto, e, dest) {
    switch (e.type) {
      case 'NilLiteral': proto.emit('LOADNIL', dest, dest); return;
      case 'BoolLiteral': proto.emit('LOADBOOL', dest, e.value ? 1 : 0, 0); return;
      case 'NumberLiteral': proto.emit('LOADK', dest, proto.addConst(e.value)); return;
      case 'StringLiteral': proto.emit('LOADK', dest, proto.addConst(e.value)); return;
      case 'Vararg': proto.emit('VARARG', dest, 2); return; // one value
      case 'Identifier': return this.identToReg(proto, e, dest);
      case 'Paren': {
        // Parens force single value
        this.exprToReg(proto, e.expr, dest);
        return;
      }
      case 'Unary': return this.unaryToReg(proto, e, dest);
      case 'Binary': return this.binaryToReg(proto, e, dest);
      case 'Call':
      case 'MethodCall': {
        const savedTop = proto.frameTop;
        // Compile call expecting one result at frame-top
        if (dest === savedTop - 1) {
          // dest may collide; use separate temp then move
        }
        // Use a temp region at current top
        const top = savedTop;
        this._compileCallExpr(proto, e, 1);
        proto.emit('MOVE', dest, top);
        proto.frameTop = savedTop;
        return;
      }
      case 'Table': return this.tableToReg(proto, e, dest);
      case 'FunctionExpression': return this.functionExprToReg(proto, e, dest);
      case 'Index': return this.indexToReg(proto, e, dest);
      default: throw new Error('exprToReg: unknown ' + e.type);
    }
  }

  identToReg(proto, e, dest) {
    const res = e._res;
    if (res.kind === 'local') {
      const loc = res.local;
      if (loc.escapes) proto.emit('GETBOX', dest, loc.slot);
      else if (dest !== loc.slot) proto.emit('MOVE', dest, loc.slot);
      return;
    }
    if (res.kind === 'upvalue') { proto.emit('GETUPVAL', dest, res.index); return; }
    const k = proto.addConst(e.name);
    proto.emit('GETGLOBAL', dest, k);
  }

  exprToAnyReg(proto, e) {
    if (e.type === 'Identifier' && e._res.kind === 'local' && !e._res.local.escapes) {
      // Return its slot directly; not a temp.
      return e._res.local.slot;
    }
    const r = proto.reserveReg();
    this.exprToReg(proto, e, r);
    return r;
  }

  freeRegIfTemp(proto, r) {
    // If r is at or above frameTop-1 and is a temp, free it.
    if (r === proto.frameTop - 1) proto.freeReg(1);
  }

  exprToRK(proto, e) {
    if (e.type === 'NumberLiteral' || e.type === 'StringLiteral' || e.type === 'BoolLiteral' || e.type === 'NilLiteral') {
      let v;
      if (e.type === 'NilLiteral') v = null;
      else if (e.type === 'BoolLiteral') v = e.value;
      else v = e.value;
      const k = proto.addConst(v);
      return { rk: RK_K_OFFSET + k, isK: true };
    }
    if (e.type === 'Identifier' && e._res.kind === 'local' && !e._res.local.escapes) {
      return { rk: e._res.local.slot, isK: false };
    }
    const r = proto.reserveReg();
    this.exprToReg(proto, e, r);
    return { rk: r, isK: false };
  }

  freeRKIfTemp(proto, e, rk) {
    if (rk >= RK_K_OFFSET) return;
    if (e.type === 'Identifier' && e._res.kind === 'local' && !e._res.local.escapes) return;
    this.freeRegIfTemp(proto, rk);
  }

  unaryToReg(proto, e, dest) {
    const r = this.exprToAnyReg(proto, e.arg);
    const op = e.op === '-' ? 'UNM' : e.op === 'not' ? 'NOT' : e.op === '#' ? 'LEN' : null;
    if (!op) throw new Error('bad unary ' + e.op);
    proto.emit(op, dest, r);
    this.freeRegIfTemp(proto, r);
  }

  binaryToReg(proto, e, dest) {
    if (e.op === 'and' || e.op === 'or') return this.logicalToReg(proto, e, dest);
    if (e.op === '..') return this.concatToReg(proto, e, dest);
    if (['<', '<=', '>', '>=', '==', '~='].includes(e.op)) return this.compareToReg(proto, e, dest);
    const opMap = { '+':'ADD', '-':'SUB', '*':'MUL', '/':'DIV', '%':'MOD', '^':'POW' };
    const op = opMap[e.op];
    if (!op) throw new Error('bad bin ' + e.op);
    const l = this.exprToRK(proto, e.left);
    const r = this.exprToRK(proto, e.right);
    proto.emit(op, dest, l.rk, r.rk);
    this.freeRKIfTemp(proto, e.right, r.rk);
    this.freeRKIfTemp(proto, e.left, l.rk);
  }

  logicalToReg(proto, e, dest) {
    // a and b => if (a) then dest=b else dest=a
    // a or b  => if (a) then dest=a else dest=b
    this.exprToReg(proto, e.left, dest);
    // TEST dest C: if ((toBool(R[A]) == (C!=0)) fallthrough else skip next (JMP).
    // For 'and': short-circuit when left is false: skip right eval.
    //   => TEST dest 0 (fallthrough when dest is false... no wait, we want: if dest is false, skip evaluating right). 
    // Our VM semantics (defined above in emitCondJump): TEST A C = "if toBool(R[A]) == (C!=0) then fallthrough else skip next".
    // Want: 'and': if left is falsy, skip right (leave dest=left). So we want: fallthrough iff left truthy.
    //   toBool == (C!=0) must hold when left truthy, i.e., C=1 for 'and'.
    // 'or': if left is truthy, skip right. Fallthrough iff left falsy => C=0.
    const c = e.op === 'and' ? 1 : 0;
    proto.emit('TEST', dest, 0, c);
    const jmp = proto.emit('JMP', 0, 0);
    this.exprToReg(proto, e.right, dest);
    proto.setInsn(jmp, { b: proto.insns.length - jmp - 1 });
  }

  concatToReg(proto, e, dest) {
    // Collect chain: a..b..c..d => emit CONCAT dest b e where R[b..e] hold values.
    const chain = [];
    let cur = e;
    while (cur.type === 'Binary' && cur.op === '..') {
      chain.push(cur.left);
      cur = cur.right;
    }
    chain.push(cur);
    const base = proto.frameTop;
    for (let i = 0; i < chain.length; i++) {
      const r = proto.reserveReg();
      this.exprToReg(proto, chain[i], r);
    }
    proto.emit('CONCAT', dest, base, base + chain.length - 1);
    proto.freeReg(chain.length);
  }

  compareToReg(proto, e, dest) {
    // Emit compare + jump, producing bool in dest.
    // Pattern: OP_JMP over LOADBOOL true/false.
    const jmpToTrue = this.emitCompareJump(proto, e, /* jumpIfFalse */ false);
    // false path
    proto.emit('LOADBOOL', dest, 0, 1); // set false, then skip next (so LOADBOOL true is not executed)
    proto.setInsn(jmpToTrue, { b: proto.insns.length - jmpToTrue - 1 });
    proto.emit('LOADBOOL', dest, 1, 0);
  }

  tableToReg(proto, e, dest) {
    const savedTop = proto.frameTop;
    let arrCount = 0;
    let hashCount = 0;
    for (const f of e.fields) { if (f.kind === 'item') arrCount++; else hashCount++; }
    proto.emit('NEWTABLE', dest, arrCount, hashCount);
    // kv fields first
    for (const f of e.fields) {
      if (f.kind === 'kv') {
        const keyRK = this.exprToRK(proto, f.key);
        const valRK = this.exprToRK(proto, f.value);
        proto.emit('SETTABLE', dest, keyRK.rk, valRK.rk);
        this.freeRKIfTemp(proto, f.value, valRK.rk);
        this.freeRKIfTemp(proto, f.key, keyRK.rk);
      }
    }
    proto.frameTop = savedTop;
    const arrFields = e.fields.filter(f => f.kind === 'item');
    const BATCH = 50;
    let batch = 0;
    let i = 0;
    while (i < arrFields.length) {
      const batchStart = proto.frameTop;
      let count = 0;
      let multi = false;
      while (i < arrFields.length && count < BATCH) {
        const f = arrFields[i];
        const isLast = (i === arrFields.length - 1);
        if (isLast && (f.value.type === 'Call' || f.value.type === 'MethodCall' || f.value.type === 'Vararg')) {
          // Multi: emit at current frameTop, don't reserveReg (VM uses top).
          if (f.value.type === 'Vararg') {
            proto.emit('VARARG', proto.frameTop, 0);
          } else {
            this._compileCallExpr(proto, f.value, -1);
          }
          multi = true;
          i++;
          count++;
          break;
        }
        const r = proto.reserveReg();
        this.exprToReg(proto, f.value, r);
        count++;
        i++;
      }
      if (count > 0) {
        proto.emit('SETLIST', dest, multi ? 0 : count, batch + 1);
        batch++;
      }
      // Always restore frameTop to savedTop after each batch.
      proto.frameTop = savedTop;
    }
  }

  functionExprToReg(proto, e, dest) {
    const sub = this.compileClosure(proto, e);
    const pIdx = proto.protos.push(sub) - 1;
    proto.emit('CLOSURE', dest, pIdx);
    this.emitCloseUpvalues(proto, e._func);
  }

  indexToReg(proto, e, dest) {
    const objReg = this.exprToAnyReg(proto, e.object);
    const idx = this.exprToRK(proto, e.index);
    proto.emit('GETTABLE', dest, objReg, idx.rk);
    this.freeRKIfTemp(proto, e.index, idx.rk);
    this.freeRegIfTemp(proto, objReg);
  }
}

function compile(ast, sourceName) {
  return new Compiler().compile(ast, sourceName);
}

module.exports = { compile, Compiler, Proto };
