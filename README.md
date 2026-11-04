# VBS IDE

<p align="center">Built with <strong>HTML, CSS and JavaScript</strong>.<br><a href="https://tentypcic.github.io/vbs-ide/">Open the app</a> · <a href="https://github.com/tentypcic/vbs-ide/issues">Report Bug</a></p>

## 🧠 About The Project

**VBS IDE** is a browser workspace for writing and debugging the VBScript used in Siemens TIA Portal HMI scripts. It is a companion to [SCL IDE](https://github.com/tentypcic/scl-ide) focused on WinCC Runtime Advanced and Comfort Panel workflows.

## 🛠 Features

- Multiple local scripts, VBScript highlighting, completions, formatting, syntax checks and .vbs import/export.
- Run, pause, stop, step into, line breakpoints and inspection of script and procedure variables.
- Editable simulated SmartTags and a console for `ShowSystemAlarm`, messages and trace output.
- Upload, create, edit and download virtual text files using the Windows paths expected by a script.
- Light and dark themes and an included example that reads a recipe CSV, updates tags and creates a summary file.

## 📂 Testing a CSV script

1. Open the example and click **Run**. The included `C:\Import\recipe.csv` has three rows. The example sets `RecipeRows` to 3 and `RecipeTotal` to 40.
2. To test another file, use **Upload file** and choose its virtual Windows path. Update `RecipePath` to that path.
3. Open `summary.txt` in **Virtual Files** and click **Download**. Output downloads use UTF-8.
4. Set a breakpoint by clicking a line number, or press **F10** to step. Use **Entry** for the name of a parameterless `Sub` or `Function`.

The virtual file system supports `CreateObject("Scripting.FileSystemObject")`, `FileExists`, `FolderExists`, `GetFolder(...).Files`, `BuildPath`, `GetFileName`, `GetExtensionName`, `OpenTextFile` (read, write or append), `CreateTextFile` and basic text stream methods. Paths are case-insensitive. Folders are inferred from file paths. Uploads accept UTF-8 or BOM-marked UTF-16. File stream encoding arguments are accepted, with text held internally as Unicode.

## 🚀 Getting Started

No build step or package installation. Use Node.js 22+ for tests and a static HTTP server for the app.

```sh
npm test
python3 -m http.server 8080
```

Open `http://localhost:8080`. Scripts and virtual files are stored in this browser. Export copies of work you want to keep.

## 🧪 Scope

The interpreter covers a subset of VBScript including `Option Explicit`, `Dim`, `Const`, one-dimensional arrays, procedures, `If`, `Select Case` with literal or expression matches, loops and common string and number functions. `On Error Resume Next` is simulated with generic errors. Variant coercion, error codes, locale behavior and argument binding are simplified. Syntax checking reports the first parse error. `MsgBox` logs to the console and returns OK.

The browser runs a local simulation with its own files and tags. Full WinCC integration, physical Windows paths, arbitrary COM and PLC connectivity are outside this version. Test production scripts in the target Runtime. `HMIRuntime.Trace` is accepted as a simulator console helper. For Runtime Advanced and panels Siemens documents `ShowSystemAlarm` for tracing.

[Siemens WinCC VBS reference](https://docs.tia.siemens.cloud/r/en-us/v20/vbs-object-model-panels-comfort-panels-rt-advanced-rt-professional/objects-panels-comfort-panels-rt-advanced/hmiruntime-panels-comfort-panels-rt-advanced) · [Trace and ShowSystemAlarm](https://docs.tia.siemens.cloud/r/en-us/v21/vbs-object-model-panels-comfort-panels-rt-advanced-rt-professional/methods-panels-comfort-panels-rt-advanced-rt-professional/methods-s-z-panels-comfort-panels-rt-advanced-rt-professional/trace-panels-comfort-panels-rt-advanced-rt-professional)

## 🧑‍💻 Author

Created by [tentypcic](https://github.com/tentypcic).
