export class VbsError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

export const word = /^[a-z_][a-z_0-9]*$/i;
const scan = /"(?:""|[^"\n])*"|'.*|&H[0-9a-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z_]\w*|<>|<=|>=|[():,.=<>+*/\\^&-]|\s+|./gi;
const lower = value => value?.toLowerCase();
const uncomment = line => {
  const parts = line.match(scan) ?? [];
  const index = parts.findIndex(part => part.startsWith("'"));
  return (index < 0 ? parts : parts.slice(0, index)).join("");
};

export function sourceLines(source) {
  const lines = [];
  let carry = "";
  let start = 1;
  let continued = false;
  for (const [index, raw] of source.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (!continued) start = index + 1;
    const line = uncomment(raw).trim();
    if (/^rem(?:\s|$)/i.test(line) || !line) continue;
    if (/\s_$/.test(line)) {
      carry += line.slice(0, -1);
      continued = true;
      continue;
    }
    const joined = carry + line;
    const tokens = (joined.match(scan) ?? []).filter(token => token.trim());
    // In a single-line If, colons belong to the conditional body.
    if (lower(tokens[0]) === "if" && tokens.findIndex(token => lower(token) === "then") < tokens.length - 1) {
      lines.push({ line: start, tokens });
    } else {
      let group = [];
      for (const token of [...tokens, ":"]) {
        if (token === ":") {
          if (group.length && lower(group[0]) !== "rem") lines.push({ line: start, tokens: group });
          group = [];
        } else group.push(token);
      }
    }
    carry = "";
    continued = false;
  }
  if (continued) throw new VbsError("Unfinished line continuation", start);
  return lines;
}

const precedence = {
  imp: 1, eqv: 2, xor: 3, or: 4, and: 5,
  "=": 7, "<>": 7, "<": 7, ">": 7, "<=": 7, ">=": 7, is: 7,
  "&": 8, "+": 9, "-": 9, mod: 10, "\\": 11, "*": 12, "/": 12, "^": 14,
};

class Cursor {
  constructor(tokens, line) { this.tokens = tokens; this.line = line; this.index = 0; }
  peek() { return lower(this.tokens[this.index]); }
  take() { return this.tokens[this.index++]; }
  accept(token) { if (this.peek() === token) { this.index++; return true; } return false; }
  fail(message) { throw new VbsError(message, this.line); }
  expect(token) { if (!this.accept(token)) this.fail(`Expected ${token}`); }
  end() { if (this.peek() !== undefined) this.fail(`Unexpected token ${this.tokens[this.index]}`); }
  name() { const token = this.take(); if (!word.test(token ?? "")) this.fail("Expected an identifier"); return token.toLowerCase(); }
  list() {
    const values = [this.expr()];
    while (this.accept(",")) values.push(this.expr());
    return values;
  }
  atom() {
    if (this.accept("(")) {
      const value = this.expr();
      this.expect(")");
      return this.postfix(value);
    }
    const token = this.take();
    if (token?.startsWith('"') && token.length > 1) return { literal: token.slice(1, -1).replaceAll('""', '"') };
    if (/^(?:\d|\.\d)/.test(token ?? "")) return { literal: Number(token) };
    if (/^&h/i.test(token ?? "")) return { literal: parseInt(token.slice(2), 16) };
    if (!word.test(token ?? "")) this.fail(`Expected an expression${token ? ` near ${token}` : ""}`);
    return this.postfix({ name: lower(token) });
  }
  postfix(node) {
    while (true) {
      if (this.accept(".")) node = { object: node, member: this.name() };
      else if (this.accept("(")) {
        const args = this.peek() === ")" ? [] : this.list();
        this.expect(")");
        node = { callee: node, args };
      } else return node;
    }
  }
  expr(min = 0) {
    const token = this.peek();
    let left;
    if (["not", "+", "-"].includes(token)) {
      this.take();
      left = { op: token, right: this.expr(token === "not" ? 6 : 13) };
    } else left = this.atom();
    while (this.peek() in precedence && precedence[this.peek()] >= min) {
      const op = lower(this.take());
      left = { op, left, right: this.expr(precedence[op] + 1) };
    }
    return left;
  }
}

