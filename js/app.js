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
import { captureThumb, createAttachedViewer, disposeThumbEngine, thumbPlaceholder } from "./viewer.js";

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
  sortKey: "total",
  // Результат тейбрейкера: Map(skinId -> rank внутри группы ничьих), либо null,
  // если тейбрейкер ещё не проводился (или был сброшен после изменения оценок).
  tiebreak: null,
  // Признак того, что данные загружены из JSON, а не оценены в этой сессии.
  imported: false,
  filters: {
    query: "",
    minScore: null,
    maxScore: null,
    min: { red: 0, blue: 0, logoFront: 0, logoBack: 0, lenses: 0 },
  },
};

const els = {
  screens: {
    upload: document.getElementById("screen-upload"),
    rate: document.getElementById("screen-rate"),
    board: document.getElementById("screen-board"),
    tiebreak: document.getElementById("screen-tiebreak"),
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
  btnImport: document.getElementById("btn-import"),
  inputFiles: document.getElementById("input-files"),
  inputFolder: document.getElementById("input-folder"),
  inputImport: document.getElementById("input-import"),
  currentName: document.getElementById("current-name"),
  rateProgress: document.getElementById("rate-progress"),
  categories: document.getElementById("categories"),
  totalValue: document.getElementById("total-value"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  btnSkip: document.getElementById("btn-skip"),
  btnSlim: document.getElementById("btn-slim"),
  btnWide: document.getElementById("btn-wide"),
  topbarMeta: document.getElementById("topbar-meta"),
  podium: document.getElementById("podium"),
  lbBody: document.getElementById("lb-body"),
  toast: document.getElementById("toast"),
  dialog: document.getElementById("reveal-dialog"),
  revealPath: document.getElementById("reveal-path"),
  revealDir: document.getElementById("reveal-dir"),
  btnCopyPath: document.getElementById("btn-copy-path"),
  btnCopyDir: document.getElementById("btn-copy-dir"),
  boardSort: document.getElementById("board-sort"),
  btnExport: document.getElementById("btn-export"),
  btnBackRate: document.getElementById("btn-back-rate"),
  btnNewSession: document.getElementById("btn-new-session"),
  boardSearch: document.getElementById("board-search"),
  boardMinScore: document.getElementById("board-min-score"),
  boardMaxScore: document.getElementById("board-max-score"),
  filterRed: document.getElementById("filter-red"),
  filterBlue: document.getElementById("filter-blue"),
  filterLogoFront: document.getElementById("filter-logo-front"),
  filterLogoBack: document.getElementById("filter-logo-back"),
  filterLenses: document.getElementById("filter-lenses"),
  btnResetFilters: document.getElementById("btn-reset-filters"),
  // Tiebreaker
  tiebreakInfo: document.getElementById("tiebreak-info"),
  tiebreakLeft: document.getElementById("tiebreak-left"),
  tiebreakRight: document.getElementById("tiebreak-right"),
  btnTiebreakSkip: document.getElementById("btn-tiebreak-skip"),
  // Import
  importDialog: document.getElementById("import-dialog"),
  importPreview: document.getElementById("import-preview"),
  btnImportConfirm: document.getElementById("btn-import-confirm"),
};

let rateHandle = null;
const podiumHandles = [];
let podiumRenderToken = 0;
let toastTimer = 0;

// Tiebreaker: два переиспользуемых вьюера (левый/правый) — всего 2 WebGL-контекста
// на весь экран тейбрейкера, освобождаются после разрешения всех ничьих.
const tiebreakHandles = [];
let tiebreakChoiceResolve = null;
let tiebreakAborted = false;
let tiebreakCompareCount = 0;
let tiebreakGroupLabel = "";
let pendingImport = null;

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
        skin.skipped = false;
        invalidateTiebreak();
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
  const totalScore = document.getElementById("total-score");
  if (skin.skipped) {
    els.totalValue.textContent = "Skipped";
    totalScore.classList.add("is-skipped");
  } else {
    els.totalValue.textContent = formatScore(score);
    totalScore.classList.remove("is-skipped");
  }
  els.categories.querySelectorAll(".cat").forEach((card) => {
    const key = card.dataset.key;
    const value = skin.ratings[key];
    card.querySelector("[data-val]").textContent = value == null ? "—" : value;
    paintStars(card.querySelector(".stars"), value, false);
  });

  const complete = CATEGORIES.every((c) => skin.ratings[c.key] != null);
  const canProceed = complete || skin.skipped;
  els.btnNext.disabled = !canProceed;
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
  invalidateTiebreak();
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
  if (!skin) return;
  const complete = CATEGORIES.every((c) => skin.ratings[c.key] != null);
  if (!complete && !skin.skipped) return;
  if (state.index < state.order.length - 1) {
    state.index += 1;
    await showSkin();
    return;
  }
  await finishRating();
}

async function skipCurrent() {
  const skin = currentSkin();
  if (!skin) return;
  skin.skipped = true;
  for (const cat of CATEGORIES) {
    skin.ratings[cat.key] = null;
  }
  skin.thumb = null;
  invalidateTiebreak();
  if (state.index < state.order.length - 1) {
    state.index += 1;
    await showSkin();
    return;
  }
  await finishRating();
}

function rankedSkins(sortKey = state.sortKey) {
  const tiebreak = state.tiebreak;
  return [...state.skins]
    .filter((skin) => !skin.skipped)
    .map((skin) => {
      const score = average(skin.ratings) ?? -1;
      const sortScore = sortKey === "total" || score < 0 ? score : (skin.ratings[sortKey] ?? -1);
      return { skin, score, sortScore };
    })
    .sort((a, b) => {
      if (sortKey === "total") {
        if (b.score !== a.score) return b.score - a.score;
        // Тейбрейкер разрешает порядок только при равенстве итогового балла.
        // Скины без рейтинга (undefined) считаются «хуже» любых размеченных —
        // так разрешённая топ-8 не вытесняется снизу скином с тем же баллом.
        if (tiebreak) {
          const ra = tiebreak.get(a.skin.id);
          const rb = tiebreak.get(b.skin.id);
          const raV = ra == null ? Infinity : ra;
          const rbV = rb == null ? Infinity : rb;
          if (raV !== rbV) return raV - rbV;
        }
        return a.skin.name.localeCompare(b.skin.name, "ru");
      }
      return b.sortScore - a.sortScore || b.score - a.score || a.skin.name.localeCompare(b.skin.name, "ru");
    });
}

function matchesFilters(row) {
  const f = state.filters;
  const query = f.query.trim().toLowerCase();
  const name = String(row.skin.name || "").toLowerCase();
  const relativePath = String(row.skin.relativePath || "").toLowerCase();
  if (query && !name.includes(query) && !relativePath.includes(query)) return false;

  const total = row.score < 0 ? null : row.score;
  if (total == null) return false;
  if (f.minScore != null && total < f.minScore) return false;
  if (f.maxScore != null && total > f.maxScore) return false;
  for (const key of ["red", "blue", "logoFront", "logoBack", "lenses"]) {
    if (f.min[key] > 0 && (row.skin.ratings[key] ?? 0) < f.min[key]) return false;
  }
  return true;
}

function renderTableOnly() {
  const ranked = rankedSkins();
  renderTable(ranked.filter(matchesFilters), ranked);
}

function resetBoardFilters() {
  state.filters = {
    query: "",
    minScore: null,
    maxScore: null,
    min: { red: 0, blue: 0, logoFront: 0, logoBack: 0, lenses: 0 },
  };
  els.boardSearch.value = "";
  els.boardMinScore.value = "";
  els.boardMaxScore.value = "";
  els.filterRed.value = "0";
  els.filterBlue.value = "0";
  els.filterLogoFront.value = "0";
  els.filterLogoBack.value = "0";
  els.filterLenses.value = "0";
}

function syncBoardFilters() {
  const f = state.filters;
  els.boardSearch.value = f.query;
  els.boardMinScore.value = f.minScore == null ? "" : String(f.minScore);
  els.boardMaxScore.value = f.maxScore == null ? "" : String(f.maxScore);
  els.filterRed.value = String(f.min.red);
  els.filterBlue.value = String(f.min.blue);
  els.filterLogoFront.value = String(f.min.logoFront);
  els.filterLogoBack.value = String(f.min.logoBack);
  els.filterLenses.value = String(f.min.lenses);
}

function disposePodium() {
  podiumRenderToken += 1;
  while (podiumHandles.length) {
    const handle = podiumHandles.pop();
    handle.dispose();
  }
}

function invalidateTiebreak() {
  // Любое изменение оценок сбрасывает результат тейбрейкера — при следующем
  // переходе к таблице лидеров он будет проведён заново, если ничьи ещё есть.
  state.tiebreak = null;
}

// Группы скинов с одинаковым итоговым баллом внутри топ-8 (по общей оценке).
// Вне топ-8 тейбрейкер не нужен — порядок там не влияет на «призы».
function findTieGroups() {
  const ranked = rankedSkins("total");
  const top = ranked.slice(0, 8);
  const groups = [];
  let current = [];
  let currentScore = null;
  for (const row of top) {
    if (current.length && row.score === currentScore) {
      current.push(row.skin);
    } else {
      if (current.length >= 2) groups.push(current);
      current = [row.skin];
      currentScore = row.score;
    }
  }
  if (current.length >= 2) groups.push(current);
  return groups;
}

// Точка входа в тейбрейкер: вызывается из finishRating перед таблицей лидеров.
// Возвращает Map(skinId -> rank). Если ничьих нет — пустой Map.
async function runTiebreak(groups) {
  if (!groups.length) return new Map();

  setScreen("tiebreak");
  els.topbarMeta.textContent = "Тейбрейкер";

  // Два переиспользуемых вьюера на весь экран тейбрейкера.
  if (!tiebreakHandles.length) {
    tiebreakHandles.push(
      createAttachedViewer(els.tiebreakLeft.querySelector("canvas"), { controls: true, zoom: 0.8 }),
      createAttachedViewer(els.tiebreakRight.querySelector("canvas"), { controls: true, zoom: 0.8 }),
    );
  }

  tiebreakAborted = false;
  tiebreakCompareCount = 0;
  const result = new Map();

  for (let gi = 0; gi < groups.length; gi += 1) {
    const group = groups[gi];
    if (tiebreakAborted) {
      // При отказе сохраняем текущий (именной) порядок группы.
      group.forEach((skin, idx) => result.set(skin.id, idx));
      continue;
    }
    tiebreakGroupLabel =
      `Группа ${gi + 1} из ${groups.length} · одинаковый балл ${formatScore(average(group[0].ratings))} · ` +
      `${group.length} ${pluralSkins(group.length).split(" ")[1]} с ничьей`;
    els.tiebreakInfo.textContent = tiebreakGroupLabel;
    const ordered = await orderGroup(group.slice());
    ordered.forEach((skin, idx) => result.set(skin.id, idx));
  }

  disposeTiebreakViewers();
  return result;
}

// Сортировка слиянием на попарных сравнениях пользователя: даёт полный порядок
// при минимуме сравнений (≈ N·log N) и хорошо ложится на «сначала пары, потом
// победители друг с другом».
async function orderGroup(group) {
  if (group.length <= 1) return group.slice();
  if (group.length === 2) {
    const [winner, loser] = await resolvePair(group[0], group[1]);
    return [winner, loser];
  }
  const mid = Math.ceil(group.length / 2);
  const left = await orderGroup(group.slice(0, mid));
  if (tiebreakAborted) return [...left, ...group.slice(mid)];
  const right = await orderGroup(group.slice(mid));
  if (tiebreakAborted) return [...left, ...right];
  return mergeOrdered(left, right);
}

async function mergeOrdered(left, right) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length && !tiebreakAborted) {
    const [winner] = await resolvePair(left[i], right[j]);
    if (winner === left[i]) {
      out.push(left[i]);
      i += 1;
    } else {
      out.push(right[j]);
      j += 1;
    }
  }
  while (i < left.length) out.push(left[i++]);
  while (j < right.length) out.push(right[j++]);
  return out;
}

