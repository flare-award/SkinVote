import {
  collectFromDataTransfer,
  filesFromInput,
  inspectSkinFile,
  pickFilesWithFs,
  pickFolderWithFs,
  revealSkin,
  revokeSkin,
  shuffle,
  supportsDirPicker,
  supportsFsAccess,
} from "./files.js";
import { captureThumb, createAttachedViewer } from "./viewer.js";

const CATEGORIES = [
  { key: "red", label: "Красный цвет" },
  { key: "blue", label: "Синий цвет" },
  { key: "logoFront", label: "Лого спереди" },
  { key: "logoBack", label: "Лого взади" },
  { key: "lenses", label: "Линзы" },
];

const state = {
  skins: [],
  rejected: [],
  skipped: 0,
  order: [],
  index: 0,
  screen: "upload",
};

const els = {
  screens: {
    upload: document.getElementById("screen-upload"),
    rate: document.getElementById("screen-rate"),
    board: document.getElementById("screen-board"),
  },
  dropzone: document.getElementById("dropzone"),
  summary: document.getElementById("upload-summary"),
  validCount: document.getElementById("valid-count"),
  skipCount: document.getElementById("skip-count"),
  validList: document.getElementById("valid-list"),
  invalidBlock: document.getElementById("invalid-block"),
  invalidList: document.getElementById("invalid-list"),
  btnStart: document.getElementById("btn-start"),
  btnClearAll: document.getElementById("btn-clear-all"),
  btnClearInvalid: document.getElementById("btn-clear-invalid"),
  btnPickFiles: document.getElementById("btn-pick-files"),
  btnPickFolder: document.getElementById("btn-pick-folder"),
  inputFiles: document.getElementById("input-files"),
  inputFolder: document.getElementById("input-folder"),
  currentName: document.getElementById("current-name"),
  rateProgress: document.getElementById("rate-progress"),
  categories: document.getElementById("categories"),
  totalValue: document.getElementById("total-value"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  btnSlim: document.getElementById("btn-slim"),
  btnWide: document.getElementById("btn-wide"),
  topbarMeta: document.getElementById("topbar-meta"),
  podium: document.getElementById("podium"),
  lbBody: document.getElementById("lb-body"),
  toast: document.getElementById("toast"),
  dialog: document.getElementById("reveal-dialog"),
  revealPath: document.getElementById("reveal-path"),
  btnRevealPicker: document.getElementById("btn-reveal-picker"),
  btnBackRate: document.getElementById("btn-back-rate"),
  btnNewSession: document.getElementById("btn-new-session"),
};

let rateHandle = null;
const podiumHandles = [];
let pendingReveal = null;
let toastTimer = 0;

function currentSkin() {
  const id = state.order[state.index];
  return state.skins.find((s) => s.id === id) || null;
}

function average(ratings) {
  const values = CATEGORIES.map((c) => ratings[c.key]);
  if (values.some((v) => v == null)) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function formatScore(score) {
  if (score == null) return "—/10";
  return `${score.toFixed(1)}/10`;
}

function showToast(text) {
  els.toast.hidden = false;
  els.toast.textContent = text;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
}

function setScreen(name) {
  state.screen = name;
  for (const [key, node] of Object.entries(els.screens)) {
    const active = key === name;
    node.hidden = !active;
    node.classList.toggle("is-active", active);
  }
  if (name === "upload") els.topbarMeta.textContent = "Загрузка пака";
}

function pluralSkins(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} валидный скин`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} валидных скина`;
  return `${n} валидных скинов`;
}

function renderUpload() {
  const hasAny = state.skins.length || state.rejected.length;
  els.summary.hidden = !hasAny;
  els.validCount.textContent = `Найдено ${pluralSkins(state.skins.length)}`;
  const extra = [];
  if (state.skipped) extra.push(`пропущено файлов: ${state.skipped}`);
  if (state.rejected.length) extra.push(`ошибочных: ${state.rejected.length}`);
  els.skipCount.textContent = extra.join(" · ");

  els.validList.replaceChildren(
    ...state.skins.map((skin) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.innerHTML = `<span title="${escapeAttr(skin.relativePath)}"></span><button type="button" aria-label="Убрать">×</button>`;
      chip.querySelector("span").textContent = skin.name;
      chip.querySelector("button").addEventListener("click", () => removeSkin(skin.id));
      return chip;
    }),
  );

  els.invalidBlock.hidden = state.rejected.length === 0;
  els.invalidList.replaceChildren(
    ...state.rejected.map((item, idx) => {
      const li = document.createElement("li");
      li.className = "invalid-item";
      li.innerHTML = `<div><b></b><br><small></small></div><button type="button" class="btn btn-text">Убрать</button>`;
      li.querySelector("b").textContent = item.name;
      li.querySelector("small").textContent = item.reason;
      li.querySelector("button").addEventListener("click", () => {
        state.rejected.splice(idx, 1);
        renderUpload();
      });
      return li;
    }),
  );

  els.btnStart.disabled = state.skins.length === 0;
}

