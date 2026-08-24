export function supportsFsAccess() {
  return typeof window.showOpenFilePicker === "function";
}

export function supportsDirPicker() {
  return typeof window.showDirectoryPicker === "function";
}

export function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function isPngFile(file) {
  if (!file) return false;
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".png")) return true;
  return file.type === "image/png";
}

export function isValidSkinSize(width, height) {
  if (!width || !height) return false;
  if (width < 64 || width % 64 !== 0) return false;
  return height === width || height * 2 === width;
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `skin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function measureImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, previewUrl: url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function inspectSkinFile(entry) {
  const file = entry.file;
  const name = file.name || "unnamed.png";
  const relativePath = entry.relativePath || file.webkitRelativePath || name;

  if (!isPngFile(file)) {
    return {
      ok: false,
      name,
      relativePath,
      reason: "Не PNG",
    };
  }

  try {
    const { width, height, previewUrl } = await measureImage(file);
    if (!isValidSkinSize(width, height)) {
      URL.revokeObjectURL(previewUrl);
      return {
        ok: false,
        name,
        relativePath,
        reason: `Неверный размер ${width}×${height}`,
      };
    }

    return {
      ok: true,
      skin: {
        id: makeId(),
        name,
        relativePath,
        file,
        url: previewUrl,
        width,
        height,
        fileHandle: entry.fileHandle || null,
        dirHandle: entry.dirHandle || null,
        model: "wide",
        ratings: { red: null, blue: null, logoFront: null, logoBack: null, lenses: null },
        thumb: null,
        skipped: false,
      },
    };
  } catch {
    return {
      ok: false,
      name,
      relativePath,
      reason: "Повреждённое изображение",
    };
  }
}

async function walkDirectoryHandle(dirHandle, out, prefix = "", rootDir = dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file") {
      const file = await handle.getFile();
      out.push({
        file,
        fileHandle: handle,
        dirHandle: rootDir,
        relativePath: prefix + name,
      });
    } else if (handle.kind === "directory") {
      await walkDirectoryHandle(handle, out, `${prefix}${name}/`, rootDir);
    }
  }
}

function readEntries(reader) {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

function entryToFile(fileEntry) {
  return new Promise((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });
}

async function walkDirEntry(dirEntry, out, prefix = "") {
  const reader = dirEntry.createReader();
  let batch = await readEntries(reader);
  while (batch.length) {
    for (const child of batch) {
      if (child.isFile) {
        const file = await entryToFile(child);
        out.push({
          file,
          relativePath: prefix + child.name,
        });
      } else if (child.isDirectory) {
        await walkDirEntry(child, out, `${prefix}${child.name}/`);
      }
    }
    batch = await readEntries(reader);
  }
}

export async function collectFromDataTransfer(dataTransfer) {
  const collected = [];
  const items = dataTransfer.items ? [...dataTransfer.items] : [];

  if (items.length && (items[0].getAsFileSystemHandle || items[0].webkitGetAsEntry)) {
    await Promise.all(
      items.map(async (item) => {
        if (item.kind !== "file") return;

        if (typeof item.getAsFileSystemHandle === "function") {
          try {
            const handle = await item.getAsFileSystemHandle();
            if (!handle) return;
            if (handle.kind === "file") {
              const file = await handle.getFile();
              collected.push({ file, fileHandle: handle, relativePath: file.name });
              return;
            }
            if (handle.kind === "directory") {
              await walkDirectoryHandle(handle, collected);
              return;
            }
          } catch {
            // fall through to webkit entry
          }
        }

        if (typeof item.webkitGetAsEntry === "function") {
          const entry = item.webkitGetAsEntry();
          if (!entry) return;
          if (entry.isFile) {
            const file = await entryToFile(entry);
            collected.push({ file, relativePath: file.name });
          } else if (entry.isDirectory) {
            await walkDirEntry(entry, collected, `${entry.name}/`);
          }
          return;
        }

        const file = item.getAsFile();
        if (file) collected.push({ file, relativePath: file.name });
      }),
    );
    return collected;
  }

  return [...dataTransfer.files].map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

export async function pickFilesWithFs() {
  const handles = await window.showOpenFilePicker({
    multiple: true,
    types: [
      {
        description: "Minecraft skins",
        accept: { "image/png": [".png"] },
      },
    ],
    excludeAcceptAllOption: false,
  });

  const collected = [];
  for (const handle of handles) {
    const file = await handle.getFile();
    collected.push({ file, fileHandle: handle, relativePath: file.name });
  }
  return collected;
}

export async function pickFolderWithFs() {
  const dirHandle = await window.showDirectoryPicker({ mode: "read" });
  const collected = [];
  await walkDirectoryHandle(dirHandle, collected);
  return collected;
}

export function filesFromInput(fileList) {
  return [...fileList].map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

// Из браузера нельзя программно открыть системный проводник и выделить там файл —
// это ограничение веб-платформы. showDirectoryPicker — это диалог ВЫБОРА папки, а не
// «открыть в проводнике», поэтому он здесь больше не используется. Вместо этого
// возвращаем известный путь к файлу/папке, чтобы пользователь мог его скопировать.
export function revealSkin(skin) {
  const relativePath = skin?.relativePath || skin?.name || "";
  const sep = relativePath.lastIndexOf("/");
  const dirPath = sep >= 0 ? relativePath.slice(0, sep) : "";
  return {
    mode: "path",
    path: relativePath || skin?.name || "",
    // Папка: если есть вложенность — берём её, иначе показываем хотя бы имя файла.
    dirPath: dirPath || relativePath || "",
    name: skin?.name || "",
  };
}

export function revokeSkin(skin) {
  if (skin?.url) URL.revokeObjectURL(skin.url);
}
