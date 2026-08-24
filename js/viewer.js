const DEFAULT_ZOOM = 0.78;
const THUMB_ZOOM = 0.86;

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

let thumbEngine = null;

function getThumbEngine() {
  if (thumbEngine) return thumbEngine;
  const SkinViewer = requireLib();
  const canvas = document.createElement("canvas");
  const viewer = new SkinViewer({
    canvas,
    width: 160,
    height: 212,
    enableControls: false,
    renderPaused: true,
    preserveDrawingBuffer: true,
    zoom: THUMB_ZOOM,
    fov: 48,
  });
  applyLook(viewer);
  let chain = Promise.resolve();
  thumbEngine = {
    capture(skin) {
      chain = chain
        .then(async () => {
          await viewer.loadSkin(skin.url, { model: modelName(skin.model) });
          resetViewerPose(viewer, THUMB_ZOOM);
          if (viewer.playerObject) {
            viewer.playerObject.rotation.y = 0.5;
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
  const engine = getThumbEngine();
  const data = await engine.capture(skin);
  skin.thumb = data;
  return data;
}