function escapeAttr(value) {
  return String(value).replace(/"/g, "&quot;");
}

function removeSkin(id) {
  const idx = state.skins.findIndex((s) => s.id === id);
  if (idx === -1) return;
  revokeSkin(state.skins[idx]);
  state.skins.splice(idx, 1);
  renderUpload();
}

function clearAll() {
  state.skins.forEach(revokeSkin);
  state.skins = [];
  state.rejected = [];
  state.skipped = 0;
  renderUpload();
}

async function ingestEntries(entries) {
  if (!entries.length) {
    showToast("Файлы не выбраны");
    return;
  }

  let added = 0;
  for (const entry of entries) {
    if (entry.file && !/\.png$/i.test(entry.file.name) && entry.file.type !== "image/png") {
      state.skipped += 1;
      continue;
    }
    const result = await inspectSkinFile(entry);
    if (result.ok) {
      const dup = state.skins.some(
        (s) => s.relativePath === result.skin.relativePath && s.file.size === result.skin.file.size,
      );
      if (dup) {
        revokeSkin(result.skin);
        continue;
      }
      state.skins.push(result.skin);
      added += 1;
    } else {
      state.rejected.push(result);
    }
  }

  renderUpload();
  if (added) showToast(`Добавлено скинов: ${added}`);
}

function buildCategories() {
  els.categories.replaceChildren(
    ...CATEGORIES.map((cat) => {
      const card = document.createElement("div");
      card.className = "cat";
      card.dataset.key = cat.key;
      card.innerHTML = `
        <div class="cat-top">
          <div class="cat-name"><i class="swatch"></i>${cat.label}</div>
          <div class="cat-val" data-val>—</div>
        </div>
        <div class="stars" role="radiogroup" aria-label="${cat.label}"></div>
      `;
      const row = card.querySelector(".stars");
      for (let i = 1; i <= 10; i += 1) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "star";
        btn.dataset.v = String(i);
        btn.setAttribute("aria-label", `${cat.label}: ${i}`);
        row.append(btn);
      }

      row.addEventListener("pointermove", (event) => {
        const btn = event.target.closest(".star");
        if (!btn) return;
        paintStars(row, Number(btn.dataset.v), true);
      });
      row.addEventListener("pointerleave", () => {
        const skin = currentSkin();
        paintStars(row, skin?.ratings[cat.key], false);
      });
      row.addEventListener("click", (event) => {
        const btn = event.target.closest(".star");
        if (!btn) return;
        const skin = currentSkin();
        if (!skin) return;
        skin.ratings[cat.key] = Number(btn.dataset.v);
        refreshRatePanel();
      });
      return card;
    }),
  );
}

function paintStars(row, value, preview) {
  row.querySelectorAll(".star").forEach((star) => {
    const n = Number(star.dataset.v);
    star.classList.toggle("is-on", !preview && value != null && n <= value);
    star.classList.toggle("is-preview", preview && value != null && n <= value);
  });
}

function refreshRatePanel() {
  const skin = currentSkin();
  if (!skin) return;
  const score = average(skin.ratings);
  els.totalValue.textContent = formatScore(score);
  els.categories.querySelectorAll(".cat").forEach((card) => {
    const key = card.dataset.key;
    const value = skin.ratings[key];
    card.querySelector("[data-val]").textContent = value == null ? "—" : value;
    paintStars(card.querySelector(".stars"), value, false);
  });

  const complete = CATEGORIES.every((c) => skin.ratings[c.key] != null);
  els.btnNext.disabled = !complete;
  els.btnNext.textContent = state.index === state.order.length - 1 ? "К таблице лидеров" : "Следующий";
  els.btnPrev.disabled = state.index === 0;
  els.rateProgress.textContent = `Скин ${state.index + 1} из ${state.order.length}`;
  els.currentName.textContent = skin.name;
  els.currentName.title = skin.relativePath;
  els.btnSlim.classList.toggle("is-active", skin.model === "slim");
  els.btnWide.classList.toggle("is-active", skin.model === "wide");
  els.topbarMeta.textContent = `${state.index + 1} / ${state.order.length}`;
}

