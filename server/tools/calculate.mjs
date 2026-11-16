// Safe arithmetic expression evaluator (recursive descent; no eval / Function).
// Grammar:
//   expr    := term (('+'|'-') term)*
//   term    := unary (('*'|'/'|'%'|'//') unary)*     (implicit multiplication: 2pi, 3(4+1))
//   unary   := ('+'|'-') unary | power
//   power   := postfix (('^'|'**') unary)?             (right-associative)
//   postfix := primary ('!' | '%')*
//   primary := number | constant | func '(' args ')' | '(' expr ')'

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2, inf: Infinity, infinity: Infinity };

function factorial(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('factorial is only defined for non-negative integers');
  if (n > 170) return Infinity;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

const deg = (x) => (x * Math.PI) / 180;

const FUNCS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)), log10: Math.log10, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sind: (x) => Math.sin(deg(x)), cosd: (x) => Math.cos(deg(x)), tand: (x) => Math.tan(deg(x)),
  floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, sign: Math.sign,
  round: (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; },
  min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
  mod: (a, b) => ((a % b) + b) % b,
  fact: factorial, factorial,
  avg: (...a) => a.reduce((x, y) => x + y, 0) / a.length, mean: (...a) => a.reduce((x, y) => x + y, 0) / a.length,
  sum: (...a) => a.reduce((x, y) => x + y, 0),
  nCr: (n, k) => factorial(n) / (factorial(k) * factorial(n - k)), nPr: (n, k) => factorial(n) / factorial(n - k),
  gcd: (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; },
  lcm: (a, b) => Math.abs(a * b) / FUNCS.gcd(a, b),
};

function tokenize(src) {
  const toks = [];
  const re = /(\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|(\*\*|\/\/|[-+*/%^!(),×÷−])/y;
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`Unexpected character "${src[i]}" at position ${i + 1}`);
    if (m[1] !== undefined) toks.push({ t: 'num', v: Number(m[1].replace(/_/g, '')) });
    else if (m[2] !== undefined) toks.push({ t: 'id', v: m[2] });
    else toks.push({ t: 'op', v: { '×': '*', '÷': '/', '−': '-' }[m[3]] || m[3] });
    i = re.lastIndex;
  }
  return toks;
}

export function evaluate(src) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('Empty expression');
  if (src.length > 1000) throw new Error('Expression too long');
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek()?.t === 'op' && peek().v === v;
  const eat = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++; };

  function expr() {
    if (++depth > 200) throw new Error('Expression too deeply nested');
    let v = term();
    while (isOp('+') || isOp('-')) { const op = toks[p++].v; const r = term(); v = op === '+' ? v + r : v - r; }
    depth--;
    return v;
  }
  function startsPrimary() {
    const t = peek();
    return t && (t.t === 'num' || t.t === 'id' || (t.t === 'op' && t.v === '('));
  }
  function term() {
    let v = unary();
    for (;;) {
      if (isOp('*') || isOp('/') || isOp('%') || isOp('//')) {
        const op = toks[p++].v;
        const r = unary();
        if (op === '*') v *= r;
        else if (op === '/') v /= r;
        else if (op === '//') v = Math.floor(v / r);
        else v %= r;
      } else if (startsPrimary()) {
        v *= unary(); // implicit multiplication
      } else break;
    }
    return v;
  }
  function unary() {
    if (isOp('-')) { p++; return -unary(); }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  function power() {
    const base = postfix();
    if (isOp('^') || isOp('**')) { p++; return base ** unary(); }
    return base;
  }
  function postfix() {
    let v = primary();
    for (;;) {
      if (isOp('!')) { p++; v = factorial(v); continue; }
      // trailing percent: "50%" → 0.5 (only when not followed by an operand)
      if (isOp('%') && !(toks[p + 1] && (toks[p + 1].t === 'num' || toks[p + 1].t === 'id' || toks[p + 1].v === '('))) { p++; v /= 100; continue; }
      break;
    }
    return v;
  }
  function primary() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.t === 'num') { p++; return t.v; }
    if (t.t === 'op' && t.v === '(') { p++; const v = expr(); eat(')'); return v; }
    if (t.t === 'id') {
      p++;
      const name = t.v;
      const lname = name.toLowerCase();
      if (isOp('(')) {
        const fn = Object.hasOwn(FUNCS, name) ? FUNCS[name] : Object.hasOwn(FUNCS, lname) ? FUNCS[lname] : null;
        if (!fn) throw new Error(`Unknown function "${name}"`);
        p++;
        const args = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) { p++; args.push(expr()); }
        }
        eat(')');
        return fn(...args);
      }
      if (Object.hasOwn(CONSTANTS, lname)) return CONSTANTS[lname];
      throw new Error(`Unknown identifier "${name}"`);
    }
    throw new Error(`Unexpected "${t.v}"`);
  }

  const v = expr();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
  if (typeof v !== 'number' || Number.isNaN(v)) throw new Error('Result is not a number');
  return v;
}

export function formatNumber(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
  const r = Number(v.toPrecision(15));
  return String(r);
}
