const DEFAULT_ZOOM = 0.78;
// Превью в таблице лидеров: один offscreen-контекст, рендер в высоком разрешении,
// затем результат ужимается в <img>. 256×336 = 64×84 ×4 — точно повторяет пропорции
// контейнера .thumb-wrap, поэтому object-fit: cover не обрезает модель.
const THUMB_WIDTH = 256;
const THUMB_HEIGHT = 336;
const THUMB_ZOOM = 0.92;
const THUMB_ROTATION = 0.55; // ~31°, ракурс 3/4 — видно голову, торс и детали

function requireLib() {
  if (!window.skinview3d?.SkinViewer) {
    throw new Error("skinview3d не загрузился");
  }
  return window.skinview3d.SkinViewer;
}

function applyLook(viewer) {
  viewer.animation = null;
  viewer.autoRotate = false;
  viewer.globalLight.intensity = 2.55;
  viewer.cameraLight.intensity = 0.5;
  if (viewer.playerObject) {
    viewer.playerObject.resetJoints();
    viewer.playerObject.rotation.set(0, 0, 0);
  }
}

export function modelName(model) {
  return model === "slim" ? "slim" : "default";
}

export function resetViewerPose(viewer, zoom = DEFAULT_ZOOM) {
  if (!viewer) return;
  applyLook(viewer);
  viewer.zoom = zoom;
  if (typeof viewer.resetCameraPose === "function") {
    viewer.resetCameraPose();
  }
  if (viewer.controls) {
    // Pan (ПКМ) — только для интерактивных вьюеров; у thumbnail-рендерера controls отключены.
    viewer.controls.enablePan = viewer.controls.enabled !== false;
    viewer.controls.enableRotate = true;
    viewer.controls.enableZoom = true;
    viewer.controls.reset();
  }
}

export function createAttachedViewer(canvas, { controls = true, zoom = DEFAULT_ZOOM } = {}) {
  const SkinViewer = requireLib();
  const rect = canvas.parentElement?.getBoundingClientRect();
  const viewer = new SkinViewer({
    canvas,
    width: Math.max(160, Math.floor(rect?.width || 360)),
    height: Math.max(200, Math.floor(rect?.height || 420)),
    enableControls: controls,
    zoom,
    fov: 50,
  });

  applyLook(viewer);
  if (viewer.controls) {
    viewer.controls.enablePan = controls;
    viewer.controls.saveState();
  }

  const onContextMenu = (event) => event.preventDefault();
  if (controls) canvas.addEventListener("contextmenu", onContextMenu);

  const ro = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width < 8 || height < 8) return;
    viewer.setSize(Math.floor(width), Math.floor(height));
  });

  if (canvas.parentElement) ro.observe(canvas.parentElement);

  return {
    viewer,
    async load(skin) {
      await viewer.loadSkin(skin.url, { model: modelName(skin.model) });
      resetViewerPose(viewer, zoom);
    },
    setModel(model) {
      viewer.playerObject.skin.modelType = modelName(model);
    },
    pause() {
      viewer.renderPaused = true;
    },
    resume() {
      viewer.renderPaused = false;
    },
    dispose() {
      ro.disconnect();
      canvas.removeEventListener("contextmenu", onContextMenu);
      viewer.dispose();
    },
  };
}

// Плейсхолдер для скинов без файла (например, импортированных из JSON, когда сам
// PNG недоступен). Минимальный data-URL, чтобы в таблице не было пустоты.
const PLACEHOLDER_THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84" viewBox="0 0 64 84">` +
      `<rect width="64" height="84" fill="#12131a"/>` +
      `<rect x="22" y="14" width="20" height="20" rx="3" fill="#262736"/>` +
      `<rect x="18" y="36" width="28" height="30" rx="4" fill="#1e1f2b"/>` +
      `<text x="32" y="78" font-family="sans-serif" font-size="8" fill="#918ca0" text-anchor="middle">нет файла</text>` +
      `</svg>`,
  );

let thumbEngine = null;

function getThumbEngine() {
  if (thumbEngine) return thumbEngine;
  const SkinViewer = requireLib();
  const canvas = document.createElement("canvas");
  const viewer = new SkinViewer({
    canvas,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    enableControls: false,
    renderPaused: true,
    preserveDrawingBuffer: true,
    zoom: THUMB_ZOOM,
    fov: 45,
  });
  applyLook(viewer);
  viewer.globalLight.intensity = 2.7;
  let chain = Promise.resolve();
  thumbEngine = {
    capture(skin) {
      chain = chain
        .then(async () => {
          await viewer.loadSkin(skin.url, { model: modelName(skin.model) });
          resetViewerPose(viewer, THUMB_ZOOM);
          if (viewer.playerObject) {
            viewer.playerObject.rotation.y = THUMB_ROTATION;
          }
          viewer.render();
          return canvas.toDataURL("image/png");
        })
        .catch(() => null);
      return chain;
    },
    dispose() {
      viewer.dispose();
      thumbEngine = null;
    },
  };
  return thumbEngine;
}

export async function captureThumb(skin) {
  // Нет реального файла (импорт без PNG) — отдаём плейсхолдер, WebGL не трогаем.
  if (!skin.url) {
    skin.thumb = PLACEHOLDER_THUMB;
    return skin.thumb;
  }
  const engine = getThumbEngine();
  const data = await engine.capture(skin);
  skin.thumb = data || PLACEHOLDER_THUMB;
  return skin.thumb;
}

export function disposeThumbEngine() {
  if (thumbEngine) thumbEngine.dispose();
}

export function thumbPlaceholder() {
  return PLACEHOLDER_THUMB;
}
