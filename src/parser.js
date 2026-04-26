// Hand-rolled Lua 5.1 lexer + recursive-descent parser.
// Produces an AST consumed by src/compiler.js.

'use strict';

const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
  'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat',
  'return', 'then', 'true', 'until', 'while',
]);

function isDigit(c) { return c >= '0' && c <= '9'; }
function isHex(c) { return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
function isAlpha(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }

class Lexer {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.tokens = [];
  }

  peek(o = 0) { return this.src[this.pos + o]; }

  advance() {
    const c = this.src[this.pos++];
    if (c === '\n') { this.line++; this.col = 1; } else { this.col++; }
    return c;
  }

  pushTok(type, value) {
    this.tokens.push({ type, value, line: this.line });
  }

  skipLongBracket(level) {
    // already consumed "[="*level"["
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === ']') {
        let lookahead = 1;
        let eq = 0;
        while (this.src[this.pos + lookahead] === '=') { lookahead++; eq++; }
        if (eq === level && this.src[this.pos + lookahead] === ']') {
          // consume closing
          for (let i = 0; i < lookahead + 1; i++) this.advance();
          return out;
        }
      }
      out += this.advance();
    }
    throw new Error(`unterminated long bracket at line ${this.line}`);
  }

  tryLongBracketOpen() {
    // positioned at '['
    let i = this.pos + 1;
    let level = 0;
    while (this.src[i] === '=') { level++; i++; }
    if (this.src[i] === '[') {
      // consume [=*[
      for (let k = 0; k < level + 2; k++) this.advance();
      // optional first newline
      if (this.peek() === '\n') this.advance();
      return level;
    }
    return -1;
  }

  readString(quote) {
    this.advance(); // opening quote
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === quote) { this.advance(); return out; }
      if (c === '\n') throw new Error(`unterminated string at line ${this.line}`);
      if (c === '\\') {
        this.advance();
        const e = this.advance();
        switch (e) {
          case 'a': out += '\x07'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'v': out += '\x0b'; break;
          case '\\': out += '\\'; break;
          case '"': out += '"'; break;
          case '\'': out += '\''; break;
          case '\n': out += '\n'; break;
          default: {
            if (isDigit(e)) {
              let num = e;
              for (let k = 0; k < 2; k++) {
                if (isDigit(this.peek())) num += this.advance();
              }
              const n = parseInt(num, 10);
              if (n > 255) throw new Error(`bad decimal escape at line ${this.line}`);
              out += String.fromCharCode(n);
            } else {
              throw new Error(`bad escape sequence \\${e} at line ${this.line}`);
            }
          }
        }
      } else {
        out += this.advance();
      }
    }
    throw new Error(`unterminated string at line ${this.line}`);
  }

  readNumber() {
    let s = '';
    let isFloat = false;
    if (this.peek() === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
      s += this.advance(); s += this.advance();
      while (isHex(this.peek())) s += this.advance();
      this.pushTok('number', parseInt(s, 16));
      return;
    }
    while (isDigit(this.peek())) s += this.advance();
    if (this.peek() === '.') { isFloat = true; s += this.advance(); while (isDigit(this.peek())) s += this.advance(); }
    if (this.peek() === 'e' || this.peek() === 'E') {
      isFloat = true;
      s += this.advance();
      if (this.peek() === '+' || this.peek() === '-') s += this.advance();
      while (isDigit(this.peek())) s += this.advance();
    }
    this.pushTok('number', isFloat ? parseFloat(s) : parseInt(s, 10));
  }

  lex() {
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { this.advance(); continue; }
      if (c === '-' && this.peek(1) === '-') {
        this.advance(); this.advance();
        // long comment?
        if (this.peek() === '[') {
          const saved = { pos: this.pos, line: this.line, col: this.col };
          const level = this.tryLongBracketOpen();
          if (level >= 0) { this.skipLongBracket(level); continue; }
          this.pos = saved.pos; this.line = saved.line; this.col = saved.col;
        }
        while (this.pos < this.src.length && this.peek() !== '\n') this.advance();
        continue;
      }
      if (c === '[' && (this.peek(1) === '[' || this.peek(1) === '=')) {
        const saved = { pos: this.pos, line: this.line, col: this.col };
        const level = this.tryLongBracketOpen();
        if (level >= 0) {
          const content = this.skipLongBracket(level);
          this.pushTok('string', content);
          continue;
        }
        this.pos = saved.pos; this.line = saved.line; this.col = saved.col;
      }
      if (isDigit(c) || (c === '.' && isDigit(this.peek(1)))) { this.readNumber(); continue; }
      if (isAlpha(c)) {
        let ident = '';
        while (isAlnum(this.peek())) ident += this.advance();
        if (KEYWORDS.has(ident)) this.pushTok(ident, ident);
        else this.pushTok('name', ident);
        continue;
      }
      if (c === '"' || c === '\'') { const s = this.readString(c); this.pushTok('string', s); continue; }

      // operators / punct
      const two = c + (this.peek(1) || '');
      const three = two + (this.peek(2) || '');
      if (three === '...') { this.advance(); this.advance(); this.advance(); this.pushTok('...', '...'); continue; }
      if (two === '==' || two === '~=' || two === '<=' || two === '>=' || two === '..' || two === '::') {
        this.advance(); this.advance(); this.pushTok(two, two); continue;
      }
      if ('+-*/%^#<>=(){}[];:,.'.includes(c)) {
        this.advance(); this.pushTok(c, c); continue;
      }
      throw new Error(`unexpected character '${c}' at line ${this.line}`);
    }
    this.pushTok('eof', null);
    return this.tokens;
  }
}

class Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek(o = 0) { return this.tokens[this.pos + o]; }
  advance() { return this.tokens[this.pos++]; }
  check(type) { return this.peek().type === type; }
  match(type) { if (this.check(type)) { this.advance(); return true; } return false; }
  expect(type) {
    const t = this.peek();
    if (t.type !== type) throw new Error(`expected ${type} got ${t.type} (${t.value}) at line ${t.line}`);
    return this.advance();
  }

  parseChunk() {
    const body = this.parseBlock();
    this.expect('eof');
    return { type: 'Chunk', body };
  }

  parseBlock() {
    const stats = [];
    while (!this.isBlockEnd()) {
      if (this.check('return')) { stats.push(this.parseReturn()); break; }
      if (this.check('break')) { this.advance(); stats.push({ type: 'BreakStatement' }); this.match(';'); break; }
      const s = this.parseStatement();
      if (s) stats.push(s);
    }
    return stats;
  }

  isBlockEnd() {
    const t = this.peek().type;
    return t === 'eof' || t === 'end' || t === 'else' || t === 'elseif' || t === 'until';
  }

  parseReturn() {
    this.expect('return');
    const args = [];
    if (!this.isBlockEnd() && !this.check(';')) {
      args.push(this.parseExp());
      while (this.match(',')) args.push(this.parseExp());
    }
    this.match(';');
    return { type: 'ReturnStatement', args };
  }

  parseStatement() {
    const t = this.peek();
    switch (t.type) {
      case ';': this.advance(); return null;
      case 'if': return this.parseIf();
      case 'while': return this.parseWhile();
      case 'do': return this.parseDo();
      case 'for': return this.parseFor();
      case 'repeat': return this.parseRepeat();
      case 'function': return this.parseFunctionDecl();
      case 'local': return this.parseLocal();
      default: return this.parseExprStatement();
    }
  }

  parseIf() {
    this.expect('if');
    const cond = this.parseExp();
    this.expect('then');
    const thenBody = this.parseBlock();
    const clauses = [{ cond, body: thenBody }];
    let elseBody = null;
    while (this.check('elseif')) {
      this.advance();
      const c = this.parseExp();
      this.expect('then');
      const b = this.parseBlock();
      clauses.push({ cond: c, body: b });
    }
    if (this.match('else')) elseBody = this.parseBlock();
    this.expect('end');
    return { type: 'IfStatement', clauses, elseBody };
  }

  parseWhile() {
    this.expect('while');
    const cond = this.parseExp();
    this.expect('do');
    const body = this.parseBlock();
    this.expect('end');
    return { type: 'WhileStatement', cond, body };
  }

  parseDo() {
    this.expect('do');
    const body = this.parseBlock();
    this.expect('end');
    return { type: 'DoStatement', body };
  }

  parseRepeat() {
    this.expect('repeat');
    const body = this.parseBlock();
    this.expect('until');
    const cond = this.parseExp();
    return { type: 'RepeatStatement', body, cond };
  }

  parseFor() {
    this.expect('for');
    const name = this.expect('name').value;
    if (this.match('=')) {
      const start = this.parseExp();
      this.expect(',');
      const limit = this.parseExp();
      let step = null;
      if (this.match(',')) step = this.parseExp();
      this.expect('do');
      const body = this.parseBlock();
      this.expect('end');
      return { type: 'NumericFor', name, start, limit, step, body };
    }
    const names = [name];
    while (this.match(',')) names.push(this.expect('name').value);
    this.expect('in');
    const exprs = [this.parseExp()];
    while (this.match(',')) exprs.push(this.parseExp());
    this.expect('do');
    const body = this.parseBlock();
    this.expect('end');
    return { type: 'GenericFor', names, exprs, body };
  }

  parseFunctionDecl() {
    this.expect('function');
    const nameBase = this.expect('name').value;
    const dots = [];
    let method = null;
    let target = { type: 'Identifier', name: nameBase };
    while (this.match('.')) {
      const f = this.expect('name').value;
      target = { type: 'Index', object: target, index: { type: 'StringLiteral', value: f } };
      dots.push(f);
    }
    if (this.match(':')) {
      method = this.expect('name').value;
      target = { type: 'Index', object: target, index: { type: 'StringLiteral', value: method } };
    }
    const fn = this.parseFuncBody(method !== null);
    return { type: 'FunctionDeclaration', target, func: fn };
  }

  parseLocal() {
    this.expect('local');
    if (this.match('function')) {
      const name = this.expect('name').value;
      const fn = this.parseFuncBody(false);
      return { type: 'LocalFunction', name, func: fn };
    }
    const names = [this.expect('name').value];
    while (this.match(',')) names.push(this.expect('name').value);
    let exprs = [];
    if (this.match('=')) {
      exprs.push(this.parseExp());
      while (this.match(',')) exprs.push(this.parseExp());
    }
    return { type: 'LocalStatement', names, exprs };
  }

  parseFuncBody(isMethod) {
    this.expect('(');
    const params = [];
    let vararg = false;
    if (isMethod) params.push('self');
    if (!this.check(')')) {
      if (this.match('...')) vararg = true;
      else {
        params.push(this.expect('name').value);
        while (this.match(',')) {
          if (this.match('...')) { vararg = true; break; }
          params.push(this.expect('name').value);
        }
      }
    }
    this.expect(')');
    const body = this.parseBlock();
    this.expect('end');
    return { type: 'FunctionExpression', params, vararg, body };
  }

  parseExprStatement() {
    const expr = this.parseSuffixed();
    if (this.check('=') || this.check(',')) {
      const targets = [expr];
      while (this.match(',')) targets.push(this.parseSuffixed());
      this.expect('=');
      const values = [this.parseExp()];
      while (this.match(',')) values.push(this.parseExp());
      for (const t of targets) {
        if (t.type !== 'Identifier' && t.type !== 'Index') throw new Error('invalid assignment target');
      }
      return { type: 'AssignStatement', targets, values };
    }
    if (expr.type !== 'Call' && expr.type !== 'MethodCall') throw new Error(`syntax error: unexpected ${this.peek().type}`);
    return { type: 'ExpressionStatement', expr };
  }

  // Pratt-like expression parser by precedence.
  parseExp() { return this.parseOr(); }

  parseOr() {
    let left = this.parseAnd();
    while (this.match('or')) left = { type: 'Binary', op: 'or', left, right: this.parseAnd() };
    return left;
  }
  parseAnd() {
    let left = this.parseCmp();
    while (this.match('and')) left = { type: 'Binary', op: 'and', left, right: this.parseCmp() };
    return left;
  }
  parseCmp() {
    let left = this.parseConcat();
    while (['<', '>', '<=', '>=', '==', '~='].includes(this.peek().type)) {
      const op = this.advance().type;
      left = { type: 'Binary', op, left, right: this.parseConcat() };
    }
    return left;
  }
  parseConcat() {
    const left = this.parseAdd();
    if (this.match('..')) return { type: 'Binary', op: '..', left, right: this.parseConcat() };
    return left;
  }
  parseAdd() {
    let left = this.parseMul();
    while (this.peek().type === '+' || this.peek().type === '-') {
      const op = this.advance().type;
      left = { type: 'Binary', op, left, right: this.parseMul() };
    }
    return left;
  }
  parseMul() {
    let left = this.parseUnary();
    while (this.peek().type === '*' || this.peek().type === '/' || this.peek().type === '%') {
      const op = this.advance().type;
      left = { type: 'Binary', op, left, right: this.parseUnary() };
    }
    return left;
  }
  parseUnary() {
    if (this.peek().type === 'not' || this.peek().type === '-' || this.peek().type === '#') {
      const op = this.advance().type;
      return { type: 'Unary', op, arg: this.parseUnary() };
    }
    return this.parsePow();
  }
  parsePow() {
    const left = this.parseSuffixed();
    if (this.match('^')) return { type: 'Binary', op: '^', left, right: this.parseUnary() };
    return left;
  }

  parseSuffixed() {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.type === '.') {
        this.advance();
        const name = this.expect('name').value;
        e = { type: 'Index', object: e, index: { type: 'StringLiteral', value: name } };
      } else if (t.type === '[') {
        this.advance();
        const idx = this.parseExp();
        this.expect(']');
        e = { type: 'Index', object: e, index: idx };
      } else if (t.type === ':') {
        this.advance();
        const method = this.expect('name').value;
        const args = this.parseCallArgs();
        e = { type: 'MethodCall', object: e, method, args };
      } else if (t.type === '(' || t.type === 'string' || t.type === '{') {
        const args = this.parseCallArgs();
        e = { type: 'Call', func: e, args };
      } else break;
    }
    return e;
  }

  parseCallArgs() {
    const t = this.peek();
    if (t.type === '(') {
      this.advance();
      const args = [];
      if (!this.check(')')) {
        args.push(this.parseExp());
        while (this.match(',')) args.push(this.parseExp());
      }
      this.expect(')');
      return args;
    }
    if (t.type === 'string') { this.advance(); return [{ type: 'StringLiteral', value: t.value }]; }
    if (t.type === '{') return [this.parseTable()];
    throw new Error(`expected call args at line ${t.line}`);
  }

  parsePrimary() {
    const t = this.peek();
    switch (t.type) {
      case 'nil': this.advance(); return { type: 'NilLiteral' };
      case 'true': this.advance(); return { type: 'BoolLiteral', value: true };
      case 'false': this.advance(); return { type: 'BoolLiteral', value: false };
      case 'number': this.advance(); return { type: 'NumberLiteral', value: t.value };
      case 'string': this.advance(); return { type: 'StringLiteral', value: t.value };
      case '...': this.advance(); return { type: 'Vararg' };
      case 'function': this.advance(); return this.parseFuncBody(false);
      case '{': return this.parseTable();
      case '(': {
        this.advance();
        const inner = this.parseExp();
        this.expect(')');
        return { type: 'Paren', expr: inner };
      }
      case 'name': this.advance(); return { type: 'Identifier', name: t.value };
      default: throw new Error(`unexpected token ${t.type} at line ${t.line}`);
    }
  }

  parseTable() {
    this.expect('{');
    const fields = [];
    while (!this.check('}')) {
      if (this.check('[')) {
        this.advance();
        const k = this.parseExp();
        this.expect(']');
        this.expect('=');
        const v = this.parseExp();
        fields.push({ kind: 'kv', key: k, value: v });
      } else if (this.peek().type === 'name' && this.tokens[this.pos + 1] && this.tokens[this.pos + 1].type === '=') {
        const name = this.advance().value;
        this.advance(); // =
        const v = this.parseExp();
        fields.push({ kind: 'kv', key: { type: 'StringLiteral', value: name }, value: v });
      } else {
        fields.push({ kind: 'item', value: this.parseExp() });
      }
      if (!this.match(',') && !this.match(';')) break;
    }
    this.expect('}');
    return { type: 'Table', fields };
  }
}

function parse(src) {
  const tokens = new Lexer(src).lex();
  return new Parser(tokens).parseChunk();
}

module.exports = { parse, Lexer, Parser };
