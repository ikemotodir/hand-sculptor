// Settings + scene autosave (localStorage, never throws), GLB export, the iOS AR Quick Look check,
// and service-worker registration. (USDZ is built by scene/export.js; main.js opens AR Quick Look.)
//
//   const st = createStorage();
//   const s = st.loadSettings();             // DEFAULT_SETTINGS merged with saved values
//   st.saveSettings(s);
//   st.saveSceneSoon(() => objects.serialize());   // debounced (config.ui.autosaveMs); flushes on pagehide
//   const data = st.loadScene();             // null if none / corrupt
//   await st.downloadGLB(exportGroup);       // GLTFExporter binary → hand-sculptor-YYYYMMDD-HHMMSS.glb
import { CONFIG, VERSION } from './config.js';
import { captureFileName, downloadBlob } from './capture.js';

export const DEFAULT_SETTINGS = {
  bones: true, depth: false, mirror: true, quality: 'auto', sound: true,
  orientation: 'landscape', facing: 'user', toolbarSide: 'right', recordSec: 15, lang: 'ja',
};

const keys = () => CONFIG.ui?.storageKeys || { scene: 'hs.scene.v2', settings: 'hs.settings.v2' };

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { console.warn('[storage] write failed', k, e?.name); return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* */ } }
function parse(s) { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return null; } }

export function isARQuickLookSupported() {
  try { return document.createElement('a').relList.supports('ar'); } catch (e) { return false; }
}

export function createStorage({ autosaveMs = CONFIG.ui?.autosaveMs ?? 1000 } = {}) {
  let timer = 0, pendingGetter = null;

  const flush = () => {
    clearTimeout(timer); timer = 0;
    const g = pendingGetter; pendingGetter = null;
    if (!g) return false;
    try { return api.saveScene(typeof g === 'function' ? g() : g); } catch (e) { console.warn('[storage] serialize', e); return false; }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  }

  const api = {
    // ---- settings ----
    loadSettings(defaults = DEFAULT_SETTINGS) {
      const saved = parse(lsGet(keys().settings));
      return { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) };
    },
    saveSettings(s) { return lsSet(keys().settings, JSON.stringify(s ?? {})); },

    // ---- scene ----
    loadScene() {
      const d = parse(lsGet(keys().scene));
      return d && typeof d === 'object' ? d : null;
    },
    saveScene(data) {
      if (data == null) { lsDel(keys().scene); return true; }
      return lsSet(keys().scene, JSON.stringify(data));
    },
    /** Debounced autosave. `getter` is a function returning the data (called at save time) or the data itself. */
    saveSceneSoon(getter) {
      pendingGetter = getter;
      clearTimeout(timer);
      timer = setTimeout(flush, autosaveMs);
    },
    flush,
    clearScene() { clearTimeout(timer); timer = 0; pendingGetter = null; lsDel(keys().scene); },

    // ---- small flags (tutorial done, hints seen …) ----
    get(key, fallback = null) { const v = parse(lsGet(key)); return v ?? fallback; },
    set(key, value) { return lsSet(key, JSON.stringify(value)); },

    // ---- GLB ----
    /** THREE.Object3D (e.g. objects.exportMeshes() / scene/export.js result) → Blob(model/gltf-binary) */
    async exportGLB(object) {
      const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
      const buf = await new GLTFExporter().parseAsync(object, { binary: true, onlyVisible: true });
      return new Blob([buf], { type: 'model/gltf-binary' });
    },
    async downloadGLB(object, name = captureFileName('glb')) {
      const blob = await api.exportGLB(object);
      downloadBlob(blob, name);
      return blob;
    },
  };
  return api;
}

/**
 * Register app/sw.js (cache-first vendor/models, network-first app code). Call after first paint.
 * Skipped when ?nosw=1, without serviceWorker support, or on non-secure origins.
 */
export function registerSW({ version = VERSION, search = (typeof location !== 'undefined' ? location.search : '') } = {}) {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return Promise.resolve(null);
    if (new URLSearchParams(search).get('nosw') === '1') {
      navigator.serviceWorker.getRegistrations?.().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
      return Promise.resolve(null);
    }
    const url = new URL(`sw.js?v=${encodeURIComponent(version)}`, document.baseURI);
    return navigator.serviceWorker.register(url.href, { scope: './' }).catch(e => { console.warn('[sw]', e?.message || e); return null; });
  } catch (e) { return Promise.resolve(null); }
}