function leaf(tokens, line) {
  const c = new Cursor(tokens, line);
  const kind = c.peek();
  if (c.accept("option")) { c.expect("explicit"); c.end(); return { kind: "explicit", line }; }
  if (c.accept("exit")) {
    const target = c.take()?.toLowerCase();
    if (!["for", "do", "sub", "function"].includes(target)) c.fail("Expected Exit For, Do, Sub or Function");
    c.end();
    return { kind, target, line };
  }
  if (c.accept("on")) {
    c.expect("error");
    const enabled = c.accept("resume");
    if (enabled) c.expect("next");
    else { c.expect("goto"); c.expect("0"); }
    c.end();
    return { kind: "onerror", enabled, line };
  }
  if (["dim", "const", "redim"].includes(kind)) {
    c.take();
    const preserve = kind === "redim" && c.accept("preserve");
    const declarations = [];
    do {
      const name = c.name();
      let bounds;
      let initial;
      if (c.accept("(")) {
        bounds = c.peek() === ")" ? [] : c.list();
        c.expect(")");
        if (bounds.length > 1) c.fail("Only one-dimensional arrays are supported");
      }
      if (kind === "const") { c.expect("="); initial = c.expr(); }
      if (kind === "redim" && !bounds?.length) c.fail("ReDim requires an upper bound");
      declarations.push({ name, bounds, initial });
    } while (c.accept(","));
    c.end();
    return { kind, declarations, preserve, line };
  }
  const explicitCall = c.accept("call");
  const objectAssignment = !explicitCall && c.accept("set");
  if (!explicitCall && !objectAssignment) c.accept("let");
  const target = c.postfix({ name: c.name() });
  if (!explicitCall && c.accept("=")) {
    const value = c.expr();
    c.end();
    return { kind: "assign", target, value, line };
  }
  if (objectAssignment) c.fail("Expected = after Set target");
  if (c.peek() === undefined) {
    return { kind: "call", call: target.callee ? target : { callee: target, args: [] }, line };
  }
  if (explicitCall || target.callee) c.fail("Unexpected argument after call");
  const args = c.list();
  c.end();
  return { kind: "call", call: { callee: target, args }, line };
}

