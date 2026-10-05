// Photo + video capture → in-app TRAY (memory + IndexedDB 'hs.media'). Share/download only from a real tap.
//
//   const cap = createCapture({ stage, overlay, audio, hud });
//   await cap.photo({ countdown: true })        // 3-2-1 → composite right after the next render → tray
//   await cap.toggleRecord({ countdown: true }) // 3-2-1 → record (15 s default) → tray
//   cap.tray.onChange(ev => ...)                // ev = {type:'add'|'remove'|'clear'|'load', item?, items}
//   button.onclick = () => cap.save(item.id)    // MUST be called from a pointer/click handler
//
// Works with preserveDrawingBuffer:false: frames are copied inside stage.onAfterRender(fn).
// Skeleton layer: drawBones(ctx, scale, offset) draws the hands straight into the output at its resolution
// (sharp in 縦). Without it: overlay.captureCanvas (bones only), else overlay.canvas (or `overlayCanvas`),
// stretched. Drawn only while showBones() is true. Cursors/dwell rings should not be on the capture canvas.
// 縦 (R2-11): stage.setCaptureHeight(px) (if the stage has it) raises the GL drawing buffer to the output
// height for the captured frame(s), so the 1080×1920 photo/video is not an upscaled small canvas.
// 横 (2026-10-05): the buffer is raised the same way to the camera's own resolution (stage.getCameraSize), so a
// photo keeps every camera pixel (1080p camera → 1920×1080) and a video is recorded at the camera's resolution
// (long side ≤ 1920, short ≤ 1080; bitrate record.bitrate at 1080p, scaled by pixel count).
// Optional HUD hooks (all optional): hud.countdown(n) (3,2,1 then 0 = hide), hud.flash(), hud.setRecording(on, s), hud.toast(t).
import { CONFIG } from './config.js';
import { fixWebmDuration } from './webm-duration.js';

export const MIME_ORDER = [
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1.42E01F,opus',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/mp4', 'video/webm',
];

const AVOID_MP4_KEY = 'hs.rec.avoidMp4';
function avoidMp4() { try { return localStorage.getItem(AVOID_MP4_KEY) === '1'; } catch (e) { return false; } }

export function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const skipMp4 = avoidMp4();
  for (const m of MIME_ORDER) {
    if (skipMp4 && m.startsWith('video/mp4') && MIME_ORDER.some(x => x.startsWith('video/webm') && MediaRecorder.isTypeSupported(x))) continue;
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* */ }
  }
  return '';  // browser default
}

/** true/false = the file has / lacks a decodable video track; null = can't tell. */
export function hasVideoTrack(blob, timeoutMs = 3000) {
  return new Promise(resolve => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'metadata';
    const url = URL.createObjectURL(blob);
    const end = r => { clearTimeout(t); v.onloadedmetadata = v.onerror = null; setTimeout(() => URL.revokeObjectURL(url), 2000); resolve(r); };
    const t = setTimeout(() => end(null), timeoutMs);
    v.onloadedmetadata = () => end(v.videoWidth > 0);
    v.onerror = () => end(null);
    v.src = url;
  });
}

