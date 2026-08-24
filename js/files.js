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
    return { width: img.naturalWidth, height: img.naturalHeight, previewUrl: url, img };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

// skinview3d использует эти четыре области для собственного auto-detect. Проверяем
// не отдельный пиксель, а весь прямоугольник: так один случайный прозрачный пиксель
// не зависит от того, какая именно раскраска у руки. Координаты заданы для 64×64
// и масштабируются для HD-скинов тем же способом, что и в skinview3d.
const MODEL_REGIONS = [
  [50, 16, 2, 4],
  [54, 20, 2, 12],
  [42, 48, 2, 4],
  [46, 52, 2, 12],
];

function regionPixels(ctx, region, sx, sy) {
  const [x, y, width, height] = region;
  return ctx.getImageData(
    Math.floor(x * sx),
    Math.floor(y * sy),
    Math.floor(width * sx),
    Math.floor(height * sy),
  ).data;
}

function hasTransparency(ctx, region, sx, sy) {
  const pixels = regionPixels(ctx, region, sx, sy);
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 255) return true;
  }
  return false;
}

function isOpaqueColor(ctx, region, sx, sy, red, green, blue) {
  const pixels = regionPixels(ctx, region, sx, sy);
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] !== red || pixels[i + 1] !== green || pixels[i + 2] !== blue || pixels[i + 3] !== 255) {
      return false;
    }
  }
  return true;
}

/**
 * Determine the arm model from a decoded skin image.
 *
 * The legacy 64×32 layout has no reliable slim/wide marker, so it deliberately
 * stays wide. For square skins this mirrors skinview3d's calibrated
 * loadSkin(..., { model: "auto-detect" }) heuristic, including its solid
 * black/white fallback for templates whose marker column is filled instead of
 * transparent.
 */
export function detectSkinModel(img, width, height) {
  if (height * 2 === width) return "wide";
  if (!img || width !== height || width < 64 || width % 64 !== 0) return "wide";

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "wide";
  ctx.drawImage(img, 0, 0, width, height);

  const sx = width / 64;
  const sy = height / 64;
  const slim =
    MODEL_REGIONS.some((region) => hasTransparency(ctx, region, sx, sy)) ||
    MODEL_REGIONS.every((region) => isOpaqueColor(ctx, region, sx, sy, 0, 0, 0)) ||
    MODEL_REGIONS.every((region) => isOpaqueColor(ctx, region, sx, sy, 255, 255, 255));
  return slim ? "slim" : "wide";
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

  let measured = null;
  try {
    measured = await measureImage(file);
    const { width, height, previewUrl, img } = measured;
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
        model: detectSkinModel(img, width, height),
        ratings: { red: null, blue: null, logoFront: null, logoBack: null, lenses: null },
        thumb: null,
        skipped: false,
      },
    };
  } catch {
    if (measured?.previewUrl) URL.revokeObjectURL(measured.previewUrl);
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