export function parse(source) {
  if (source.length > 200_000) throw new VbsError("Source exceeds 200,000 characters", 1);
  const lines = sourceLines(source);
  const procedures = new Map();
  let index = 0;
  let explicit = false;
  function block(ends = [], depth = 0) {
    if (depth > 50) throw new VbsError("Blocks are nested too deeply", lines[index]?.line);
    const body = [];
    const read = (...stops) => block(stops, depth + 1);
    const cursor = () => {
      const entry = lines[index];
      return new Cursor(entry?.tokens ?? [], entry?.line ?? lines.at(-1)?.line ?? 1);
    };
    const signature = () => lines[index]?.tokens.slice(0, 2).map(lower).join(" ") ?? "";
    const matches = stop => signature() === stop || signature().startsWith(stop + " ");
    const close = (...tokens) => {
      const c = cursor();
      for (const token of tokens) c.expect(token);
      index++;
      return c;
    };
    while (index < lines.length && !ends.some(matches)) {
      const { line, tokens } = lines[index++];
      const c = new Cursor(tokens, line);
      const kind = c.peek();
      if (c.accept("if")) {
        const condition = c.expr();
        c.expect("then");
        const branches = [];
        let fallback = [];
        if (c.peek()) {
          const inline = c.tokens.slice(c.index);
          const split = inline.findIndex(token => lower(token) === "else");
          const readInline = parts => {
            const group = [];
            const statements = [];
            for (const token of [...parts, ":"]) {
              if (token === ":") {
                if (group.length) statements.push(leaf(group.splice(0), line));
              } else group.push(token);
            }
            if (!statements.length) c.fail("Expected a statement after Then or Else");
            return statements;
          };
          branches.push({ line, condition, body: readInline(split < 0 ? inline : inline.slice(0, split)) });
          if (split >= 0) fallback = readInline(inline.slice(split + 1));
        } else {
          branches.push({ line, condition, body: read("elseif", "else", "end if") });
          while (matches("elseif")) {
            const branch = close("elseif");
            const test = branch.expr();
            branch.expect("then"); branch.end();
            branches.push({ line: branch.line, condition: test, body: read("elseif", "else", "end if") });
          }
          if (matches("else")) { close("else").end(); fallback = read("end if"); }
          close("end", "if").end();
        }
        body.push({ kind, line, branches, fallback });
      } else if (c.accept("select")) {
        c.expect("case");
        const value = c.expr();
        c.end();
        const cases = [];
        let fallback = [];
        while (matches("case")) {
          const branch = close("case");
          if (branch.accept("else")) { branch.end(); fallback = read("end select"); break; }
          const values = branch.list();
          branch.end();
          cases.push({ values, line: branch.line, body: read("case", "end select") });
        }
        close("end", "select").end();
        body.push({ kind, line, value, cases, fallback });
      } else if (c.accept("for")) {
        const each = c.accept("each");
        const name = c.name();
        let start, end, step, values;
        if (each) { c.expect("in"); values = c.expr(); }
        else {
          c.expect("="); start = c.expr(); c.expect("to"); end = c.expr();
          step = c.accept("step") ? c.expr() : { literal: 1 };
        }
        c.end();
        const loop = read("next");
        const closing = close("next");
        if (closing.peek() && closing.name() !== name) closing.fail("Next variable does not match For");
        closing.end();
        body.push({ kind, line, name, start, end, step, values, body: loop });
      } else if (c.accept("do") || c.accept("while")) {
        const condition = cursor => {
          const until = cursor.accept("until");
          return until || cursor.accept("while") ? { until, value: cursor.expr() } : null;
        };
        const pre = kind === "while" ? { until: false, value: c.expr() } : condition(c);
        c.end();
        const loop = read(kind === "while" ? "wend" : "loop");
        const closing = close(kind === "while" ? "wend" : "loop");
        const post = kind === "do" ? condition(closing) : null;
        closing.end();
        if (pre && post) closing.fail("Use a condition on Do or Loop");
        body.push({ kind: "do", line, pre, post, body: loop });
      } else if (kind === "sub" || kind === "function") {
        if (depth) c.fail("Procedures must be declared at the script level");
        c.take();
        const name = c.name();
        const params = [];
        if (c.accept("(")) {
          if (c.peek() !== ")") {
            do {
              const byVal = c.accept("byval");
              if (!byVal) c.accept("byref");
              const param = c.name();
              if (params.some(item => item.name === param)) c.fail(`Duplicate parameter ${param}`);
              params.push({ name: param, byVal });
            } while (c.accept(","));
          }
          c.expect(")");
        }
        c.end();
        if (procedures.has(name)) c.fail(`Duplicate procedure ${name}`);
        const statements = read(`end ${kind}`);
        close("end", kind).end();
        procedures.set(name, { kind, name, params, line, body: statements });
      } else {
        if (["end", "else", "elseif", "case", "next", "loop", "wend"].includes(kind)) c.fail(`Unexpected ${kind}`);
        const stmt = leaf(tokens, line);
        if (stmt.kind === "explicit") {
          if (depth || explicit || index !== 1) c.fail("Option Explicit must be the first statement");
          explicit = true;
        } else body.push(stmt);
      }
    }
    return body;
  }
  const body = block();
  return { body, explicit, procedures };
}