// Показывает пару скинов и ждёт выбора пользователя. Возвращает [winner, loser].
async function resolvePair(a, b) {
  if (tiebreakAborted) return [a, b];

  await Promise.all([tiebreakHandles[0].load(a), tiebreakHandles[1].load(b)]);
  if (tiebreakAborted) return [a, b];

  tiebreakCompareCount += 1;
  els.tiebreakInfo.textContent = `${tiebreakGroupLabel} · сравнение ${tiebreakCompareCount}`;
  fillTiebreakCard(els.tiebreakLeft, a);
  fillTiebreakCard(els.tiebreakRight, b);

  const choice = await waitForChoice();
  if (tiebreakAborted || choice == null) return [a, b];
  return choice === a.id ? [a, b] : [b, a];
}

function fillTiebreakCard(card, skin) {
  card.dataset.id = skin.id;
  card.querySelector(".tiebreak-name").textContent = skin.name;
  card.querySelector(".tiebreak-score").textContent = formatScore(average(skin.ratings));
}

function waitForChoice() {
  return new Promise((resolve) => {
    tiebreakChoiceResolve = resolve;
  });
}

function pickTiebreak(id) {
  if (!tiebreakChoiceResolve) return;
  const resolve = tiebreakChoiceResolve;
  tiebreakChoiceResolve = null;
  resolve(id);
}

