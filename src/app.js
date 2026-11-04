import { parse } from "./parser.js";
import { createRuntime, completions } from "./runtime.js";
import { fileKey, MAX_FILE } from "./files.js";

const $ = id => document.getElementById(id);
const editor = $("editor");
const STORAGE = "vbs-ide.workspace.1";
const SAMPLE_PATH = "C:\\Import\\recipe.csv";
const fetchText = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}`);
  return response.text();
};
const element = (tag, text = "", className = "") => {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
};
const button = (label, action, className = "") => {
  const node = element("button", label, className);
  node.type = "button";
  node.onclick = action;
  return node;
};
const sample = () => Promise.all([fetchText("./examples/ImportRecipe.vbs"), fetchText("./examples/recipe.csv")]);
const uid = () => crypto.randomUUID();
let workspace = { scripts: [], selected: "", tags: [], files: [], theme: "dark" };
try {
  const stored = JSON.parse(localStorage.getItem(STORAGE));
  if (stored?.scripts?.length && Array.isArray(stored.tags) && Array.isArray(stored.files)) workspace = stored;
} catch { /* A fresh workspace is usable when storage is unavailable. */ }
const tags = new Map(workspace.tags);
const files = new Map(workspace.files.map(file => [fileKey(file.path), file]));
let fileVersion = "";
let active = null;
let position = null;
let running = false;
let timer;
let resumeLine = null;
let diagnostic = null;
let suggestions = [];
let suggestionIndex = 0;
let tagInputs = new Map();
const script = () => workspace.scripts.find(item => item.id === workspace.selected);
const breakpoints = () => script()?.breakpoints ?? [];
const filename = path => path.split(/[/\\]/).at(-1);
const showValue = value => value?.virtual ? "<Object>" : value === undefined ? "Empty" :
  Array.isArray(value) ? `[${value.slice(0, 8).map(item => item?.virtual || Array.isArray(item) ? "…" : showValue(item)).join(", ")}${value.length > 8 ? ", …" : ""}]` :
  value === null ? "Null" : typeof value === "boolean" ? (value ? "True" : "False") : String(value).slice(0, 1000);
const tagText = value => typeof value === "string" ? JSON.stringify(value) : showValue(value);
const tagValue = raw => {
  const value = raw.trim();
  if (!value || /^empty$/i.test(value)) return undefined;
  if (/^null$/i.test(value)) return null;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value) && Number.isFinite(Number(value))) return Number(value);
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "string") throw new Error("Expected a quoted string");
    return parsed;
  }
  return raw;
};
function persist() {
  try {
    workspace.tags = [...tags].map(([name, value]) => value === undefined ? [name] : [name, value]);
    workspace.files = [...files.values()];
    localStorage.setItem(STORAGE, JSON.stringify(workspace));
    $("saved").textContent = "Saved in browser";
  } catch {
    $("saved").textContent = "Storage full or unavailable · export your files";
  }
}
function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function log(kind, text, line = null) {
  const entry = element("div", "", `log ${kind.toLowerCase()}`);
  entry.append(element("b", kind), element("span", line ? `Line ${line} · ${text}` : text));
  const output = $("output");
  output.append(entry);
  if (output.childElementCount > 300) output.firstElementChild.remove();
  output.scrollTop = output.scrollHeight;
}
function download(name, content, mime = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = element("a");
  link.download = name;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function modal(title, fields, action, submitLabel = "Save", extras = []) {
  const dialog = $("dialog");
  const body = $("dialog-body");
  const actions = $("dialog-actions");
  $("dialog-title").textContent = title;
  $("dialog-error").textContent = "";
  body.replaceChildren();
  actions.replaceChildren();
  const inputs = new Map();
  for (const field of fields) {
    if (field.note) { body.append(element("p", field.note)); continue; }
    const label = element("label", field.label);
    const input = element(field.multiline ? "textarea" : "input");
    input.spellcheck = false;
    input.value = field.value ?? "";
    input.required = field.required ?? false;
    label.append(input);
    body.append(label);
    inputs.set(field.label, input);
  }
  for (const [label, handler] of extras) {
    actions.append(button(label, () => {
      try { if (handler()) dialog.close(); }
      catch (error) { $("dialog-error").textContent = error.message; }
    }));
  }
  actions.append(button(action ? "Cancel" : "Close", () => dialog.close()));
  if (action) actions.append(element("button", submitLabel));
  $("dialog-form").onsubmit = event => {
    event.preventDefault();
    if (!action) { dialog.close(); return; }
    try {
      action(Object.fromEntries([...inputs].map(([name, input]) => [name, input.value])));
      dialog.close();
    } catch (error) { $("dialog-error").textContent = error.message; }
  };
  dialog.showModal();
}

const keyword = /^(?:option|explicit|dim|const|redim|preserve|if|then|elseif|else|end|for|each|in|to|step|next|do|while|until|loop|wend|select|case|function|sub|exit|on|error|resume|goto|set|true|false|empty|null|nothing|and|or|not|xor|eqv|imp|mod|is|byval|byref|call|let)$/i;
const api = /^(?:smarttags|showsystemalarm|hmiruntime|createobject|err|opentextfile|createtextfile|fileexists|atendofstream|readline|readall|writeline|write|close)$/i;
const colors = /"(?:""|[^"])*"|'[^\n]*|&H[0-9a-f]+|\b\d+(?:\.\d+)?\b|\b[a-z_]\w*\b/gi;
const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function highlightLine(text) {
  if (/^\s*rem(?:\s|$)/i.test(text)) return `<span class="comment">${escape(text)}</span>`;
  let at = 0;
  let result = "";
  for (const match of text.matchAll(colors)) {
    const token = match[0];
    const type = token.startsWith('"') ? "string" : token.startsWith("'") ? "comment" :
      /^(?:\d|&h)/i.test(token) ? "number" : keyword.test(token) ? "kw" : api.test(token) ? "api" : "";
    result += escape(text.slice(at, match.index));
    result += type ? `<span class="${type}">${escape(token)}</span>` : escape(token);
    at = match.index + token.length;
  }
  return result + escape(text.slice(at));
}
function scrollEditor() {
  $("highlight").scrollTop = $("gutter").scrollTop = editor.scrollTop;
  $("highlight").scrollLeft = editor.scrollLeft;
}
let cachedCode = null;
let cachedLines = [];
function redrawCode() {
  if (cachedCode !== editor.value) {
    cachedCode = editor.value;
    cachedLines = editor.value.split("\n").map(highlightLine);
  }
  const current = position?.line ?? diagnostic;
  const highlight = $("highlight");
  highlight.innerHTML = cachedLines.map((line, index) => current === index + 1
    ? `<span class="current">${line || " "}</span>` : line).join("\n") + "\n";
  const gutter = $("gutter");
  if (gutter.childElementCount !== cachedLines.length) {
    gutter.replaceChildren(...cachedLines.map((_, index) => {
      const number = index + 1;
      const control = button(number, () => {
        const marks = script().breakpoints;
        const at = marks.indexOf(number);
        if (at >= 0) marks.splice(at, 1);
        else marks.push(number);
        persist();
        redrawCode();
      });
      control.title = `Toggle breakpoint at line ${number}`;
      return control;
    }));
  }
  const marks = new Set(breakpoints());
  Array.from(gutter.children).forEach((control, index) => {
    const marked = marks.has(index + 1);
    control.classList.toggle("breakpoint", marked);
    control.classList.toggle("current", current === index + 1);
    control.setAttribute("aria-pressed", marked);
  });
  scrollEditor();
}
function showLine(line) {
  if (!line) return;
  const y = (line - 1) * 22;
  if (y < editor.scrollTop || y + 44 > editor.scrollTop + editor.clientHeight) editor.scrollTop = Math.max(0, y - editor.clientHeight / 3);
  scrollEditor();
}
function cursor() {
  const before = editor.value.slice(0, editor.selectionStart).split("\n");
  $("cursor").textContent = `Ln ${before.length}, Col ${before.at(-1).length + 1}`;
}
function renderScripts() {
  $("scripts").replaceChildren(...workspace.scripts.map(item => {
    const li = element("li");
    const control = button("", () => selectScript(item.id), item.id === workspace.selected ? "active" : "");
    control.append(element("span", "VB", "item-icon"), element("span", item.name));
    control.title = item.name;
    control.setAttribute("aria-current", item.id === workspace.selected ? "true" : "false");
    li.append(control);
    return li;
  }));
}
function selectScript(id) {
  stop(false);
  diagnostic = null;
  workspace.selected = id;
  const item = script();
  $("script-name").textContent = item.name;
  editor.value = item.source;
  $("entry").value = item.entry;
  editor.scrollTop = editor.scrollLeft = 0;
  renderScripts();
  redrawCode();
  cursor();
  persist();
  status("Ready");
}
function newScript(name, source = "", entry = "") {
  const item = { id: uid(), name, source: source.replace(/\r\n?/g, "\n"), entry, breakpoints: [] };
  workspace.scripts.push(item);
  selectScript(item.id);
}
function scriptName(raw) {
  const name = raw.trim();
  if (!name || /[/\\]/.test(name)) throw new Error("Enter a file name without path separators.");
  return /\.vbs$/i.test(name) ? name : name + ".vbs";
}
function fileDialog(file = null, content = "") {
  const originalKey = file ? fileKey(file.path) : null;
  modal(file ? "Virtual text file" : "Add virtual text file", [
    {label: "Windows path", value: file?.path ?? "C:\\Import\\", required: true},
    {label: "Text content", value: file?.text ?? content, multiline: true},
  ], values => {
    const path = values["Windows path"].trim();
    const key = fileKey(path);
    const text = values["Text content"];
    if (!filename(path)) throw new Error("Include a file name in the Windows path.");
    if (text.length > MAX_FILE) throw new Error("File exceeds 2 million characters.");
    if (key !== originalKey && files.has(key)) throw new Error("This path already exists. Open the existing file to edit it.");
    if (originalKey && originalKey !== key) files.delete(originalKey);
    // Preserve the original encoding of line endings when only the path changed.
    const original = file?.text;
    files.set(key, { path, text: original?.replace(/\r\n?/g, "\n") === text ? original : text });
    renderFiles();
    persist();
  }, "Save file", file ? [
    ["Download", () => { download(filename(file.path), file.text); return false; }],
    ["Remove", () => { files.delete(originalKey); renderFiles(); persist(); return true; }],
  ] : []);
}
function renderFiles() {
  fileVersion = JSON.stringify([...files.values()].map(file => [file.path, file.text.length]));
  $("files").replaceChildren(...[...files.values()].map(file => {
    const li = element("li");
    const control = button("", () => fileDialog(files.get(fileKey(file.path))));
    control.title = file.path;
    control.append(element("span", "TXT", "item-icon"), element("span", filename(file.path)));
    li.append(control);
    return li;
  }));
}
function renderTags() {
  tagInputs = new Map();
  $("tags").replaceChildren(...[...tags].map(([name, value], index) => {
    const wrap = element("div", "", "tag");
    const label = element("label", name);
    const input = element("input");
    input.id = `tag-${index}`;
    input.spellcheck = false;
    label.htmlFor = input.id;
    input.value = tagText(value);
    input.title = 'Enter a number, True, False, Empty, Null or text. Quote text to preserve its type.';
    input.onchange = () => {
      try {
        tags.set(name, tagValue(input.value));
        input.value = tagText(tags.get(name));
        persist();
      } catch (error) { status(error.message, true); input.value = tagText(tags.get(name)); }
    };
    input.onkeydown = event => { if (event.key === "Enter") input.blur(); };
    const remove = button("×", () => { tags.delete(name); renderTags(); persist(); });
    remove.setAttribute("aria-label", `Remove SmartTag ${name}`);
    wrap.append(label, remove, input);
    tagInputs.set(name, input);
    return wrap;
  }));
}
function refreshRuntime() {
  for (const [name, input] of tagInputs) {
    const next = tagText(tags.get(name));
    if (input !== document.activeElement && input.value !== next) input.value = next;
  }
  if (fileVersion !== JSON.stringify([...files.values()].map(file => [file.path, file.text.length]))) renderFiles();
  const snapshot = active?.inspect();
  $("scope").textContent = snapshot?.scope ?? "—";
  $("variables").replaceChildren(...(snapshot?.variables ?? []).slice(0, 100).flatMap(([name, value]) =>
    [element("dt", name), element("dd", showValue(value))]));
}
function controls() {
  $("run").textContent = running ? "Ⅱ Pause" : "▶ Run";
  $("step").disabled = running;
  $("stop").disabled = !active;
  editor.readOnly = $("entry").readOnly = Boolean(active);
}
function stop(report = true) {
  clearTimeout(timer);
  running = false;
  position = null;
  resumeLine = null;
  if (active) {
    refreshRuntime();
    active.iterator.return();
    active = null;
    persist();
    if (report) status("Stopped");
  }
  controls();
  redrawCode();
}
function fail(error) {
  stop(false);
  diagnostic = error.line ?? null;
  status(error.line ? `Error · line ${error.line}` : "Error", true);
  log("Error", error.message, error.line);
  redrawCode();
  showLine(diagnostic);
}
function begin() {
  diagnostic = null;
  active = createRuntime(editor.value, {
    tags, files, entry: $("entry").value,
    log: (kind, message) => log(kind, message, position?.line),
  });
  log("Run", script().name);
  advance();
}
function advance() {
  const next = active.iterator.next();
  if (next.done) {
    stop(false);
    status("Completed");
    log("Done", "Script finished");
  } else position = next.value;
}
function paused(message) {
  clearTimeout(timer);
  running = false;
  controls();
  refreshRuntime();
  redrawCode();
  showLine(position?.line);
  persist();
  status(message);
}
function pump() {
  if (!running || !active) return;
  try {
    const budget = performance.now() + 8;
    for (let count = 0; active && count < 240 && performance.now() < budget; count++) {
      if (breakpoints().includes(position.line) && resumeLine !== position.line) {
        resumeLine = position.line;
        paused(`Breakpoint · line ${position.line}`);
        return;
      }
      resumeLine = null;
      advance();
    }
    if (active) {
      refreshRuntime();
      redrawCode();
      timer = setTimeout(pump, 12);
    }
  } catch (error) { fail(error); }
}
function run() {
  if (running) { paused(`Paused · line ${position.line}`); return; }
  try {
    if (!active) begin();
    if (!active) return;
    running = true;
    controls();
    status("Running");
    pump();
  } catch (error) { fail(error); }
}
function step() {
  if (running) return;
  try {
    if (!active) begin();
    else { resumeLine = null; advance(); }
    if (active) paused(`Next instruction · line ${position.line}`);
  } catch (error) { fail(error); }
}
function check() {
  try {
    const compiled = parse(editor.value);
    const entry = $("entry").value.trim().toLowerCase();
    if (entry && !compiled.procedures.has(entry)) throw new Error(`Entry procedure ${entry} was not found.`);
    if (entry && compiled.procedures.get(entry).params.length) throw new Error("The selected entry must have no parameters.");
    diagnostic = null;
    redrawCode();
    status("Syntax check passed");
    log("Check", "Syntax check passed");
  } catch (error) {
    if (active) log("Error", error.message, error.line);
    else fail(error);
  }
}
function edit() {
  script().source = editor.value;
  diagnostic = null;
  redrawCode();
  cursor();
  persist();
  status("Ready");
}
function replace(text, start = editor.selectionStart, end = editor.selectionEnd) {
  if (editor.readOnly) return;
  editor.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, text)) {
    editor.setRangeText(text, start, end, "end");
    edit();
  }
}
function format() {
  if (active) return;
  try { parse(editor.value); } catch (error) { fail(error); return; }
  let depth = 0;
  const formatted = editor.value.split("\n").map(raw => {
    const line = raw.trim();
    const code = line.replace(/"(?:""|[^"])*"|'[^\n]*/g, token => token.startsWith("'") ? "" : '""').trim();
    const branch = /^(else(?:if)?|case)\b/i.test(code);
    const close = /^(end\s+(?:if|select|sub|function)|next|loop|wend)\b/i.test(code);
    if (close || branch) depth = Math.max(0, depth - 1);
    if (/^end\s+select\b/i.test(code)) depth = Math.max(0, depth - 1);
    const result = line ? "    ".repeat(depth) + line : "";
    if (branch || /^(if\b.*\bthen$|for\b|do\b|while\b|select\s+case\b|sub\b|function\b)/i.test(code)) depth++;
    if (/^select\s+case\b/i.test(code)) depth++;
    return result;
  }).join("\n");
  const offset = editor.selectionStart;
  editor.focus();
  replace(formatted, 0, editor.value.length);
  editor.setSelectionRange(offset, offset);
  cursor();
}
function closeSuggestions() { $("suggest").hidden = true; suggestions = []; }
function completionToken() { return /[a-z_]\w*$/i.exec(editor.value.slice(0, editor.selectionStart))?.[0] ?? ""; }
function suggest(force = false) {
  if (editor.readOnly) return;
  const token = completionToken().toLowerCase();
  if (!force && !token) { closeSuggestions(); return; }
  const prefix = editor.value.slice(0, editor.selectionStart).split("\n").at(-1);
  if (/(?:^\s*rem\b|')/i.test(prefix.replace(/"(?:""|[^"])*"/g, "")) || (prefix.match(/"/g)?.length ?? 0) % 2) {
    closeSuggestions();
    return;
  }
  const names = [...editor.value.matchAll(/\b(?:Sub|Function)\s+([a-z_]\w*)/gi)].map(match => match[1]);
  suggestions = [...new Set([...completions, ...names])].filter(item => item.toLowerCase().startsWith(token) && item.toLowerCase() !== token).slice(0, 7);
  suggestionIndex = 0;
  renderSuggestions();
}
function renderSuggestions() {
  $("suggest").hidden = !suggestions.length;
  $("suggest").replaceChildren(...suggestions.map((item, index) => {
    const li = element("li");
    const control = button(item, () => acceptSuggestion(item), index === suggestionIndex ? "selected" : "");
    control.onmousedown = event => event.preventDefault();
    li.append(control);
    return li;
  }));
}
function acceptSuggestion(item) {
  const start = editor.selectionStart - completionToken().length;
  editor.focus();
  replace(item, start);
  closeSuggestions();
}
async function loadExample() {
  try {
    const [source, csv] = await sample();
    stop(false);
    if (!files.has(fileKey(SAMPLE_PATH))) files.set(fileKey(SAMPLE_PATH), { path: SAMPLE_PATH, text: csv });
    for (const [name, value] of [["RecipePath", SAMPLE_PATH], ["RecipeRows", 0], ["RecipeTotal", 0]]) {
      if (![...tags.keys()].some(key => key.toLowerCase() === name.toLowerCase())) tags.set(name, value);
    }
    const existing = workspace.scripts.find(item => item.source === source && item.entry === "ImportRecipe");
    if (existing) selectScript(existing.id);
    else newScript("ImportRecipe.vbs", source, "ImportRecipe");
    renderTags();
    renderFiles();
    persist();
  } catch (error) { status(error.message, true); log("Error", error.message); }
}
$("new-script").onclick = () => modal("New script", [{label: "Name", value: "Untitled.vbs", required: true}],
  values => newScript(scriptName(values.Name), "Option Explicit\n"), "Create");
$("rename-script").onclick = () => modal("Script settings", [{label: "Name", value: script().name, required: true}], values => {
  script().name = scriptName(values.Name); $("script-name").textContent = script().name; renderScripts(); persist();
}, "Rename", workspace.scripts.length > 1 ? [["Remove script", () => {
  const id = workspace.selected;
  stop(false);
  workspace.scripts = workspace.scripts.filter(item => item.id !== id);
  selectScript(workspace.scripts[0].id);
  return true;
}]] : []);
$("new-file").onclick = () => fileDialog();
$("new-tag").onclick = () => modal("Add SmartTag", [{label: "Tag name", required: true}, {label: "Value", value: "0"}], values => {
  const name = values["Tag name"].trim();
  if (!name) throw new Error("Enter a tag name.");
  if ([...tags.keys()].some(key => key.toLowerCase() === name.toLowerCase())) throw new Error("Tag already exists.");
  tags.set(name, tagValue(values.Value));
  renderTags();
  persist();
}, "Add tag");
$("load-sample").onclick = loadExample;
$("import-script").onclick = () => $("script-picker").click();
$("import-file").onclick = () => $("file-picker").click();
$("script-picker").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 400_004) throw new Error("Script exceeds the source size limit.");
    const source = await readText(file);
    if (source.length > 200_000) throw new Error("Script exceeds 200,000 characters.");
    newScript(scriptName(file.name), source);
  } catch (error) { status(error.message, true); log("Error", error.message); }
};
async function readText(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const encoding = data[0] === 255 && data[1] === 254 ? "utf-16le" : data[0] === 254 && data[1] === 255 ? "utf-16be" : "utf-8";
  const text = new TextDecoder(encoding, {fatal: true}).decode(data);
  if (text.includes("\0")) throw new Error("Upload a text file encoded as UTF-8 or UTF-16 with BOM.");
  return text;
}
$("file-picker").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 4_000_004) throw new Error("File exceeds the simulator size limit.");
    const text = await readText(file);
    if (text.length > MAX_FILE) throw new Error("File exceeds 2 million characters.");
    modal("Map uploaded file", [{label: "Windows path", value: "C:\\Import\\" + file.name, required: true}], values => {
      const path = values["Windows path"].trim();
      const key = fileKey(path);
      if (!filename(path)) throw new Error("Include a file name in the Windows path.");
      if (files.has(key)) throw new Error("This path already exists. Choose a different path or remove the existing file.");
      files.set(key, { path, text });
      renderFiles();
      persist();
    }, "Add file");
  } catch (error) { status(error.message, true); log("Error", error.message); }
};
$("download-script").onclick = () => download(script().name, editor.value);
$("dialog-close").onclick = () => $("dialog").close();
$("run").onclick = run;
$("step").onclick = step;
$("stop").onclick = () => stop();
$("check").onclick = check;
$("format").onclick = format;
$("clear").onclick = () => $("output").replaceChildren();
$("entry").oninput = () => { script().entry = $("entry").value; persist(); };
$("theme").onclick = () => {
  workspace.theme = workspace.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = workspace.theme;
  persist();
};
$("help").onclick = () => modal("VBS IDE guide", [
  { note: "Use Run (F5), Step (F10) or click a line number for a breakpoint. Shift+F5 stops execution. Ctrl+Enter checks syntax. Ctrl+Space opens suggestions." },
  { note: "For a TIA script with a parameterless Sub, set Entry to its name. Scripts with top-level statements can leave Entry empty." },
  { note: "Add or edit SmartTags in the inspector. The sample maps C:\\Import\\recipe.csv and writes summary.txt to Virtual Files. To use your own CSV, upload it, choose its virtual path and set RecipePath to that path." },
  { note: "Virtual files are text only. UTF-8 and BOM-marked UTF-16 uploads are supported. Changes stay in this browser until you download them. Native COM, real PLC communication and the full WinCC object model are outside the simulator." },
]);
editor.oninput = () => { edit(); suggest(); };
editor.onscroll = scrollEditor;
editor.onselect = cursor;
editor.onkeyup = cursor;
editor.onclick = () => { cursor(); closeSuggestions(); };
editor.onblur = closeSuggestions;
editor.onkeydown = event => {
  if (event.ctrlKey && event.code === "Space") { event.preventDefault(); suggest(true); return; }
  if (suggestions.length && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
    event.preventDefault();
    if (event.key === "Escape") closeSuggestions();
    else if (event.key === "Enter") acceptSuggestion(suggestions[suggestionIndex]);
    else {
      suggestionIndex = (suggestionIndex + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
      renderSuggestions();
    }
  } else if (event.key === "Tab" && !event.shiftKey && !editor.readOnly) {
    event.preventDefault();
    replace("    ");
    closeSuggestions();
  } else if (event.key === "Enter" && !editor.readOnly) {
    event.preventDefault();
    const line = editor.value.slice(0, editor.selectionStart).split("\n").at(-1);
    const opens = /^(?:if\b.*\bthen\s*$|for\b|do\b|while\b|sub\b|function\b|select\s+case\b|else\b|elseif\b|case\b)/i.test(line.trim());
    replace("\n" + (/^\s*/.exec(line)[0]) + (opens ? "    " : ""));
    closeSuggestions();
  }
};
document.addEventListener("keydown", event => {
  if ($("dialog").open || event.defaultPrevented) return;
  let action;
  if (event.key === "F5") action = event.shiftKey ? () => stop() : run;
  if (event.key === "F10") action = step;
  if (event.ctrlKey && event.key === "Enter") action = check;
  if (event.shiftKey && event.altKey && event.code === "KeyF") action = format;
  if (action) { event.preventDefault(); action(); }
});

document.documentElement.dataset.theme = workspace.theme;
if (!workspace.scripts.length) {
  await loadExample();
  if (!workspace.scripts.length) newScript("Untitled.vbs", "Option Explicit\n");
} else selectScript(script()?.id ?? workspace.scripts[0].id);
renderFiles();
renderTags();
log("Ready", "Run the example or open a WinCC .vbs script.");
