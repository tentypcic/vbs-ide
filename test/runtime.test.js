import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "../src/parser.js";
import { createRuntime } from "../src/runtime.js";
import { fileKey } from "../src/files.js";

function execute(source, options = {}) {
  const output = [];
  const runtime = createRuntime(source, { ...options, log: (kind, value) => output.push([kind, value]) });
  const steps = [...runtime.iterator];
  return { values: new Map(runtime.inspect().variables), output, steps };
}

test("WinCC example reads CSV, updates tags, creates a downloadable text report", () => {
  const source = readFileSync(new URL("../examples/ImportRecipe.vbs", import.meta.url), "utf8");
  const path = "C:\\Import\\recipe.csv";
  const tags = new Map([["RecipePath", path], ["RecipeRows", 0], ["RecipeTotal", 0]]);
  const files = new Map([[fileKey(path), { path, text: "Part;Quantity\r\nBeam;12\nMagnet;8\rPin;20" }]]);
  const result = execute(source, { entry: "ImportRecipe", tags, files });
  assert.equal(tags.get("RecipeRows"), 3);
  assert.equal(tags.get("RecipeTotal"), 40);
  assert.deepEqual(result.output, [["Alarm", "Recipe imported: 3 rows"]]);
  assert.equal(files.get(fileKey("C:/import/SUMMARY.txt")).text, "Records: 3\r\nTotal: 40\r\n");
});

test("virtual file append, overwrite, existence and read modes", () => {
  const files = new Map();
  const { values } = execute(String.raw`Set fso = CreateObject("Scripting.FileSystemObject")
Set stream = fso.CreateTextFile("C:\\out.txt")
stream.WriteLine "one"
stream.Close
Set stream = fso.OpenTextFile("c:/OUT.txt", 8)
stream.Write "two"
stream.Close
exists = fso.FileExists("c:\\out.txt")
Set stream = fso.OpenTextFile("C:\\out.txt")
first = stream.ReadLine
rest = stream.ReadAll()
eof = stream.AtEndOfStream
stream.Close`, {files});
  assert.equal(values.get("exists"), true);
  assert.equal(values.get("first"), "one");
  assert.equal(values.get("rest"), "two");
  assert.equal(values.get("eof"), true);
  execute(String.raw`Set fso = CreateObject("Scripting.FileSystemObject")
Set stream = fso.OpenTextFile("C:\\out.txt", 2)
stream.Write "new"`, { files });
  assert.equal(files.get(fileKey("C:/out.txt")).text, "new");
});

test("CSV files can be enumerated in a virtual directory", () => {
  const paths = ["C:/Import/a.csv", "C:/Import/b.txt", "C:/Import/sub/c.csv"];
  const files = new Map(paths.map(path => [fileKey(path), { path, text: "" }]));
  const result = execute(String.raw`Set fso = CreateObject("Scripting.FileSystemObject")
Set folder = fso.GetFolder("c:\\import\\")
For Each file In folder.Files
    If LCase(fso.GetExtensionName(file.Name)) = "csv" Then ShowSystemAlarm file.Path
Next`, {files});
  assert.deepEqual(result.output, [["Alarm", "C:/Import/a.csv"]]);
});

test("debugger yields before executing a statement and reads live SmartTags", () => {
  const tags = new Map([["Value", 1]]);
  const runtime = createRuntime('Dim x\nx = SmartTags("value")\nSmartTags("Value") = x * 2', { tags });
  assert.equal(runtime.iterator.next().value.line, 1);
  assert.equal(runtime.iterator.next().value.line, 2);
  tags.set("Value", 7);
  assert.equal(runtime.iterator.next().value.line, 3);
  assert.equal(new Map(runtime.inspect().variables).get("x"), 7);
  assert.equal(runtime.iterator.next().done, true);
  assert.equal(tags.get("Value"), 14);
});

test("Select Case, For Step, Do Until and inline conditionals", () => {
  const {values} = execute(`sum = 0
For i = 5 To 1 Step -2
  Select Case i
    Case 1, 3
      sum = sum + i
    Case Else
      sum = sum + 10
  End Select
Next i
Do
  sum = sum - 1
Loop Until sum = 10
If sum = 10 Then a = "yes" : b = 1 Else b = 2`);
  assert.equal(values.get("sum"), 10);
  assert.equal(values.get("a"), "yes");
  assert.equal(values.get("b"), 1);
});

test("functions, ByRef, ByVal and case-insensitive names", () => {
  const {values} = execute(`Option Explicit
Dim N, result
n = 8
Call Update(N, N)
result = Twice(n)
Sub Update(ByRef arg, ByVal other)
  other = 3
  arg = arg + other
End Sub
Function Twice(ByVal arg)
  Twice = arg * 2
End Function`);
  assert.equal(values.get("n"), 11);
  assert.equal(values.get("result"), 22);
});

test("Err information is available after a missing virtual file", () => {
  const {values} = execute(`Set fso = CreateObject("Scripting.FileSystemObject")
On Error Resume Next
Set stream = fso.OpenTextFile("missing.txt")
code = Err.Number
details = Err.Description
Err.Clear
cleared = Err.Number
On Error GoTo 0`);
  assert.notEqual(values.get("code"), 0);
  assert.match(values.get("details"), /Virtual file not found/);
  assert.equal(values.get("cleared"), 0);
});

test("array indexing, ReDim Preserve and numeric conversions", () => {
  const {values} = execute(`Dim rows()
ReDim rows(1)
rows(0) = CInt(2.5)
ReDim Preserve rows(3)
rows(3) = CLng(3.5)
total = rows(0) + rows(3)
size = UBound(rows)`);
  assert.equal(values.get("total"), 6);
  assert.equal(values.get("size"), 3);
  assert.throws(() => execute("x = Array(1)\ny = x(1)"), /out of range/);
  assert.throws(() => execute("x = CInt(32768)"), /overflow/);
});

test("comments, escaped quotes, continuations and useful diagnostics", () => {
  const {values} = execute(`Option Explicit
Dim text
text = "x'""y" & _
  "z" ' ignored
Rem skipped`);
  assert.equal(values.get("text"), 'x\'"yz');
  assert.throws(() => parse("If True Then\nx = 1"), {line: 2, message: "Expected end"});
  assert.throws(() => execute("Option Explicit\nx = 1"), {line: 2, message: "Variable is not declared: x"});
  assert.throws(() => execute('Set shell = CreateObject("WScript.Shell")'), /Unsupported COM/);
});

test("an empty endless loop yields and stops at the runtime execution limit", () => {
  const {iterator} = createRuntime("Do\nLoop");
  for (let index = 0; index < 100_000; index++) assert.equal(iterator.next().done, false);
  assert.throws(() => iterator.next(), /Execution limit reached/);
});

test("a running loop can be cancelled without further mutations", () => {
  const tags = new Map([["Counter", 0]]);
  const {iterator} = createRuntime('Do\nSmartTags("Counter") = SmartTags("Counter") + 1\nLoop', {tags});
  iterator.next();
  iterator.next();
  iterator.next();
  iterator.return();
  assert.equal(tags.get("Counter"), 1);
  assert.equal(iterator.next().done, true);
});