const pad = n => String(n).padStart(2, '0');
export function captureFileName(ext, d = new Date()) {
  return `hand-sculptor-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}
const extFor = mime => /png/.test(mime) ? 'png' : /jpe?g/.test(mime) ? 'jpg' : /mp4/.test(mime) ? 'mp4' : 'webm';
const even = v => Math.max(2, Math.round(v / 2) * 2);
const isMobile = () => typeof navigator !== 'undefined' && (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));
const toBlob = (canvas, type, q) => new Promise(res => canvas.toBlob(b => res(b), type, q));

/**
 * 横 capture scale = output px per CSS px of the stage (pure). The camera covers the stage, so its own pixel density
 * there is min(camW / cssW, camH / cssH). Photo: that, long side ≤ R.desktopLong (mobileLong). Video: also short side
 * ≤ R.maxShort and ≥ R.minShort (holograms stay legible with a small camera), phones ≤ 2× CSS px (frame rate).
 * buf = the drawing buffer's px per CSS px: never smaller than what is on screen (long side ≤ the limit).
 * → 0 when the camera size is unknown (then the canvas size is used as before).
 */
export function landscapeScale(cam, css, kind, R, mobile = false, buf = 0) {
  if (!cam?.w || !cam?.h || !(css?.w > 2) || !(css?.h > 2)) return 0;
  const long = Math.max(css.w, css.h), short = Math.min(css.w, css.h);
  const limit = mobile ? R.mobileLong : R.desktopLong;
  let d = Math.min(cam.w / css.w, cam.h / css.h, limit / long);
  if (kind === 'video') {
    d = Math.min(d, (R.maxShort ?? 1080) / short);
    d = Math.max(d, Math.min((R.minShort ?? 720) / short, limit / long));
  }
  if (buf > 0) d = Math.max(d, Math.min(buf, limit / long));
  if (kind === 'video' && mobile) d = Math.min(d, 2);
  return d;
}
/** recording bitrate: R.bitrate at 1920×1080, scaled by pixel count, ≥ R.minBitrate */
export function recordBitrate(W, H, R) {
  const b = R.bitrate * (W * H) / (1920 * 1080);
  return Math.round(Math.max(R.minBitrate ?? 2_000_000, Math.min(R.bitrate * 1.25, b)));
}

// ---------------------------------------------------------------------------------------------------
// Tray: newest first, max N, Blobs in memory + IndexedDB
// ---------------------------------------------------------------------------------------------------
const DB_NAME = 'hs.media', STORE = 'items';
/** name, or name-2 / name-3 … (before the extension) if already used; the date-time part is kept (R2-32) */
export function uniqueName(name, used) {
  if (!used.has(name)) return name;
  const m = /^(.*?)(\.\w+)?$/.exec(name), base = m[1], ext = m[2] || '';
  let k = 2;
  while (used.has(`${base}-${k}${ext}`)) k++;
  return `${base}-${k}${ext}`;
}
function idb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE, { keyPath: 'id' }); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
    rq.onblocked = () => reject(new Error('idb blocked'));
  });
}
async function dbDo(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const st = tx.objectStore(STORE);
      let out;
      const r = fn(st);
      if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export function createTray({ max = CONFIG.media.capture.trayMax, persist = true } = {}) {
  let items = [];
  const subs = new Set();
  const emit = ev => { ev.items = items.slice(); for (const fn of subs) { try { fn(ev); } catch (e) { console.error(e); } } };
  const usedNames = new Set();
  const materialize = rec => ({
    id: rec.id, kind: rec.kind, mime: rec.mime, name: rec.name, size: rec.blob.size, w: rec.w, h: rec.h,
    durationMs: rec.durationMs || 0, createdAt: rec.createdAt, blob: rec.blob, thumb: rec.thumb || null,
    url: URL.createObjectURL(rec.blob), thumbUrl: rec.thumb ? URL.createObjectURL(rec.thumb) : null,
  });
  const release = it => { try { URL.revokeObjectURL(it.url); if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl); } catch (e) { /* */ } };
  const toRecord = it => ({ id: it.id, kind: it.kind, mime: it.mime, name: it.name, w: it.w, h: it.h, durationMs: it.durationMs, createdAt: it.createdAt, blob: it.blob, thumb: it.thumb });

  const tray = {
    items: () => items.slice(),
    get(id) { return items.find(i => i.id === id) || null; },
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** Restore from IndexedDB (call once at startup). */
    async load() {
      if (!persist) return items.slice();
      try {
        const recs = (await dbDo('readonly', st => st.getAll())) || [];
        recs.sort((a, b) => b.createdAt - a.createdAt);
        const keep = recs.slice(0, max), drop = recs.slice(max);
        for (const it of items) release(it);
        items = keep.filter(r => r.blob instanceof Blob).map(materialize);
        items.forEach(i => usedNames.add(i.name));
        if (drop.length) dbDo('readwrite', st => { drop.forEach(r => st.delete(r.id)); }).catch(() => {});
      } catch (e) { console.warn('[tray] load', e?.message || e); }
      emit({ type: 'load' });
      return items.slice();
    },
    async add({ kind, blob, mime = blob.type, w = 0, h = 0, durationMs = 0, thumb = null, date = new Date() }) {
      const name = uniqueName(captureFileName(extFor(mime), date), usedNames);
      usedNames.add(name);
      const it = materialize({ id: `m${date.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind, mime, name, w, h, durationMs, createdAt: date.getTime(), blob, thumb });
      items.unshift(it);
      const evicted = items.splice(max);
      evicted.forEach(release);
      if (persist) {
        try { await dbDo('readwrite', st => { st.put(toRecord(it)); evicted.forEach(e => st.delete(e.id)); }); }
        catch (e) { console.warn('[tray] save', e?.message || e); }
      }
      emit({ type: 'add', item: it });
      return it;
    },
    async remove(id) {
      const i = items.findIndex(x => x.id === id);
      if (i < 0) return false;
      const [it] = items.splice(i, 1); release(it);
      if (persist) dbDo('readwrite', st => st.delete(id)).catch(() => {});
      emit({ type: 'remove', item: it });
      return true;
    },
    async clear() {
      items.forEach(release); items = [];
      if (persist) { try { await dbDo('readwrite', st => st.clear()); } catch (e) { /* */ } }
      emit({ type: 'clear' });
    },
  };
  return tray;
}