function cancelTiebreak() {
  tiebreakAborted = true;
  if (tiebreakChoiceResolve) {
    const resolve = tiebreakChoiceResolve;
    tiebreakChoiceResolve = null;
    resolve(null);
  }
}

function disposeTiebreakViewers() {
  while (tiebreakHandles.length) {
    const handle = tiebreakHandles.pop();
    handle.dispose();
  }
  tiebreakChoiceResolve = null;
}

// Завершение оценки: при необходимости проводит тейбрейкер, затем открывает
// таблицу лидеров. Тейбрейкер проводится один раз и кешируется в state.tiebreak,
// пока оценки не изменятся (что сбрасывает кеш через invalidateTiebreak).
async function finishRating() {
  if (rateHandle) rateHandle.pause();
  if (state.tiebreak == null) {
    const groups = findTieGroups();
    state.tiebreak = groups.length ? await runTiebreak(groups) : new Map();
  }
  await openLeaderboard();
}

async function openLeaderboard() {
  if (rateHandle) rateHandle.pause();
  setScreen("board");
  // У импортированной сессии нет экрана оценки — прячем «вернуться к оценкам».
  els.btnBackRate.hidden = !!state.imported;
  const ratedCount = state.skins.filter((skin) => !skin.skipped).length;
  els.topbarMeta.textContent = `Оценено: ${ratedCount}`;
  els.podium.innerHTML = `<div class="podium-empty">Готовим 3D-превью…</div>`;
  els.lbBody.replaceChildren();
  els.boardSort.value = state.sortKey;
  syncBoardFilters();

  const activeSkins = state.skins.filter((skin) => !skin.skipped);
  await Promise.all(activeSkins.map((skin) => (skin.thumb ? skin.thumb : captureThumb(skin))));
  await renderLeaderboard();
}

