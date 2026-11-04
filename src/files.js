export const MAX_FILE = 2_000_000;

export function fileKey(path) {
  const normalized = String(path).trim().replaceAll("/", "\\").replace(/\\+/g, "\\");
  if (!normalized || normalized.includes("\0")) throw new Error("Invalid virtual path");
  return normalized.toLowerCase();
}

export function virtualObject(properties = {}, methods = {}) {
  return { virtual: true, properties, methods };
}

export function fileSystem(files) {
  function open(path, mode = 1, create = false, format = 0) {
    path = String(path);
    const key = fileKey(path);
    mode = Number(mode);
    if (![1, 2, 8].includes(mode)) throw new Error("OpenTextFile mode must be 1, 2 or 8");
    if (![0, -1, -2].includes(Number(format))) throw new Error("Invalid text file format");
    let file = files.get(key);
    if (!file && !create) throw new Error(`Virtual file not found: ${path}`);
    if (!file || mode === 2) {
      file = { path: file?.path ?? path, text: "" };
      files.set(key, file);
    }
    let cursor = 0;
    let closed = false;
    const requireMode = reading => {
      if (closed) throw new Error("Text stream is closed");
      if ((mode === 1) !== reading) throw new Error("Incorrect text stream access mode");
    };
    const write = text => {
      requireMode(false);
      if (file.text.length + text.length > MAX_FILE) throw new Error("Virtual file exceeds the text limit");
      file.text += text;
    };
    return virtualObject({
      atendofstream: () => { requireMode(true); return cursor >= file.text.length; },
    }, {
      readline: () => {
        requireMode(true);
        if (cursor >= file.text.length) throw new Error("Read past end of file");
        const rest = file.text.slice(cursor);
        const separator = /\r\n|\r|\n/.exec(rest);
        const end = separator?.index ?? rest.length;
        cursor += end + (separator?.[0].length ?? 0);
        return rest.slice(0, end);
      },
      readall: () => {
        requireMode(true);
        const text = file.text.slice(cursor);
        cursor = file.text.length;
        return text;
      },
      write: value => write(String(value ?? "")),
      writeline: (value = "") => write(String(value ?? "") + "\r\n"),
      close: () => { closed = true; },
    });
  }
  const name = path => String(path).replaceAll("/", "\\").split("\\").at(-1);
  const folder = path => {
    const prefix = fileKey(path).replace(/\\$/, "") + "\\";
    const children = [...files].filter(([key]) => key.startsWith(prefix));
    const direct = children.filter(([key]) => !key.slice(prefix.length).includes("\\"));
    return { exists: children.length > 0, direct };
  };
  return virtualObject({}, {
    buildpath: (path, child) => String(path).replace(/[\\/]+$/, "") + "\\" + String(child),
    getfilename: name,
    getextensionname: path => {
      const file = name(path);
      const dot = file.lastIndexOf(".");
      return dot < 0 ? "" : file.slice(dot + 1);
    },
    folderexists: path => folder(path).exists,
    getfolder: path => {
      const listing = folder(path);
      if (!listing.exists) throw new Error(`Virtual folder not found: ${path}`);
      return virtualObject({ files: () => listing.direct.map(([, file]) => virtualObject({
        path: () => file.path,
        name: () => name(file.path),
      })) });
    },
    fileexists: path => files.has(fileKey(path)),
    opentextfile: open,
    createtextfile: (path, overwrite = true, unicode = false) => {
      if (!overwrite && files.has(fileKey(path))) throw new Error(`Virtual file exists: ${path}`);
      return open(path, 2, true, unicode ? -1 : 0);
    },
  });
}
