import { parse, VbsError } from "./parser.js";
import { fileSystem, virtualObject } from "./files.js";

const key = value => String(value).toLowerCase();
const str = value => value === undefined ? "" : value === null ? "Null" : value === true ? "True" : value === false ? "False" : String(value);
function num(value) {
  if (value === undefined) return 0;
  if (typeof value === "boolean") return value ? -1 : 0;
  if (!["number", "string"].includes(typeof value) || (typeof value === "string" && !value.trim())) throw new Error("Type mismatch");
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error("Type mismatch or numeric overflow");
  return result;
}
const truth = value => value != null && num(value) !== 0;
const divide = (a, b) => { if (!b) throw new Error("Division by zero"); return a / b; };
function round(value) {
  const base = Math.floor(value);
  return value - base === 0.5 ? base + (Math.abs(base) % 2) : Math.round(value);
}
function integer(value, low, high) {
  const result = round(num(value));
  if (result < low || result > high) throw new Error("Integer overflow");
  return result;
}
const indexOf = value => integer(value, 0, 99_999);
const builtins = {
  cint: x => integer(x, -32768, 32767),
  clng: x => integer(x, -2147483648, 2147483647),
  cbyte: x => integer(x, 0, 255),
  cdbl: num, csng: x => Math.fround(num(x)), cbool: truth, cstr: str,
  int: x => Math.floor(num(x)), fix: x => Math.trunc(num(x)), abs: x => Math.abs(num(x)),
  len: x => str(x).length, trim: x => str(x).trim(), ltrim: x => str(x).trimStart(), rtrim: x => str(x).trimEnd(),
  lcase: x => str(x).toLowerCase(), ucase: x => str(x).toUpperCase(),
  left: (x, n) => str(x).slice(0, indexOf(n)),
  right: (x, n) => str(x).slice(Math.max(0, str(x).length - indexOf(n))),
  mid: (x, at, length) => {
    const start = integer(at, 1, 2147483647) - 1;
    return str(x).slice(start, length === undefined ? undefined : start + indexOf(length));
  },
  replace: (x, search, replacement) => str(search) === "" ? str(x) : str(x).split(str(search)).join(str(replacement)),
  split: (x, delimiter = " ", limit = -1) => {
    const value = str(x);
    delimiter = str(delimiter);
    const max = integer(limit, -1, 100_000);
    if (!value || max === 0) return [];
    if (!delimiter || max === 1) return [value];
    const parts = value.split(delimiter);
    if (parts.length > 100_000) throw new Error("Split result exceeds the array limit");
    if (max < 0 || parts.length <= max) return parts;
    return [...parts.slice(0, max - 1), parts.slice(max - 1).join(delimiter)];
  },
  join: (x, delimiter = " ") => {
    if (!Array.isArray(x)) throw new Error("Join requires an array");
    return x.map(str).join(str(delimiter));
  },
  array: (...args) => args, lbound: (x, dimension = 1) => {
    if (!Array.isArray(x) || num(dimension) !== 1) throw new Error("Invalid array dimension");
    return 0;
  },
  ubound: (x, dimension = 1) => {
    if (!Array.isArray(x) || num(dimension) !== 1) throw new Error("Invalid array dimension");
    return x.length - 1;
  },
  isnumeric: x => {
    if (!["string", "number"].includes(typeof x)) return false;
    try { num(x); return true; } catch { return false; }
  },
  isempty: x => x === undefined, isnull: x => x === null, isarray: Array.isArray,
  chr: x => String.fromCharCode(integer(x, 0, 255)),
  asc: x => {
    if (!str(x)) throw new Error("Asc requires a non-empty string");
    return str(x).charCodeAt(0);
  },
  instr: (...args) => {
    const [start, x, search, compare] = args.length === 2 ? [1, ...args, 0] : args;
    const at = integer(start, 1, 2147483647) - 1;
    const text = str(x);
    if (at >= text.length) return 0;
    const needle = str(search);
    return (num(compare) === 1 ? text.toLowerCase().indexOf(needle.toLowerCase(), at) : text.indexOf(needle, at)) + 1;
  },
};
const constants = new Map(Object.entries({
  true: true, false: false, empty: undefined, null: null, nothing: null,
  vbcrlf: "\r\n", vbnewline: "\r\n", vbcr: "\r", vblf: "\n", vbtab: "\t", vbnullstring: "",
  vbbinarycompare: 0, vbtextcompare: 1,
}));