// ---------------------------------------------------------------------------------------------------
// Save / share (real taps only)
// ---------------------------------------------------------------------------------------------------
function hasActivation() {
  const ua = typeof navigator !== 'undefined' && navigator.userActivation;
  return !ua || ua.isActive;
}
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function canShareFile(file) {
  try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { return false; }
}
/** share sheet (if available) → {ok, how:'share'|'download'|'cancelled'|'no-tap'|'error'} */
export async function shareOrDownload(blob, name, { preferShare = isMobile() } = {}) {
  if (!hasActivation()) return { ok: false, how: 'no-tap' };
  const file = new File([blob], name, { type: blob.type });
  if (preferShare && canShareFile(file)) {
    try { await navigator.share({ files: [file] }); return { ok: true, how: 'share' }; }
    catch (e) {
      if (e?.name === 'AbortError') return { ok: false, how: 'cancelled' };
      console.warn('[capture] share failed → download', e?.name);
    }
  }
  try { downloadBlob(blob, name); return { ok: true, how: 'download' }; }
  catch (e) { return { ok: false, how: 'error', error: e }; }
}

// ---------------------------------------------------------------------------------------------------
// Watermark layout (pure; SPEC §13.6: top-left, ~3.1% of WIDTH, nothing in the right 11% / bottom 25%)
// ---------------------------------------------------------------------------------------------------
export const WM_LINE2 = 1.3, WM_URL_SCALE = 0.62, WM_SPACING = 0.12;
/** Monospace estimate of a line's width (px) at font size px; used when no canvas is available. */
const approxWidth = (text, px, spacing) => text.length * px * (0.6 + spacing);
/**
 * @param {number} W @param {number} H output size
 * @param {{title:string,x:number,y:number,font:number}} wm
 * @param {{url?:string, measure?:(text:string, px:number, line:1|2)=>number}} [o] measure = real text width at px
 * @returns {{x:number,y:number,fs:number,urlFs:number,urlY:number}}
 */
export function watermarkLayout(W, H, wm, { url = '', measure } = {}) {
  const x = Math.round(W * wm.x), y = Math.round(H * wm.y);
  const mw = measure || ((text, px, line) => approxWidth(text, px, line === 1 ? WM_SPACING : 0));
  let fs = W * wm.font;
  const blockH = url ? WM_LINE2 + WM_URL_SCALE : 1;                 // block height in fs units
  fs = Math.min(fs, Math.max(1, H * 0.75 - y) / blockH);             // keep out of the bottom 25%
  const maxW = Math.max(1, W * 0.89 - x);                            // keep out of the right 11%
  const widest = Math.max(mw(wm.title, fs, 1), url ? mw(url, fs * WM_URL_SCALE, 2) : 0);
  if (widest > maxW) fs *= maxW / widest;                            // text width scales linearly with px
  fs = Math.max(10, Math.floor(fs));
  return { x, y, fs, urlFs: Math.round(fs * WM_URL_SCALE), urlY: y + Math.round(fs * WM_LINE2) };
}