async function renderLeaderboard() {
  const ranked = rankedSkins();
  renderTable(ranked.filter(matchesFilters), ranked);
  await renderPodium(ranked.slice(0, 3));
}

function renderTable(ranked, allRanked = ranked) {
  if (!ranked.length) {
    const empty = document.createElement("tr");
    empty.innerHTML = `<td colspan="9" class="table-empty">Ничего не найдено по фильтрам</td>`;
    els.lbBody.replaceChildren(empty);
    return;
  }

  const places = new Map(allRanked.map((row, index) => [row.skin.id, index + 1]));
  els.lbBody.replaceChildren(
    ...ranked.map((row, i) => {
      const place = places.get(row.skin.id) ?? i + 1;
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
  const renderToken = podiumRenderToken;
  els.podium.replaceChildren();
  if (!top.length) {
    els.podium.innerHTML = `<div class="podium-empty">Нет оценённых скинов</div>`;
    return;
  }

  const labels = ["1 место", "2 место", "3 место"];
  for (let i = 0; i < 3; i += 1) {
    if (renderToken !== podiumRenderToken) return;

    const card = document.createElement("article");
    card.className = `podium-card${i === 0 ? " is-first" : ""}`;
    card.dataset.place = String(i + 1);
    if (!top[i]) {
      card.innerHTML = `<div class="podium-place">${labels[i]}</div><div class="podium-stage"></div><div class="podium-name">—</div>`;
      els.podium.append(card);
      continue;
    }
    const { skin, score } = top[i];
    if (!skin.url) {
      // Импортированный скин без файла — 3D недоступен, показываем плейсхолдер.
      card.innerHTML = `
        <div class="podium-place">${labels[i]}</div>
        <div class="podium-stage"><img class="podium-ph" alt="" /></div>
        <div class="podium-name" title="${escapeAttr(skin.relativePath)}"></div>
        <div class="podium-score">${formatScore(score < 0 ? null : score)}</div>
      `;
      card.querySelector(".podium-name").textContent = skin.name;
      card.querySelector(".podium-ph").src = skin.thumb || thumbPlaceholder();
      els.podium.append(card);
      continue;
    }
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
    try {
      await handle.load(skin);
    } catch (error) {
      if (renderToken !== podiumRenderToken) return;
      throw error;
    }
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

function onReveal(skin) {
  // Из браузера нельзя открыть системный проводник и выделить файл — показываем
  // известный путь к файлу и папке, чтобы пользователь скопировал его и открыл
  // папку вручную. Никаких диалогов выбора файлов/папок.
  const result = revealSkin(skin);
  els.revealPath.textContent = result.path || "—";
  els.revealDir.textContent = result.dirPath || result.path || "—";
  if (typeof els.dialog.showModal === "function") els.dialog.showModal();
  else showToast(result.path || result.dirPath);
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast("Скопировано в буфер обмена");
    return;
  } catch {
    // clipboard API может быть недоступен — пробуем запасной вариант.
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  showToast(ok ? "Скопировано в буфер обмена" : "Не удалось скопировать");
}

function backToRatings() {
  disposePodium();
  setScreen("rate");
  if (rateHandle) rateHandle.resume();
  showSkin();
}

function newSession() {
  disposePodium();
  disposeTiebreakViewers();
  disposeThumbEngine();
  if (rateHandle) {
    rateHandle.dispose();
    rateHandle = null;
  }
  clearAll();
  state.order = [];
  state.index = 0;
  state.sortKey = "total";
  state.tiebreak = null;
  state.imported = false;
  resetBoardFilters();
  setScreen("upload");
}

// --- Экспорт / импорт оценок ---

function freshId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `skin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function exportRatings() {
  const rated = state.skins.filter((s) => !s.skipped);
  if (!rated.length) {
    showToast("Нет оценённых скинов для сохранения");
    return;
  }
  const data = {
    version: 1,
    date: new Date().toISOString(),
    skins: state.skins.map((s) => {
      const ratings = s.skipped
        ? { red: null, blue: null, logoFront: null, logoBack: null, lenses: null }
        : {
            red: s.ratings.red ?? null,
            blue: s.ratings.blue ?? null,
            logoFront: s.ratings.logoFront ?? null,
            logoBack: s.ratings.logoBack ?? null,
            lenses: s.ratings.lenses ?? null,
          };
      return {
        name: s.name,
        relativePath: s.relativePath,
        model: s.model === "slim" ? "slim" : "wide",
        ratings,
        skipped: !!s.skipped,
      };
    }),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `skinvote-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast("Оценки сохранены в JSON");
}

function parseSession(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Файл не является корректным JSON");
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.skins)) {
    throw new Error("Неверная структура файла: ожидается объект со списком skins");
  }
  const keys = ["red", "blue", "logoFront", "logoBack", "lenses"];
  const skins = data.skins.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Скин #${i + 1}: неверная запись`);
    }
    const name = String(raw.name || `skin-${i + 1}.png`);
    const relativePath = String(raw.relativePath || name);
    const model = raw.model === "slim" ? "slim" : "wide";
    const skipped = !!raw.skipped;
    const inRatings = raw.ratings && typeof raw.ratings === "object" ? raw.ratings : {};
    const ratings = {};
    for (const k of keys) {
      const v = inRatings[k];
      ratings[k] = Number.isFinite(v) && v >= 0 && v <= 10 ? Number(v) : null;
    }
    return {
      id: freshId(),
      name,
      relativePath,
      file: null,
      url: null,
      width: null,
      height: null,
      fileHandle: null,
      dirHandle: null,
      model,
      ratings,
      thumb: null,
      skipped,
      imported: true,
    };
  });
  return {
    version: Number(data.version) || 1,
    date: typeof data.date === "string" ? data.date : null,
    skins,
  };
}