function compare(left, right) {
  if (typeof left === "string" && typeof right === "string") return left === right ? 0 : left < right ? -1 : 1;
  if (left === undefined && typeof right === "string") return compare("", right);
  if (right === undefined && typeof left === "string") return compare(left, "");
  if (typeof left === "string") return 1;
  if (typeof right === "string") return -1;
  return Math.sign(num(left) - num(right));
}
function operate(op, a, b) {
  if (op === "is") return a === b;
  if (op === "&") return str(a ?? "") + str(b ?? "");
  if (a === null || b === null) return null;
  switch (op) {
    case "=": return compare(a, b) === 0;
    case "<>": return compare(a, b) !== 0;
    case "<": return compare(a, b) < 0;
    case ">": return compare(a, b) > 0;
    case "<=": return compare(a, b) <= 0;
    case ">=": return compare(a, b) >= 0;
    case "+": return typeof a === "string" && typeof b === "string" ? a + b : num(a) + num(b);
    case "-": return num(a) - num(b);
    case "*": return num(a) * num(b);
    case "/": return divide(num(a), num(b));
    case "\\": return Math.trunc(divide(round(num(a)), round(num(b))));
    case "mod": { const divisor = round(num(b)); divide(1, divisor); return round(num(a)) % divisor; }
    case "^": return num(a) ** num(b);
    default: {
      const x = num(a), y = num(b);
      const result = op === "and" ? x & y : op === "or" ? x | y : op === "xor" ? x ^ y : op === "eqv" ? ~(x ^ y) : ~x | y;
      return typeof a === "boolean" && typeof b === "boolean" ? result !== 0 : result;
    }
  }
}

class Exit {
  constructor(target) { this.target = target; }
}

export const completions = [
  "Option Explicit", "Dim", "Const", "ReDim Preserve", "If", "Then", "ElseIf", "Else", "End If",
  "For", "For Each", "Next", "Do While", "Do Until", "Loop", "While", "Wend", "Select Case", "Case", "End Select",
  "Function", "End Function", "Sub", "End Sub", "Exit", "On Error Resume Next", "On Error GoTo 0", "Set",
  "SmartTags", "ShowSystemAlarm", "HMIRuntime.Trace", "CreateObject", "Scripting.FileSystemObject",
  "OpenTextFile", "CreateTextFile", "FileExists", "FolderExists", "GetFolder", "BuildPath", "GetExtensionName", "AtEndOfStream", "ReadLine", "ReadAll", "Write", "WriteLine", "Close",
  "True", "False", "Empty", "Null", "Nothing", "And", "Or", "Not", "Mod", "ByVal", "ByRef", "Call", "Err", "vbCrLf",
  ...Object.keys(builtins),
];