async function showSkin() {
  const skin = currentSkin();
  if (!skin || !rateHandle) return;
  await rateHandle.load(skin);
  refreshRatePanel();
}

function startSession() {
  if (!state.skins.length) return;
  state.order = shuffle(state.skins.map((s) => s.id));
  state.index = 0;
  setScreen("rate");
  if (!rateHandle) {
    rateHandle = createAttachedViewer(document.getElementById("rate-canvas"), {
      controls: true,
    });
  }
  rateHandle.resume();
  showSkin();
}

async function setModel(model) {
  const skin = currentSkin();
  if (!skin || !rateHandle) return;
  skin.model = model;
  skin.thumb = null;
  rateHandle.setModel(model);
  refreshRatePanel();
}

function goPrev() {
  if (state.index === 0) return;
  state.index -= 1;
  showSkin();
}

async function goNext() {
  const skin = currentSkin();
  if (!skin || CATEGORIES.some((c) => skin.ratings[c.key] == null)) return;
  if (state.index < state.order.length - 1) {
    state.index += 1;
    await showSkin();
    return;
  }
  await openLeaderboard();
}

function rankedSkins() {
  return [...state.skins]
    .map((skin) => ({ skin, score: average(skin.ratings) ?? -1 }))
    .sort((a, b) => b.score - a.score || a.skin.name.localeCompare(b.skin.name, "ru"));
}

function disposePodium() {
  while (podiumHandles.length) {
    const handle = podiumHandles.pop();
    handle.dispose();
  }
}

async function openLeaderboard() {
  if (rateHandle) rateHandle.pause();
  setScreen("board");
  els.topbarMeta.textContent = `Оценено: ${state.skins.length}`;
  els.podium.innerHTML = `<div class="podium-empty">Готовим 3D-превью…</div>`;
  els.lbBody.replaceChildren();

  const ranked = rankedSkins();
  await Promise.all(ranked.map(({ skin }) => (skin.thumb ? skin.thumb : captureThumb(skin))));

  renderTable(ranked);
  await renderPodium(ranked.slice(0, 3));
}

function renderTable(ranked) {
  els.lbBody.replaceChildren(
    ...ranked.map((row, i) => {
      const place = i + 1;
      const tr = document.createElement("tr");
      const badgeClass = place === 1 ? "gold" : place === 2 ? "silver" : place === 3 ? "bronze" : "";
      tr.innerHTML = `
        <td><span class="place-badge ${badgeClass}">${place}</span></td>
        <td>
          <div class="thumb-wrap" data-tip="${escapeAttr(row.skin.relativePath)}">
            <img alt="" />
          </div>
        </td>
        <td class="score-strong">${formatScore(row.score < 0 ? null : row.score)}</td>
        <td>${row.skin.ratings.red ?? "—"}</td>
        <td>${row.skin.ratings.blue ?? "—"}</td>
        <td>${row.skin.ratings.logoFront ?? "—"}</td>
        <td>${row.skin.ratings.logoBack ?? "—"}</td>
        <td>${row.skin.ratings.lenses ?? "—"}</td>
        <td>
          <button type="button" class="icon-btn" aria-label="Открыть расположение файла" title="Открыть папку">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/>
            </svg>
          </button>
        </td>
      `;
      const img = tr.querySelector("img");
      img.src = row.skin.thumb || "";
      img.alt = row.skin.name;
      const wrap = tr.querySelector(".thumb-wrap");
      wrap.addEventListener("pointerenter", (event) => showTip(event, row.skin.relativePath));
      wrap.addEventListener("pointerleave", hideTip);
      tr.querySelector(".icon-btn").addEventListener("click", () => onReveal(row.skin));
      return tr;
    }),
  );
}

async function renderPodium(top) {
  disposePodium();
  els.podium.replaceChildren();
  if (!top.length) {
    els.podium.innerHTML = `<div class="podium-empty">Нет оценённых скинов</div>`;
    return;
  }

  const labels = ["1 место", "2 место", "3 место"];
  for (let i = 0; i < 3; i += 1) {
    const card = document.createElement("article");
    card.className = `podium-card${i === 0 ? " is-first" : ""}`;
    card.dataset.place = String(i + 1);
    if (!top[i]) {
      card.innerHTML = `<div class="podium-place">${labels[i]}</div><div class="podium-stage"></div><div class="podium-name">—</div>`;
      els.podium.append(card);
      continue;
    }
    const { skin, score } = top[i];
    card.innerHTML = `
      <div class="podium-place">${labels[i]}</div>
      <div class="podium-stage"><canvas></canvas></div>
      <div class="podium-name" title="${escapeAttr(skin.relativePath)}"></div>
      <div class="podium-score">${formatScore(score < 0 ? null : score)}</div>
    `;
    card.querySelector(".podium-name").textContent = skin.name;
    els.podium.append(card);
    const canvas = card.querySelector("canvas");
    const handle = createAttachedViewer(canvas, { controls: true, zoom: 0.8 });
    podiumHandles.push(handle);
    await handle.load(skin);
  }
}