// ---------------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {object} o.stage   needs onAfterRender(fn(canvas)) and renderer.domElement (or pass `canvas`)
 * @param {object} [o.overlay] overlay module; uses overlay.captureCanvas || overlay.canvas
 * @param {object} [o.audio]  audio module (play, destinationStream, state)
 * @param {object} [o.hud]
 * @param {() => boolean} [o.showBones]  default () => CONFIG.ui.showBones
 * @param {() => 'landscape'|'portrait'} [o.getOrientation] default CONFIG.media.capture.orientation
 * @param {(n:number) => void} [o.onCountdown]  3,2,1 then 0
 * @param {(ctx:CanvasRenderingContext2D, scale:number, offset:{x:number,y:number}) => void} [o.drawBones]
 *        draws the skeletons given in page CSS px at p * scale + offset (output px); replaces the overlay canvas
 */
export function createCapture(o = {}) {
  const { stage, overlay, audio, hud } = o;
  const M = () => CONFIG.media;
  const glCanvas = () => o.canvas || stage?.renderer?.domElement || stage?.canvas || null;
  const ovCanvas = () => o.overlayCanvas || overlay?.captureCanvas || overlay?.canvas || null;
  const showBones = o.showBones || (() => CONFIG.ui?.showBones !== false);
  const drawBones = o.drawBones || null;
  const getOrientation = o.getOrientation || (() => M().capture.orientation);
  const tray = o.tray || createTray({ persist: o.persist !== false });

  // busy = a photo/record start is in progress; busyKind says which; counting = its 3-2-1 is running.
  let busy = false, busyKind = null, busyId = 0, counting = false, cancelToken = 0;
  let wakeCountdown = null;     // ends the countdown's 1 s sleep early (cancel)
  const claim = kind => { busy = true; busyKind = kind; return ++busyId; };
  const release = id => { if (id === busyId) { busy = false; busyKind = null; counting = false; } };
  const pageHidden = () => typeof document !== 'undefined' && document.hidden === true;
  let rec = null;               // active recording state
  let lastResult = Promise.resolve(null);   // tray item (or null) of the current/last recording
  const frameWaiters = [];

  // ---- 縦: render the GL frame at the output height (R2-11) ---------------------------------------------
  // Each photo / recording holds the height it needs; the stage applies the largest at its next render().
  const holds = new Map();
  let holdSeq = 0;
  function applyHolds() {
    let h = 0; for (const v of holds.values()) h = Math.max(h, v);
    try { stage?.setCaptureHeight?.(h); } catch (e) { console.warn('[capture] hi-res', e); }
  }
  /** → release fn. px = drawing-buffer height wanted (0 = nothing to do) */
  function holdHiRes(px) {
    if (!px || typeof stage?.setCaptureHeight !== 'function') return () => {};
    const id = ++holdSeq; holds.set(id, px); applyHolds();
    return () => { if (holds.delete(id)) applyHolds(); };
  }
  /** stage size in CSS px */
  function cssSize() {
    const gr = glCanvas()?.getBoundingClientRect?.();
    if (gr && gr.width > 2 && gr.height > 2) return { w: gr.width, h: gr.height };
    const sz = stage?.getSize?.();
    return sz?.W ? { w: sz.W, h: sz.H } : null;
  }
  /** current drawing-buffer px per CSS px (0 = unknown) */
  function bufScale() {
    const gl = glCanvas(), css = cssSize();
    return gl?.height > 2 && css ? gl.height / css.h : 0;
  }
  const camScale = kind => landscapeScale(stage?.getCameraSize?.(), cssSize(), kind, M().record, isMobile(), bufScale());
  /** drawing-buffer height for a capture. 縦: the output height; mobile video stays ≤ 2× CSS px (frame rate).
   *  横: the camera's own resolution over the stage (0 = camera size unknown → nothing raised). */
  function captureHeight(orientation, kind) {
    if (orientation !== 'portrait') {
      const d = camScale(kind), css = cssSize();
      return d && css ? Math.round(css.h * d) : 0;
    }
    const H = M().capture.portraitH;
    if (kind !== 'video' || !isMobile()) return H;
    const gl = glCanvas();
    const cssH = gl?.getBoundingClientRect?.()?.height || stage?.getSize?.()?.H || 0;
    return cssH > 0 ? Math.min(H, Math.round(cssH * 2)) : H;
  }

  // ---- composite -----------------------------------------------------------------------------------
  function outputSize(orientation, src, kind = 'photo') {
    const c = M().capture;
    if (orientation === 'portrait') return { W: c.portraitW, H: c.portraitH };
    if (kind === 'video') {   // the camera's resolution (the GL buffer is raised to at least this while recording)
      const d = camScale('video'), css = cssSize();
      if (d && css) return { W: even(css.w * d), H: even(css.h * d) };
    }
    const cw = src?.width || 1280, ch = src?.height || 720;
    const limit = isMobile() ? M().record.mobileLong : M().record.desktopLong;
    const s = Math.min(1, limit / Math.max(cw, ch));
    return { W: even(cw * s), H: even(ch * s) };
  }

  function coverRect(sw, sh, W, H) {
    const target = W / H;
    if (sw / sh > target) { const w = sh * target; return { sx: (sw - w) / 2, sy: 0, sw: w, sh }; }
    const h = sw / target; return { sx: 0, sy: (sh - h) / 2, sw, sh: h };
  }

  function drawWatermark(ctx, W, H) {
    const wm = M().watermark;
    const url = CONFIG.ui?.shareUrl || wm.url || '';
    const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "Segoe UI", sans-serif';
    const setFont = (px, line) => {
      ctx.font = `${line === 1 ? 700 : 500} ${px}px ${FONT}`;
      try { ctx.letterSpacing = line === 1 ? `${(px * WM_SPACING).toFixed(1)}px` : '0px'; } catch (e) { /* */ }
    };
    ctx.save();
    const measure = (text, px, line) => {
      setFont(px, line);
      const m = ctx.measureText?.(text)?.width;
      return m > 0 ? m : approxWidth(text, px, line === 1 ? WM_SPACING : 0);
    };
    const { x, y, fs, urlFs, urlY } = watermarkLayout(W, H, wm, { url, measure });
    ctx.globalAlpha = wm.opacity;
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(0,240,255,0.75)'; ctx.shadowBlur = fs * 0.5;
    ctx.fillStyle = '#ffffff';
    setFont(fs, 1);
    ctx.fillText(wm.title, x, y);
    if (url) {
      setFont(urlFs, 2);
      ctx.fillStyle = '#bff9ff';
      ctx.fillText(url, x, urlY);
    }
    ctx.restore();
  }

  /** Draw GL (+ bones) + watermark into ctx (W×H). Must run right after a render (drawing buffer valid). */
  function composite(ctx, W, H) {
    const gl = glCanvas();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (!gl || !gl.width || !gl.height) { drawWatermark(ctx, W, H); return; }
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = 'high'; } catch (e) { /* */ }   // a downscaled buffer stays crisp
    const r = coverRect(gl.width, gl.height, W, H);
    ctx.drawImage(gl, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
    const ov = ovCanvas();
    if (drawBones && showBones()) {
      // GL crop (GL px) → page CSS px; the hands are given in page CSS px
      const gr = gl.getBoundingClientRect?.();
      const ok = gr && gr.width > 2 && gr.height > 2;
      const sz = ok ? null : stage?.getSize?.();
      const cssW = ok ? gr.width : (sz?.W || gl.width), cssH = ok ? gr.height : (sz?.H || gl.height);
      const gsx = cssW / gl.width, gsy = cssH / gl.height;
      const s = W / (r.sw * gsx);
      const off = { x: -((ok ? gr.left : 0) + r.sx * gsx) * s, y: -((ok ? gr.top : 0) + r.sy * gsy) * s };
      ctx.save();
      try { drawBones(ctx, s, off); } catch (e) { console.warn('[capture] bones', e); } finally { ctx.restore(); }
    } else if (ov && ov.width && ov.height && showBones()) {
      // map the GL crop (GL px) → CSS px → overlay px (overlay may cover a different area, e.g. 9:16 stage)
      let ox = r.sx * ov.width / gl.width, oy = r.sy * ov.height / gl.height, ow = r.sw * ov.width / gl.width, oh = r.sh * ov.height / gl.height;
      const gr = gl.getBoundingClientRect?.(), orr = ov.getBoundingClientRect?.();
      if (gr && orr && gr.width > 2 && orr.width > 2) {
        const gsx = gr.width / gl.width, gsy = gr.height / gl.height;     // CSS px per GL px
        const osx = ov.width / orr.width, osy = ov.height / orr.height;   // overlay px per CSS px
        ox = (gr.left + r.sx * gsx - orr.left) * osx; oy = (gr.top + r.sy * gsy - orr.top) * osy;
        ow = r.sw * gsx * osx; oh = r.sh * gsy * osy;
      }
      try { ctx.drawImage(ov, ox, oy, ow, oh, 0, 0, W, H); } catch (e) { /* */ }
    }
    drawWatermark(ctx, W, H);
  }

  function afterRender() {
    if (frameWaiters.length) {
      const ws = frameWaiters.splice(0);
      for (const w of ws) {
        try {
          const { W, H } = outputSize(w.orientation, glCanvas());
          const c = document.createElement('canvas'); c.width = W; c.height = H;
          composite(c.getContext('2d'), W, H);
          w.resolve(c);
        } catch (e) { w.reject(e); }
      }
    }
    if (rec && rec.ctx) {
      try { composite(rec.ctx, rec.W, rec.H); rec.painted++; } catch (e) { /* */ }
      if (rec.startPending) beginRecorder(rec);   // R3-4: the first encoded frame is this rendered one
      if (rec.painted === 1 && !rec.thumbPending) { rec.thumbPending = true; makeThumb(rec.canvas).then(t => { if (rec) rec.thumb = t; }); }
    }
  }
  if (stage?.onAfterRender) stage.onAfterRender(afterRender);

  /** Resolves with a composite canvas captured right after the next render (fallback after timeout;
   *  null if the page is hidden then: the GL buffer is not valid outside a render → would be blank). */
  function nextFrame(orientation, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const w = { orientation, resolve, reject };
      frameWaiters.push(w);
      setTimeout(() => {
        const i = frameWaiters.indexOf(w);
        if (i < 0) return;
        frameWaiters.splice(i, 1);
        if (pageHidden()) { resolve(null); return; }
        const { W, H } = outputSize(orientation, glCanvas());
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        composite(c.getContext('2d'), W, H);   // render loop not running: best effort
        resolve(c);
      }, timeoutMs);
    });
  }

  async function makeThumb(canvas) {
    const L = M().capture.thumbLong;
    const s = L / Math.max(canvas.width, canvas.height);
    const t = document.createElement('canvas'); t.width = even(canvas.width * s); t.height = even(canvas.height * s);
    t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    return toBlob(t, 'image/jpeg', 0.8);
  }

  // ---- countdown ------------------------------------------------------------------------------------
  async function countdown(seconds) {
    const token = cancelToken;
    counting = true;
    try {
      for (let n = seconds; n >= 1; n--) {
        if (token !== cancelToken) return false;
        audio?.play?.('count');
        try { o.onCountdown?.(n); if (hud?.countdown) hud.countdown(n); else hud?.toast?.(String(n), 800); } catch (e) { console.error(e); }
        let wake;
        await new Promise(r => { const t = setTimeout(r, 1000); wake = wakeCountdown = () => { clearTimeout(t); r(); }; });
        if (wakeCountdown === wake) wakeCountdown = null;
      }
      if (token !== cancelToken) return false;
      try { o.onCountdown?.(0); hud?.countdown?.(0); } catch (e) { console.error(e); }
      return true;
    } finally { if (token === cancelToken) counting = false; }
  }
  /** Abort the running 3-2-1 (only that kind if given). Frees busy at once. → true if one was cancelled. */
  function cancelCountdown(kind) {
    if (!busy || !counting || (kind && kind !== busyKind)) return false;
    cancelToken++;
    try { o.onCountdown?.(0); hud?.countdown?.(0); } catch (e) { /* */ }
    const wake = wakeCountdown; wakeCountdown = null;
    release(busyId);
    wake?.();
    return true;
  }
  const countdownSec = c => (c === false || c === 0) ? 0 : (typeof c === 'number' ? c : M().photo.countdownSec);

  // ---- photo ---------------------------------------------------------------------------------------
  async function photo({ countdown: cd = true, orientation } = {}) {
    if (busy || rec) return null;
    const id = claim('photo');
    try {
      const n = countdownSec(cd);
      if (n && !(await countdown(n))) return null;
      const orient = orientation || getOrientation();
      const unhold = holdHiRes(captureHeight(orient, 'photo'));   // this frame renders at 1920 px tall (縦)
      let canvas;
      try { canvas = await nextFrame(orient); } finally { unhold(); }
      if (!canvas) return null;                       // page hidden: no valid frame
      audio?.play?.('shutter');
      try { hud?.flash?.(); } catch (e) { /* */ }
      const [blob, thumb] = await Promise.all([toBlob(canvas, 'image/png'), makeThumb(canvas)]);
      if (!blob) throw new Error('toBlob failed');
      return await tray.add({ kind: 'photo', blob, mime: 'image/png', w: canvas.width, h: canvas.height, thumb });
    } finally { release(id); }
  }

  // ---- recording -----------------------------------------------------------------------------------
  /** R3-4: MediaRecorder starts right after the record canvas got its first rendered frame. */
  function beginRecorder(r) {
    if (!r.startPending) return;
    r.startPending = false; clearTimeout(r.startTimer);
    try { r.mr.start(r.timeslice); r.startedAt = performance.now(); r.onStart.res(true); }
    catch (e) { r.onStart.rej(e); }
  }
  function abortStart(r) {
    if (!r.startPending) return;
    r.startPending = false; clearTimeout(r.startTimer);
    r.onStart.res(false);
  }

  async function startRecord({ countdown: cd = true, seconds, orientation, mime: forceMime } = {}) {
    if (busy || rec) return null;
    if (typeof MediaRecorder === 'undefined') { hud?.toast?.('録画に未対応'); return null; }
    const id = claim('record');
    try {
      const n = countdownSec(cd);
      if (n && !(await countdown(n))) return null;
      if (pageHidden()) return null;                  // hidden right now: rAF is stopped, nothing to record
      const R = M().record;
      const secs = Math.max(1, Math.min(R.maxSec, seconds || R.defaultSec));
      const orient = orientation || getOrientation();
      const { W, H } = outputSize(orient, glCanvas(), 'video');
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');   // painted only right after a render (R3-4: no black frame 0)
      const vstream = canvas.captureStream(R.fps);
      const tracks = [...vstream.getVideoTracks()];
      let unholdAudio = null;
      try {
        if (audio?.destinationStream && audio.state === 'running') {
          const a = audio.destinationStream()?.getAudioTracks?.()[0];
          if (a) { tracks.push(a); unholdAudio = audio.hold?.() || null; }   // muting mid-clip must not stall it
        }
      } catch (e) { /* no audio */ }
      const stream = new MediaStream(tracks);
      let mime = forceMime ?? pickRecorderMime();
      if (!tracks.some(t => t.kind === 'audio') && mime) mime = mime.replace(/,(mp4a\.40\.2|opus)/, '');
      const opts = { videoBitsPerSecond: recordBitrate(W, H, R), audioBitsPerSecond: 128000 };
      if (mime) opts.mimeType = mime;
      let mr;
      try { mr = new MediaRecorder(stream, opts); }
      catch (e) { delete opts.mimeType; mr = new MediaRecorder(stream, opts); }
      const chunks = [];
      mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      const done = new Promise(res => { mr.onstop = res; mr.onerror = res; });
      let resolveResult;
      lastResult = new Promise(res => { resolveResult = res; });
      const unhold = holdHiRes(captureHeight(orient, 'video'));   // 縦: render at the output height while recording
      const r = rec = { mr, canvas, ctx, W, H, chunks, done, stream, vstream, painted: 0, startedAt: performance.now(), secs, timer: 0, thumb: null, thumbPending: false, resolveResult, unhold, unholdAudio,
        startPending: true, timeslice: R.timesliceMs, startTimer: 0, onStart: null };
      const started = new Promise((res, rej) => { r.onStart = { res, rej }; });
      // render loop stalled: start anyway after a short wait (page hidden → no valid frame → give up)
      r.startTimer = setTimeout(() => {
        if (!r.startPending) return;
        if (pageHidden()) { abortStart(r); return; }
        try { composite(ctx, W, H); r.painted++; } catch (e) { /* */ }
        beginRecorder(r);
      }, R.startWaitMs ?? 1500);
      const cleanup = () => { unhold(); unholdAudio?.(); if (rec === r) rec = null; resolveResult(null); vstream.getTracks().forEach(t => t.stop()); };
      let ok;
      try { ok = await started; } catch (e) { cleanup(); throw e; }
      if (!ok || rec !== r) { cleanup(); return null; }
      audio?.play?.('recStart');
      hud?.setRecording?.(true, 0);
      const tickTimer = () => {
        if (!rec) return;
        const s = (performance.now() - rec.startedAt) / 1000;
        hud?.setRecording?.(true, Math.floor(s));
        if (s >= rec.secs) { stopRecord(); return; }
        rec.timer = setTimeout(tickTimer, 250);
      };
      rec.timer = setTimeout(tickTimer, 250);
      return true;
    } finally { release(id); }
  }

  async function stopRecord() {
    if (!rec || rec.stopping) return rec?.stopping || null;
    const r = rec;
    if (r.startPending) { abortStart(r); return null; }   // not started yet: nothing recorded
    r.stopping = (async () => {
      clearTimeout(r.timer);
      r.unhold?.();
      const durationMs = performance.now() - r.startedAt;
      try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch (e) { /* */ }
      await r.done;
      r.unholdAudio?.();
      r.vstream.getTracks().forEach(t => t.stop());
      rec = null;
      hud?.setRecording?.(false, 0);
      audio?.play?.('recStop');
      const type = (r.mr.mimeType || r.chunks[0]?.type || 'video/webm').split(';')[0];
      let blob = new Blob(r.chunks, { type });
      if (!blob.size) { hud?.toast?.('録画できませんでした'); return null; }
      // Some H.264 encoders start late / fail silently → an audio-only file. Detect and drop it;
      // after a long broken recording, prefer WebM from now on.
      if (await hasVideoTrack(blob) === false) {
        if (/mp4/.test(type) && durationMs > 3000) { try { localStorage.setItem(AVOID_MP4_KEY, '1'); } catch (e) { /* */ } }
        hud?.toast?.('録画に失敗 もう一度');
        return null;
      }
      if (/webm/.test(type)) blob = await fixWebmDuration(blob, durationMs);
      const thumb = r.thumb || await makeThumb(r.canvas);
      return tray.add({ kind: 'video', blob, mime: type, w: r.W, h: r.H, durationMs: Math.round(durationMs), thumb });
    })();
    r.stopping.then(r.resolveResult, () => r.resolveResult(null));
    return r.stopping;
  }

  // Page hidden / closed: rAF stops, so the record canvas would freeze while audio and the clock run on,
  // and a photo would composite a stale (blank) GL buffer. Stop the clip / drop the countdown instead.
  function onHidden() {
    if (rec) stopRecord();
    else cancelCountdown();
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => { if (document.hidden) onHidden(); });
    if (typeof window !== 'undefined') window.addEventListener?.('pagehide', onHidden);
  }

  return {
    photo,
    /** ⏺: stop a recording, cancel ITS OWN 3-2-1, or start one. A photo in progress is left alone.
     *  Resolves: start → true|null, stop → tray item|null */
    toggleRecord(opts) {
      if (rec) return stopRecord();
      if (busy) { cancelCountdown('record'); return Promise.resolve(null); }
      return startRecord(opts);
    },
    startRecord, stopRecord,
    /** abort a running countdown (kind 'photo'|'record' = only that one) → true if cancelled */
    cancel: kind => cancelCountdown(kind),
    /** 'photo' | 'record' while that 3-2-1 is running, else null */
    get countdownKind() { return busy && counting ? busyKind : null; },
    get recording() { return !!rec; },
    /** Resolves with the tray item (or null if it failed) of the current / last recording. */
    whenStopped() { return lastResult; },
    get recordSeconds() { return rec && !rec.startPending ? (performance.now() - rec.startedAt) / 1000 : 0; },
    get busy() { return busy; },
    tray,
    /** Call ONLY from a real pointer/click handler. Mobile: share sheet when possible; else download. */
    save(id, opts) { const it = tray.get(id); return it ? shareOrDownload(it.blob, it.name, opts) : Promise.resolve({ ok: false, how: 'missing' }); },
    share(id) { const it = tray.get(id); return it ? shareOrDownload(it.blob, it.name, { preferShare: true }) : Promise.resolve({ ok: false, how: 'missing' }); },
    download(id) {
      const it = tray.get(id); if (!it) return { ok: false, how: 'missing' };
      if (!hasActivation()) return { ok: false, how: 'no-tap' };
      downloadBlob(it.blob, it.name); return { ok: true, how: 'download' };
    },
    /** for tests / main: composite into a given 2D ctx right now (only valid inside onAfterRender) */
    composite,
    outputSize,
  };
}