function formatSessionDate(iso) {
  if (!iso) return "дата неизвестна";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

function showImportPreview(session) {
  const total = session.skins.length;
  const rated = session.skins.filter((s) => !s.skipped).length;
  const skipped = total - rated;
  const sample = session.skins.slice(0, 4).map((s) => escapeAttr(s.name)).join(", ");
  els.importPreview.innerHTML = `
    <p class="muted">Сессия от <b>${formatSessionDate(session.date)}</b></p>
    <p>Скинов в файле: <b>${total}</b>${rated !== total ? ` (оценено ${rated}, пропущено ${skipped})` : ""}</p>
    ${sample ? `<p class="muted" style="margin-top:8px">Например: ${sample}${total > 4 ? "…" : ""}</p>` : ""}
    <p class="muted" style="margin-top:8px">Сразу откроется таблица лидеров. 3D-превью доступны только для скинов, чьи файлы сейчас загружены.</p>
  `;
  if (typeof els.importDialog.showModal === "function") els.importDialog.showModal();
  else showToast(`Импорт: ${total} скинов`);
}

function loadImportedSession(session) {
  if (typeof els.importDialog.close === "function") els.importDialog.close();
  state.skins.forEach(revokeSkin);
  state.skins = session.skins;
  state.rejected = [];
  state.skipped = 0;
  state.order = [];
  state.index = 0;
  state.sortKey = "total";
  state.tiebreak = null;
  state.imported = true;
  resetBoardFilters();
  // Импортированные данные показываем сразу, без экрана оценки и тейбрейкера.
  openLeaderboard();
}

async function handleImportFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    showToast("Не удалось прочитать файл");
    return;
  }
  let session;
  try {
    session = parseSession(text);
  } catch (error) {
    showToast(error.message || "Неверный формат файла");
    return;
  }
  if (!session.skins.length) {
    showToast("В файле нет скинов");
    return;
  }
  pendingImport = session;
  showImportPreview(session);
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

  els.btnImport.addEventListener("click", () => els.inputImport.click());
  els.inputImport.addEventListener("change", async () => {
    const file = els.inputImport.files?.[0];
    els.inputImport.value = "";
    if (file) await handleImportFile(file);
  });
}

