'use strict';
/**
 * Safe rules engine. No eval / Function.
 * A rule is either:
 *   { id, field, op, value }          -> structured comparison
 *   { id, expr: "a <= b * 5" }        -> expression, parsed by the tiny parser below
 * Composite: { id, all: [rules] } / { id, any: [rules] } / { id, not: rule }
 */
const OPS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  exists: (a) => a !== undefined && a !== null,
};

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ---------- expression parser (recursive descent) ----------
function tokenize(src) {
  const re = /\s*(>=|<=|==|!=|&&|\|\||[()+\-*/<>!]|\d+\.?\d*|[A-Za-z_][\w.]*|'[^']*'|"[^"]*")/y;
  const tokens = [];
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new Error(`Unexpected character at ${pos} in "${src}"`);
    }
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

function parseExpr(src) {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const next = () => t[i++];
  const levels = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/']];

  function parseLevel(l) {
    if (l === levels.length) return parseUnary();
    let left = parseLevel(l + 1);
    while (levels[l].includes(peek())) {
      const op = next();
      left = { op, left, right: parseLevel(l + 1) };
    }
    return left;
  }
  function parseUnary() {
    if (peek() === '!') { next(); return { op: '!', arg: parseUnary() }; }
    if (peek() === '-') { next(); return { op: 'neg', arg: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const tok = next();
    if (tok === undefined) throw new Error(`Unexpected end of expression "${src}"`);
    if (tok === '(') {
      const e = parseLevel(0);
      if (next() !== ')') throw new Error(`Missing ) in "${src}"`);
      return e;
    }
    if (/^\d/.test(tok)) return { lit: parseFloat(tok) };
    if (/^['"]/.test(tok)) return { lit: tok.slice(1, -1) };
    if (tok === 'true') return { lit: true };
    if (tok === 'false') return { lit: false };
    if (/^[A-Za-z_]/.test(tok)) return { ref: tok };
    throw new Error(`Unexpected token "${tok}" in "${src}"`);
  }
  const ast = parseLevel(0);
  if (i < t.length) throw new Error(`Unexpected token "${t[i]}" in "${src}"`);
  return ast;
}

function evalAst(n, data, refs) {
  if ('lit' in n) return n.lit;
  if ('ref' in n) { const v = getPath(data, n.ref); refs[n.ref] = v; return v; }
  if (n.op === '!') return !evalAst(n.arg, data, refs);
  if (n.op === 'neg') return -evalAst(n.arg, data, refs);
  const a = evalAst(n.left, data, refs);
  const b = evalAst(n.right, data, refs);
  switch (n.op) {
    case '||': return a || b;
    case '&&': return a && b;
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    default: throw new Error(`Unknown operator ${n.op}`);
  }
}

/** Validate a rule definition at config-load time (fail fast). */
function validateRule(rule) {
  if (!rule.id) throw new Error('Rule missing id');
  if (rule.expr) { parseExpr(rule.expr); return; }
  if (rule.all || rule.any) { (rule.all || rule.any).forEach(validateRule); return; }
  if (rule.not) { validateRule(rule.not); return; }
  if (!rule.field || !OPS[rule.op]) throw new Error(`Rule ${rule.id}: invalid field/op`);
}

/** Evaluate one rule. Returns a trace entry: { ruleId, description, passed, reason, ... } */
function evaluateRule(rule, data) {
  const base = { ruleId: rule.id, description: rule.description || '' };
  try {
    if (rule.expr) {
      const refs = {};
      const result = Boolean(evalAst(parseExpr(rule.expr), data, refs));
      return { ...base, passed: result, expr: rule.expr, inputs: refs,
        reason: `${rule.expr} evaluated to ${result} with ${JSON.stringify(refs)}` };
    }
    if (rule.all || rule.any) {
      const children = (rule.all || rule.any).map((r) => evaluateRule(r, data));
      const passed = rule.all ? children.every((c) => c.passed) : children.some((c) => c.passed);
      return { ...base, passed, children, reason: `${rule.all ? 'all' : 'any'} of ${children.length} sub-rules -> ${passed}` };
    }
    if (rule.not) {
      const child = evaluateRule(rule.not, data);
      return { ...base, passed: !child.passed, children: [child], reason: `not(${child.passed})` };
    }
    const actual = getPath(data, rule.field);
    const passed = Boolean(OPS[rule.op](actual, rule.value));
    return { ...base, passed, field: rule.field, op: rule.op, expected: rule.value, actual,
      reason: `${rule.field} (${JSON.stringify(actual)}) ${rule.op} ${JSON.stringify(rule.value)} -> ${passed}` };
  } catch (err) {
    // A rule that cannot be evaluated counts as failed, never as silently passed.
    return { ...base, passed: false, error: err.message, reason: `Rule errored: ${err.message}` };
  }
}

/** Run rules in order; stops at first failure. Returns { passed, failedRule, trace }. */
function evaluateRules(rules, data) {
  const trace = [];
  for (const rule of rules) {
    const entry = evaluateRule(rule, data);
    trace.push(entry);
    if (!entry.passed) return { passed: false, failedRule: rule, trace };
  }
  return { passed: true, failedRule: null, trace };
}

module.exports = { evaluateRule, evaluateRules, validateRule, parseExpr, getPath };