export function createRuntime(source, { tags = new Map(), files = new Map(), log = () => {}, entry = "" } = {}) {
  const program = parse(source);
  const globals = frame("Script");
  const tagIndex = name => {
    const found = [...tags.keys()].find(existing => key(existing) === key(name));
    if (found === undefined) throw new Error(`Unknown SmartTag "${name}". Add it in the SmartTags panel.`);
    return found;
  };
  const smartTags = name => tags.get(tagIndex(name));
  const writeTag = (name, value) => {
    if (value !== undefined && value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error("The simulator supports scalar SmartTags");
    }
    tags.set(tagIndex(name), value);
  };
  const err = { number: 0, description: "" };
  const clearError = () => { err.number = 0; err.description = ""; };
  const output = (kind, value) => log(kind, str(value).slice(0, 20_000));
  const system = new Map([
    ["smarttags", smartTags],
    ["showsystemalarm", value => output("Alarm", value)],
    ["msgbox", value => { output("Message", value); return 1; }],
    ["createobject", progId => {
      if (key(progId) !== "scripting.filesystemobject") throw new Error(`Unsupported COM object: ${progId}`);
      return fileSystem(files);
    }],
    ["hmiruntime", virtualObject({ smarttags: () => smartTags }, { trace: value => output("Trace", value) })],
    ["err", virtualObject({ number: () => err.number, description: () => err.description }, { clear: clearError })],
    ...Object.entries(builtins),
  ]);
  let current = globals;
  let line = 1;
  let steps = 0;
  let depth = 0;
  let expressionDepth = 0;

  function frame(name) {
    return { name, vars: new Map(), resume: false };
  }
  const binding = (scope, name) => scope.vars.get(name) ?? globals.vars.get(name);
  function declare(scope, name, value, constant = false) {
    let stored = value;
    const cell = { constant, get: () => stored, set: next => { stored = next; } };
    scope.vars.set(name, cell);
    return cell;
  }
  function get(scope, name) {
    const variable = binding(scope, name);
    if (variable) return variable.get();
    if (constants.has(name)) return constants.get(name);
    if (system.has(name)) return system.get(name);
    if (program.procedures.has(name)) return program.procedures.get(name);
    if (program.explicit) throw new Error(`Variable is not declared: ${name}`);
    return undefined;
  }
  function assign(scope, name, value) {
    const variable = binding(scope, name);
    if (variable?.constant || constants.has(name)) throw new Error(`Cannot assign to constant ${name}`);
    if (variable) variable.set(value);
    else if (program.explicit) throw new Error(`Variable is not declared: ${name}`);
    else declare(scope, name, value);
  }
  function property(obj, name) {
    if (!obj?.virtual) throw new Error(`Unsupported object member: ${name}`);
    if (Object.hasOwn(obj.properties, name)) return obj.properties[name]();
    if (Object.hasOwn(obj.methods, name)) return obj.methods[name];
    throw new Error(`Unsupported object member: ${name}`);
  }
  function arrayIndex(array, args) {
    if (args.length !== 1) throw new Error("Expected one array index");
    const index = indexOf(args[0]);
    if (index >= array.length) throw new Error("Subscript out of range");
    return index;
  }

  function* invoke(scope, proc, args, nodes = []) {
    if (args.length !== proc.params.length) throw new Error(`${proc.name} expects ${proc.params.length} arguments`);
    if (depth >= 48) throw new Error("Procedure call depth exceeded");
    depth++;
    const locals = frame(proc.name);
    proc.params.forEach(({name, byVal}, index) => {
      const ref = !byVal && nodes[index]?.name && binding(scope, nodes[index].name);
      if (ref && !ref.constant) locals.vars.set(name, ref);
      else declare(locals, name, args[index]);
    });
    if (proc.kind === "function") declare(locals, proc.name);
    const caller = current;
    const callerLine = line;
    current = locals;
    try {
      yield* execute(proc.body, locals);
    } catch (error) {
      if (!(error instanceof Exit) || error.target !== proc.kind) throw error;
    } finally {
      current = caller;
      line = callerLine;
      depth--;
    }
    return locals.vars.get(proc.name)?.get();
  }

  function* value(node, scope, asCallee = false) {
    if (++expressionDepth > 160) {
      expressionDepth--;
      throw new Error("Expression nesting limit exceeded");
    }
    try {
      if ("literal" in node) return node.literal;
      if (node.name) return get(scope, node.name);
      if (node.member) {
        const obj = yield* value(node.object, scope);
        const member = property(obj, node.member);
        if (!asCallee && obj.virtual && Object.hasOwn(obj.methods, node.member)) return member();
        return member;
      }
      if (node.callee) {
        const called = node.callee.name === scope.name && program.procedures.has(scope.name)
          ? program.procedures.get(scope.name) : yield* value(node.callee, scope, true);
        const args = [];
        for (const arg of node.args) args.push(yield* value(arg, scope));
        if (Array.isArray(called)) return called[arrayIndex(called, args)];
        if (typeof called === "function") return called(...args);
        if (called?.params) return yield* invoke(scope, called, args, node.args);
        throw new Error(`Unknown function or array: ${node.callee.name ?? node.callee.member ?? "expression"}`);
      }
      if (node.left) {
        const left = yield* value(node.left, scope);
        return operate(node.op, left, yield* value(node.right, scope));
      }
      const right = yield* value(node.right, scope);
      if (right === null) return null;
      if (node.op === "not") return typeof right === "boolean" ? !right : ~num(right);
      return node.op === "-" ? -num(right) : num(right);
    } finally { expressionDepth--; }
  }
  function* put(target, next, scope) {
    if (target.name) { assign(scope, target.name, next); return; }
    if (!target.callee) throw new Error("Unsupported assignment target");
    const called = yield* value(target.callee, scope, true);
    const args = [];
    for (const arg of target.args) args.push(yield* value(arg, scope));
    if (called === smartTags && args.length === 1) writeTag(args[0], next);
    else if (Array.isArray(called)) called[arrayIndex(called, args)] = next;
    else throw new Error("Unsupported assignment target");
  }
  function* checkpoint(at) {
    if (++steps > 100_000) throw new VbsError("Execution limit reached (100,000 steps)", at);
    line = at;
    yield { line: at };
  }
  function* condition(test, scope) {
    if (!test) return true;
    const result = truth(yield* value(test.value, scope));
    return test.until ? !result : result;
  }
  function* execute(body, scope) {
    for (const stmt of body) {
      yield* checkpoint(stmt.line);
      try {
        switch (stmt.kind) {
          case "assign": yield* put(stmt.target, yield* value(stmt.value, scope), scope); break;
          case "call": yield* value(stmt.call, scope); break;
          case "exit": throw new Exit(stmt.target);
          case "onerror": scope.resume = stmt.enabled; clearError(); break;
          case "dim":
          case "const":
          case "redim":
            for (const item of stmt.declarations) {
              let next;
              if (item.initial) next = yield* value(item.initial, scope);
              else if (item.bounds) {
                const size = item.bounds.length ? indexOf(yield* value(item.bounds[0], scope)) + 1 : 0;
                next = new Array(size).fill(undefined);
                if (stmt.preserve) {
                  const previous = binding(scope, item.name)?.get();
                  if (Array.isArray(previous)) {
                    for (let i = 0; i < Math.min(size, previous.length); i++) next[i] = previous[i];
                  }
                }
              }
              if (stmt.kind === "redim" && binding(scope, item.name)) assign(scope, item.name, next);
              else if (stmt.kind === "dim" && scope.vars.has(item.name)) continue;
              else declare(scope, item.name, next, stmt.kind === "const");
            }
            break;
          case "if": {
            let selected = stmt.fallback;
            for (const branch of stmt.branches) {
              if (branch.line !== stmt.line) yield* checkpoint(branch.line);
              if (truth(yield* value(branch.condition, scope))) { selected = branch.body; break; }
            }
            yield* execute(selected, scope);
            break;
          }
          case "select": {
            const selected = yield* value(stmt.value, scope);
            let statements = stmt.fallback;
            find: for (const branch of stmt.cases) {
              yield* checkpoint(branch.line);
              for (const candidate of branch.values) {
                if (operate("=", selected, yield* value(candidate, scope)) === true) {
                  statements = branch.body;
                  break find;
                }
              }
            }
            yield* execute(statements, scope);
            break;
          }
          case "for": {
            try {
              if (stmt.values) {
                const items = yield* value(stmt.values, scope);
                if (!Array.isArray(items)) throw new Error("For Each expects an array");
                for (const item of items) {
                  assign(scope, stmt.name, item);
                  yield* execute(stmt.body, scope);
                  yield* checkpoint(stmt.line);
                }
              } else {
                const start = num(yield* value(stmt.start, scope));
                const end = num(yield* value(stmt.end, scope));
                const step = num(yield* value(stmt.step, scope));
                if (!step) throw new Error("For Step must be nonzero in the simulator");
                assign(scope, stmt.name, start);
                let index = start;
                while (step > 0 ? index <= end : index >= end) {
                  yield* execute(stmt.body, scope);
                  index = num(get(scope, stmt.name)) + step;
                  assign(scope, stmt.name, index);
                  yield* checkpoint(stmt.line);
                }
              }
            } catch (error) {
              if (!(error instanceof Exit) || error.target !== "for") throw error;
            }
            break;
          }
          case "do":
            try {
              while (yield* condition(stmt.pre, scope)) {
                yield* execute(stmt.body, scope);
                if (stmt.post && !(yield* condition(stmt.post, scope))) break;
                yield* checkpoint(stmt.line);
              }
            } catch (error) {
              if (!(error instanceof Exit) || error.target !== "do") throw error;
            }
            break;
        }
      } catch (error) {
        if (error instanceof Exit) throw error;
        if (error instanceof VbsError && error.message.startsWith("Execution limit")) throw error;
        if (!scope.resume) throw error instanceof VbsError ? error : new VbsError(error.message, line);
        err.number = 1;
        err.description = error.message;
      }
    }
  }

  function* run() {
    try {
      yield* execute(program.body, globals);
      if (entry.trim()) {
        const proc = program.procedures.get(key(entry.trim()));
        if (!proc) throw new VbsError(`Unknown entry procedure: ${entry}`, 1);
        const result = yield* invoke(globals, proc, []);
        if (proc.kind === "function") output("Return", result);
      }
    } catch (error) {
      if (error instanceof Exit) throw new VbsError(`Exit ${error.target} outside matching block`, line);
      throw error;
    }
  }

  return {
    iterator: run(),
    inspect: () => ({
      scope: current.name,
      variables: [...new Map([...globals.vars, ...current.vars])].map(([name, cell]) => [name, cell.get()]),
    }),
  };
}