let tipNode = null;
function showTip(event, text) {
  hideTip();
  tipNode = document.createElement("div");
  tipNode.className = "tooltip";
  tipNode.textContent = text;
  document.body.append(tipNode);
  const move = (e) => {
    tipNode.style.left = `${e.clientX}px`;
    tipNode.style.top = `${e.clientY}px`;
  };
  move(event);
  tipNode._move = move;
  window.addEventListener("pointermove", move);
}

function hideTip() {
  if (!tipNode) return;
  window.removeEventListener("pointermove", tipNode._move);
  tipNode.remove();
  tipNode = null;
}

async function onReveal(skin) {
  const result = await revealSkin(skin);
  if (result.mode === "cancelled" || result.mode === "picker" || result.mode === "folder") return;
  pendingReveal = skin;
  els.revealPath.textContent = result.path;
  if (typeof els.dialog.showModal === "function") els.dialog.showModal();
  else showToast(result.path);
}

async function revealFromDialog() {
  if (!pendingReveal) return;
  if (supportsFsAccess() && pendingReveal.fileHandle) {
    try {
      await window.showOpenFilePicker({ startIn: pendingReveal.fileHandle, multiple: false });
      els.dialog.close();
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  if (supportsDirPicker() && pendingReveal.dirHandle) {
    try {
      await window.showDirectoryPicker({ startIn: pendingReveal.dirHandle });
      els.dialog.close();
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  showToast("В этом браузере доступна только подсказка с путём к файлу");
}

function backToRatings() {
  disposePodium();
  setScreen("rate");
  if (rateHandle) rateHandle.resume();
  showSkin();
}

function newSession() {
  disposePodium();
  if (rateHandle) {
    rateHandle.dispose();
    rateHandle = null;
  }
  clearAll();
  state.order = [];
  state.index = 0;
  setScreen("upload");
}

function bindUpload() {
  const zone = els.dropzone;

  const setOver = (on) => zone.classList.toggle("is-over", on);

  zone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    setOver(true);
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setOver(true);
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget)) setOver(false);
  });
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    setOver(false);
    const entries = await collectFromDataTransfer(e.dataTransfer);
    await ingestEntries(entries);
  });

  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.inputFiles.click();
    }
  });

  els.btnPickFiles.addEventListener("click", async () => {
    if (supportsFsAccess()) {
      try {
        const entries = await pickFilesWithFs();
        await ingestEntries(entries);
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    els.inputFiles.click();
  });

  els.btnPickFolder.addEventListener("click", async () => {
    if (supportsDirPicker()) {
      try {
        const entries = await pickFolderWithFs();
        await ingestEntries(entries);
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    els.inputFolder.click();
  });

  els.inputFiles.addEventListener("change", async () => {
    const entries = filesFromInput(els.inputFiles.files);
    els.inputFiles.value = "";
    await ingestEntries(entries);
  });

  els.inputFolder.addEventListener("change", async () => {
    const entries = filesFromInput(els.inputFolder.files);
    els.inputFolder.value = "";
    await ingestEntries(entries);
  });

  els.btnClearAll.addEventListener("click", clearAll);
  els.btnClearInvalid.addEventListener("click", () => {
    state.rejected = [];
    renderUpload();
  });
  els.btnStart.addEventListener("click", startSession);
}

function bindRate() {
  buildCategories();
  els.btnPrev.addEventListener("click", goPrev);
  els.btnNext.addEventListener("click", goNext);
  els.btnSlim.addEventListener("click", () => setModel("slim"));
  els.btnWide.addEventListener("click", () => setModel("wide"));
  els.btnBackRate.addEventListener("click", backToRatings);
  els.btnNewSession.addEventListener("click", newSession);
  els.btnRevealPicker.addEventListener("click", revealFromDialog);

  window.addEventListener("keydown", (event) => {
    if (state.screen !== "rate") return;
    if (event.key === "ArrowLeft") goPrev();
    if (event.key === "ArrowRight") goNext();
  });
}

bindUpload();
bindRate();
setScreen("upload");
renderUpload();

["dragover", "drop"].forEach((type) => {
  window.addEventListener(type, (event) => {
    event.preventDefault();
  });
});