function readScoreFilter(input) {
  const raw = input.value.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(10, Math.max(1, value));
}

function updateCategoryFilter(key, value) {
  const number = Number(value);
  state.filters.min[key] = Number.isFinite(number) ? Math.min(10, Math.max(0, number)) : 0;
  renderTableOnly();
}

function bindRate() {
  buildCategories();
  els.btnPrev.addEventListener("click", goPrev);
  els.btnNext.addEventListener("click", goNext);
  els.btnSkip.addEventListener("click", skipCurrent);
  els.btnSlim.addEventListener("click", () => setModel("slim"));
  els.btnWide.addEventListener("click", () => setModel("wide"));
  els.boardSort.addEventListener("change", async () => {
    state.sortKey = els.boardSort.value;
    await renderLeaderboard();
  });
  els.boardSearch.addEventListener("input", () => {
    state.filters.query = els.boardSearch.value;
    renderTableOnly();
  });
  [els.boardMinScore, els.boardMaxScore].forEach((input) => {
    input.addEventListener("input", () => {
      state.filters[input === els.boardMinScore ? "minScore" : "maxScore"] = readScoreFilter(input);
      renderTableOnly();
    });
  });
  [
    [els.filterRed, "red"],
    [els.filterBlue, "blue"],
    [els.filterLogoFront, "logoFront"],
    [els.filterLogoBack, "logoBack"],
    [els.filterLenses, "lenses"],
  ].forEach(([select, key]) => {
    select.addEventListener("change", () => updateCategoryFilter(key, select.value));
  });
  els.btnResetFilters.addEventListener("click", () => {
    resetBoardFilters();
    renderTableOnly();
  });
  els.btnBackRate.addEventListener("click", backToRatings);
  els.btnNewSession.addEventListener("click", newSession);

  // Путь к файлу: копирование без диалогов выбора.
  els.btnCopyPath.addEventListener("click", () => copyText(els.revealPath.textContent.trim()));
  els.btnCopyDir.addEventListener("click", () => copyText(els.revealDir.textContent.trim()));

  // Экспорт оценок в JSON.
  els.btnExport.addEventListener("click", exportRatings);

  // Тейбрейкер: клик по карточке = выбор скина; «оставить как есть» = отмена.
  els.tiebreakLeft.addEventListener("click", () => pickTiebreak(els.tiebreakLeft.dataset.id));
  els.tiebreakRight.addEventListener("click", () => pickTiebreak(els.tiebreakRight.dataset.id));
  els.btnTiebreakSkip.addEventListener("click", cancelTiebreak);

  // Подтверждение импорта.
  els.btnImportConfirm.addEventListener("click", () => {
    if (pendingImport) loadImportedSession(pendingImport);
    pendingImport = null;
  });

  window.addEventListener("keydown", (event) => {
    if (state.screen !== "rate") return;
    if (event.key === "ArrowLeft") goPrev();
    if (event.key === "ArrowRight") goNext();
    if (event.key === "s" || event.key === "S") skipCurrent();
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
