// Camera + MediaPipe hand tracker (browser only).
//
//   const tr = await createTracker({ video, onProgress(bytes, total) })  // loads wasm+model, NO camera yet
//   await tr.startCamera({ facing: 'user' })                             // LAUNCH: getUserMedia only
//   tr.start(res => { stage.setFrame(res.frame); ... })                  // detection driven by requestVideoFrameCallback
//
// detect() result: { hands: RawHand[], vw, vh, frame, nowMs, mediaTime }
//   RawHand = { lm:[{x,y,z}]x21 (normalized, unmirrored), wl:[{x,y,z}]x21 (meters), handed:'Left'|'Right', handScore, canned:{name,score}|null }
//   frame   = VideoFrame (or ImageBitmap) of EXACTLY the image that was detected, or null.
//   FRAME OWNERSHIP: the consumer may close() it as soon as it has uploaded it (stage.setFrame).
//   The tracker ALSO closes every frame two detections later (close() twice is harmless),
//   so a consumer must never keep a frame longer than one detection period.
//   frameMode = 'sync' | 'delayed' | 'live': 'delayed' results carry a buffered frame + interpolated hands;
//   in 'live' mode frame is null and the consumer shows the live video (stage.setFrame(null)).
//
// WORKER PATH (default when Worker + OffscreenCanvas(+WebGL2 for GPU) + VideoFrame/createImageBitmap exist):
// MediaPipe runs in tracker.worker.js (classic worker, vision_bundle.js). On each new video frame, if the worker
// is idle, a VideoFrame (fallback ImageBitmap) is transferred to it; newer frames are skipped while it is busy
// (never queued). frameMode (tracker-sync.js):
//   'sync'    a clone of the detected frame is handed out with its result (skeleton exact, video at result rate)
//   'delayed' (detection < ~20/s) every camera frame is copied into a small ring and shown ~(latency + one result
//             interval) late with the hands interpolated to exactly that frame → smooth video at camera fps and
//             the skeleton stays on the hand (owner bug #20). Back to 'sync' above ~24/s (hysteresis + dwell).
//   'live'    only when no frames can be kept (videoFrames 'none'): live VideoTexture.
// Rendering never waits for detection. Any worker failure or a detect unanswered for too long → the original
// main-thread path below.
import { CONFIG } from './config.js';
import { FrameModeCtl, FRAME_SYNC_DEFAULTS, pickPresentation, workerStalled, RollingMedian, ringPlan, ringCapFor, mainStartIdx, CameraRetry } from './tracker-sync.js';

const TC = () => CONFIG.media.tracker;
const CC = () => CONFIG.media.camera;
const CORE_T = () => CONFIG.core?.tracker || {};

export function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

const MODEL_FILE = { gesture: 'models/gesture_recognizer.task', landmarker: 'models/hand_landmarker.task' };
// Fallback sizes used for progress when Content-Length is missing (bytes, approximate).
const SIZE_GUESS = { wasm: 11_800_000, gesture: 8_373_440, landmarker: 7_819_105 };

/**
 * Fetch with progress → Uint8Array. onBytes(delta) is called for every chunk.
 * Uses XMLHttpRequest when available: its `load` event fires only after the network request has really
 * completed. (Integration fix: with fetch + ReadableStream, Chrome sometimes reported the fully-read
 * wasm/model requests as net::ERR_ABORTED when the Response was collected before the loader finished.)
 */
function xhrBytes(url, onBytes, onTotal) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url); x.responseType = 'arraybuffer';
    let last = 0, totalSent = false;
    x.onprogress = e => {
      if (e.lengthComputable && !totalSent) { onTotal(e.total); totalSent = true; }
      if (e.loaded > last) { onBytes(e.loaded - last); last = e.loaded; }
    };
    x.onload = () => {
      if (x.status < 200 || x.status >= 300) return reject(Object.assign(new Error(`HTTP ${x.status} ${url}`), { code: 'fetch' }));
      const buf = new Uint8Array(x.response);
      if (buf.byteLength > last) onBytes(buf.byteLength - last);
      resolve(buf);
    };
    x.onerror = () => reject(Object.assign(new Error(`network error ${url}`), { code: 'fetch' }));
    x.onabort = () => reject(Object.assign(new Error(`aborted ${url}`), { code: 'fetch' }));
    x.send();
  });
}
async function fetchBytes(url, onBytes, onTotal) {
  if (typeof XMLHttpRequest !== 'undefined') return xhrBytes(url, onBytes, onTotal);
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { code: 'fetch' });
  const len = Number(res.headers.get('content-length')) || 0;
  if (len) onTotal(len);
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer()); onBytes(buf.byteLength); return buf;
  }
  const reader = res.body.getReader(); const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); n += value.byteLength; onBytes(value.byteLength);
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

/** R3-9 / R3-17: once the downloads are done, tell the service worker which big files (wasm, model) this device uses.
 *  It precaches only those (and the light vendor files) — not the other model, and never while LOADING runs. */
export function precacheHint(files, nav = typeof navigator !== 'undefined' ? navigator : null) {
  try {
    const sw = nav?.serviceWorker;
    if (!sw?.ready) return false;
    const msg = { t: 'precache', files: files.filter(Boolean).map(String) };
    const send = () => sw.ready.then(r => r.active?.postMessage(msg)).catch(() => {});
    send();
    sw.addEventListener?.('controllerchange', send, { once: true });   // an update took over: tell the new one
    return true;
  } catch (e) { return false; }
}

/**
 * @param {object} o
 * @param {HTMLVideoElement} o.video
 * @param {'gesture'|'landmarker'} [o.backend]   default from config ('auto' → desktop gesture / mobile landmarker)
 * @param {'GPU'|'CPU'} [o.delegate]             default from config ('auto' → GPU first)
 * @param {number} [o.numHands]                  default 'auto' → desktop+GPU 4, else 2
 * @param {string} [o.assetBase]                 base URL for vendor/ and models/ (default document.baseURI)
 * @param {(bytes:number,total:number)=>void} [o.onProgress]
 * @param {boolean} [o.styleVideo=true]          make the <video> 1×1 px, opacity 0 (never display:none)
 */
export async function createTracker(o = {}) {
  const { video } = o;
  const mobile = o.mobile ?? isMobileDevice();
  const pageBase = typeof document !== 'undefined' ? document.baseURI : location.href;
  const base = o.assetBase ? new URL(o.assetBase, pageBase).href : pageBase;
  const url = p => new URL(p, base).href;

  // ---- resolve backend / delegate / hands -------------------------------------------------------
  const cfgBackend = o.backend || (TC().backend !== 'auto' ? TC().backend : (CORE_T().backend === 'landmarker' ? 'landmarker' : null)) || (mobile ? 'landmarker' : 'gesture');
  const forceDelegate = o.delegate || (TC().delegate !== 'auto' ? TC().delegate : (CORE_T().delegate === 'CPU' ? 'CPU' : null));
  const handsFor = (delegate) => {
    const n = o.numHands ?? TC().numHands;
    if (n !== 'auto' && Number(n) > 0) return Number(n);
    return (!mobile && delegate === 'GPU') ? 4 : 2;
  };
  // Fallback chain (§4 / §13.6)
  const chain = [];
  const add = (backend, delegate) => { if (!forceDelegate || forceDelegate === delegate) chain.push({ backend, delegate }); };
  if (cfgBackend === 'gesture') { add('gesture', 'GPU'); add('gesture', 'CPU'); add('landmarker', 'CPU'); }
  else { add('landmarker', 'GPU'); add('landmarker', 'CPU'); add('gesture', 'CPU'); }
  if (!chain.length) chain.push({ backend: cfgBackend, delegate: 'CPU' });

  // ---- state ------------------------------------------------------------------------------------
  const listeners = { result: new Set(), resize: new Set(), status: new Set(), error: new Set(), backend: new Set() };
  const emit = (name, v) => { for (const fn of listeners[name]) { try { fn(v); } catch (e) { console.error(e); } } };
  if (o.onError) listeners.error.add(o.onError);

  let vision = null, wasmFileset = null, wasmUrl = null;
  const modelBytes = {};               // backend → Uint8Array (kept for rebuilds)
  let task = null, cur = null, chainIdx = 0;
  let lastTs = 0, lastMediaTime = -1, rebuildsInRow = 0, rebuilding = null, closed = false;
  let stream = null, facing = o.facing || 'user', portrait = false, wakeLock = null;
  let camInfo = null;                  // chosen camera mode (upgradeCamera): label, capabilities max, settings
  const DETECT_LONG = () => Math.max(0, Number(TC().detectLong) || 0);
  let detScaleOk = true;               // createImageBitmap with resize works (main-thread path)
  // camera recovery (R2-12) + serialized starts (R2-16): wantCamera = a camera was started and not stopped since
  let wantCamera = false, retryTimer = 0, camJob = null;
  const camRetry = new CameraRetry({ delays: [CC().restartDelayMs ?? 600, ...(CC().retryDelaysMs || [1000, 2000, 4000, 5000])], maxRestarts: CC().maxRestarts, stableMs: CC().stableMs ?? 10000 });
  let loopOn = false, loopToken = 0, busy = false, paused = false;
  const pendingFrames = [];           // frames handed out, closed 2 detections later
  let frameSource = TC().videoFrames;  // 'auto' | 'bitmap' | 'none'  (what is grabbed from the video)
  const m = { initMs: 0, detectMs: 0, detectFps: 0, frames: 0, handsSum: 0, errors: 0, rebuilds: 0, skipped: 0, lastDetectAt: 0, loadBytes: 0, loadTotal: 0 };

  // ---- worker path state ------------------------------------------------------------------------
  const SY = { ...FRAME_SYNC_DEFAULTS, ...(TC().frameSync || {}) };
  const GPU_CHECK = { warmup: 10, samples: 20, maxMs: 150, ratio: 1.5, cpuSamples: 6, watch: 20, ...(TC().gpuCheck || {}) };
  // Frame identity/time (R2-14): video.currentTime of a camera runs between frames, so frames and results are
  // labelled with the frame callback's mediaTime (curFrameMt), or the VideoFrame's own timestamp once it is known
  // to be the same clock (vfClock) — never with a currentTime read at some later moment.
  let lastTickMt = -1, curFrameMt = -1, vfClock = false, vfAgree = 0, vfMiss = 0, resizeOk = true;
  let worker = null, useWorker = false, workerFallback = null, inflight = null, seq = 0;
  let streamGen = 0;                  // ++ on every camera stop/switch: older in-flight results are dropped
  let syncPref = 'auto';              // 'auto' | 'sync' | 'delayed' | 'live' (setFrameSync, tests)
  const modeCtl = new FrameModeCtl(SY);
  const resultTimes = [], videoTimes = [], presentTimes = [];
  let gpuCheck = { state: 'n/a' };
  // leak ledger: every frame handed out (display) or buffered (ring) has a counting close()
  const ledger = { made: 0, displayMade: 0, displayClosedEarly: 0, workerClosed: 0, ringMade: 0, closedCounted: 0 };
  const displaySet = new Set(), ringSet = new Set();
  // delayed mode: buffered camera frames {mt, wall, frame} and recent results {mt, hands, vw, vh} (ascending mt)
  const ring = [], hist = [];
  let lastShownMt = -1, ringPending = 0, hashOn = false;
  // nowMs handed to the consumer is strictly increasing across modes; 'delayed' keeps the real camera spacing
  let deliverTs = 0, presentShift = null;

  // ---- progress over wasm + model ------------------------------------------------------------------
  let progBytes = 0; const totals = {};
  const reportProgress = () => {
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    m.loadBytes = progBytes; m.loadTotal = total;
    try { o.onProgress?.(progBytes, Math.max(total, progBytes)); } catch (e) { console.error(e); }
  };
  const fetchTracked = (key, href) => {
    totals[key] = SIZE_GUESS[key] || 0; reportProgress();
    return fetchBytes(href, d => { progBytes += d; reportProgress(); }, t => { totals[key] = t; reportProgress(); });
  };

  async function loadVision() {
    if (vision) return;
    vision = await import('../vendor/mediapipe/vision_bundle.mjs');
    const fs = await vision.FilesetResolver.forVisionTasks(url('vendor/mediapipe/wasm'));
    wasmUrl = fs.wasmBinaryPath;
    // Prefetch the wasm binary ourselves (progress bar) and hand MediaPipe a blob URL.
    try {
      const bin = await fetchTracked('wasm', fs.wasmBinaryPath);
      wasmFileset = { ...fs, wasmBinaryPath: URL.createObjectURL(new Blob([bin], { type: 'application/wasm' })) };
    } catch (e) {
      console.warn('[tracker] wasm prefetch failed, letting MediaPipe fetch it', e);
      wasmFileset = fs;
    }
  }
  async function loadModel(backend) {
    if (!modelBytes[backend]) modelBytes[backend] = await fetchTracked(backend, url(MODEL_FILE[backend]));
    return modelBytes[backend];
  }

  function closeTask() { try { task?.close(); } catch (e) { /* ignore */ } task = null; }

  async function buildFrom(idx) {
    let lastErr = null;
    for (let i = idx; i < chain.length; i++) {
      const step = chain[i];
      const t0 = performance.now();
      try {
        const bytes = await loadModel(step.backend);
        const C = CORE_T();
        const opts = {
          baseOptions: { modelAssetBuffer: bytes, delegate: step.delegate },
          runningMode: 'VIDEO', numHands: handsFor(step.delegate),
          minHandDetectionConfidence: C.minDetection ?? 0.6,
          minHandPresenceConfidence: C.minPresence ?? 0.6,
          minTrackingConfidence: C.minTracking ?? 0.5,
        };
        const Cls = step.backend === 'gesture' ? vision.GestureRecognizer : vision.HandLandmarker;
        const t = await Cls.createFromOptions(wasmFileset, opts);
        if (closed) { try { t.close(); } catch (e) { /* */ } return null; }   // close() ran while building
        closeTask();
        task = t; cur = { ...step, numHands: opts.numHands }; chainIdx = i; slowSamples = []; gpuWatch.reset();
        m.initMs = Math.round(performance.now() - t0);
        lastTs = Math.max(lastTs, performance.now());
        emit('backend', { ...cur });
        return cur;
      } catch (e) {
        lastErr = e;
        console.warn(`[tracker] ${step.backend}/${step.delegate} failed`, e?.message || e);
      }
    }
    throw Object.assign(new Error('tracker: no backend could start: ' + (lastErr?.message || lastErr)), { code: 'tracker', cause: lastErr });
  }

  let slowSamples = [];
  const gpuWatch = new RollingMedian(GPU_CHECK.watch, 5);   // keeps watching after the first check
  function demote() {
    if (rebuilding) return;
    const next = chain.findIndex((st, i) => i > chainIdx && st.delegate === 'CPU');
    if (next < 0) return;
    rebuilding = (async () => {
      try { await buildFrom(next); } catch (e) { emit('error', { code: 'tracker', error: e, fatal: true }); }
      finally { rebuilding = null; }
    })();
  }

  async function rebuild(err) {
    if (rebuilding) return rebuilding;
    m.rebuilds++; rebuildsInRow++;
    emit('error', { code: 'detect', error: err, fatal: false });
    rebuilding = (async () => {
      closeTask();
      try {
        // first failure: retry the same step once; afterwards walk down the chain
        const next = rebuildsInRow <= 1 ? chainIdx : Math.min(chainIdx + 1, chain.length - 1);
        await buildFrom(next);
      } catch (e) {
        emit('error', { code: 'tracker', error: e, fatal: true });
      } finally { rebuilding = null; }
    })();
    return rebuilding;
  }

  // ---- video element --------------------------------------------------------------------------------
  if (video) {
    video.muted = true; video.playsInline = true; video.autoplay = true;
    video.setAttribute('muted', ''); video.setAttribute('playsinline', ''); video.setAttribute('autoplay', '');
    if (o.styleVideo !== false) {
      Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', zIndex: '-1' });
      if (video.style.display === 'none') video.style.display = 'block';
    }
    video.addEventListener('resize', () => emit('resize', { vw: video.videoWidth, vh: video.videoHeight }));
  }

  // ---- camera -------------------------------------------------------------------------------------------
  function constraints() {
    const c = CC();
    const W = portrait ? c.portraitWidth : c.width, H = portrait ? c.portraitHeight : c.height;
    const v = { facingMode: facing, width: { ideal: W }, height: { ideal: H }, frameRate: { ideal: c.frameRate } };
    if (typeof innerWidth === 'number' && innerHeight > 0) v.aspectRatio = { ideal: portrait ? 9 / 16 : innerWidth / innerHeight };
    return { video: v, audio: false };
  }

  /**
   * Raise a fresh camera track to its largest useful mode (owner 2026-10-05: "画質をカメラのMAXまで"): the camera's own
   * aspect (no crop: the stage covers), within maxLong × maxShort, at ≥ minFps (never below what it delivers now).
   * The first request stays 1280×720 (safe on every device). Tried in the frames' current orientation, then swapped
   * (mobile browsers differ); a result with fewer pixels or a lower frame rate is undone. Never throws.
   */
  async function upgradeCamera(track, stale) {
    const c = CC(), t0 = performance.now();
    const set0 = track?.getSettings?.() || {};
    const info = camInfo = {
      label: String(track?.label || '').slice(0, 80), capW: 0, capH: 0, capFps: 0,
      w: set0.width || 0, h: set0.height || 0, fps: set0.frameRate || 0, first: `${set0.width || 0}x${set0.height || 0}`, upgrade: 'n/a', ms: 0,
    };
    try {
      const caps = track?.getCapabilities?.() || {};
      info.capW = caps.width?.max || 0; info.capH = caps.height?.max || 0; info.capFps = Math.round(caps.frameRate?.max || 0);
      if (c.upgrade === false || !track?.applyConstraints || !info.capW || !info.capH || !set0.width || !set0.height) return info;
      const mob = isMobileDevice();
      const L = (mob ? c.mobileMaxLong : c.maxLong) || 1920, S = (mob ? c.mobileMaxShort : c.maxShort) || 1080;
      const cl = Math.max(info.capW, info.capH), cs = Math.min(info.capW, info.capH);
      const k = Math.min(1, L / cl, S / cs);
      const tl = Math.round(cl * k / 2) * 2, ts = Math.round(cs * k / 2) * 2;
      const px0 = set0.width * set0.height;
      if (tl * ts <= px0 * 1.02) { info.upgrade = 'max'; return info; }
      const minFps = Math.min(c.minFps || 24, set0.frameRate || c.minFps || 24);
      const fpsC = { min: minFps, ideal: Math.max(minFps, c.frameRate || 30) };
      const portraitFrames = set0.height > set0.width;
      const tries = portraitFrames ? [[ts, tl], [tl, ts]] : [[tl, ts], [ts, tl]];
      const good = s => s.width * s.height > px0 * 1.02 && (!s.frameRate || s.frameRate >= minFps - 0.5)
        && (s.height > s.width) === portraitFrames;
      for (const [w, h] of tries) {
        if (stale()) return info;
        try { await track.applyConstraints({ width: { ideal: w }, height: { ideal: h }, frameRate: fpsC }); }
        catch (e) { info.upgrade = 'refused'; continue; }   // OverconstrainedError: the old constraints still hold
        const s = track.getSettings?.() || {};
        if (good(s)) { info.upgrade = 'ok'; break; }
        info.upgrade = 'no-gain';
      }
      if (info.upgrade !== 'ok' && !stale()) {
        // back to what worked (the first request), when a try left the track in a worse mode
        const s = track.getSettings?.() || {};
        if (s.width !== set0.width || s.height !== set0.height || (set0.frameRate && s.frameRate < set0.frameRate - 0.5)) {
          try { await track.applyConstraints({ width: { ideal: set0.width }, height: { ideal: set0.height }, frameRate: { ideal: set0.frameRate || c.frameRate || 30 } }); info.upgrade += '-reverted'; }
          catch (e) { /* keep */ }
        }
      }
    } catch (e) { info.upgrade = 'error'; }
    const s = track?.getSettings?.() || {};
    info.w = s.width || info.w; info.h = s.height || info.h; info.fps = s.frameRate || info.fps;
    info.ms = Math.round(performance.now() - t0);
    return info;
  }

  function stopStream() {
    if (stream) for (const t of stream.getTracks()) { t.onended = null; try { t.stop(); } catch (e) { /* */ } }
    stream = null;
    // results / buffered frames of the old stream must not reach the consumer (media times restart at 0)
    streamGen++;
    flushRing(); hist.length = 0;
    lastShownMt = -1; lastTickMt = -1; curFrameMt = -1; m.lastMt = null; m.firstResultAt = 0;
    resultTimes.length = 0; videoTimes.length = 0; presentTimes.length = 0;
    if (video) { try { video.pause(); } catch (e) { /* */ } video.srcObject = null; }
  }

  async function requestWakeLock() {
    try {
      if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* not allowed / unsupported — harmless */ }
  }

  /**
   * getUserMedia → video playing. Throws a DOMException (NotAllowedError, NotFoundError, …) for start.js.
   * Starts are serialized (R2-16): a start that is overtaken by a newer one stops its own stream and resolves
   * with the newer start's result, so two quick taps never leave a second camera stream running.
   */
  function startCamera(opts = {}) {
    if (opts.facing) facing = opts.facing;
    if (opts.portrait != null) portrait = !!opts.portrait;
    const job = { done: false, p: null };
    camJob = job;
    job.p = openCamera(job).finally(() => { job.done = true; });
    job.p.catch(e => {   // a camera that was running and could not be re-opened → keep retrying (R2-12)
      if (closed || !wantCamera || camJob !== job || e?.name === 'AbortError') return;
      const r = camRetry.next(performance.now(), true);
      emit('error', { code: 'camera', error: e, fatal: r.notify });
      scheduleRestart(r.delay);
    });
    return job.p;
  }
  const camBusy = () => !!camJob && !camJob.done;
  const stopTracks = s => { for (const t of s?.getTracks?.() || []) { try { t.stop(); } catch (e) { /* */ } } };
  /** this start was overtaken (newer start / stopCamera / close): release its camera, hand over the newer result */
  function superseded(job, s) {
    stopTracks(s);
    if (camJob && camJob !== job && !closed) return camJob.p;
    throw Object.assign(new Error('camera start cancelled'), { name: 'AbortError' });
  }

  async function openCamera(job) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('getUserMedia unavailable'), { name: window.isSecureContext ? 'NotSupportedError' : 'InsecureContextError' });
    }
    const stale = () => closed || camJob !== job;
    clearTimeout(retryTimer); retryTimer = 0;
    stopStream();
    emit('status', 'camera-starting');
    let s;
    try { s = await navigator.mediaDevices.getUserMedia(constraints()); }
    catch (e) {
      if (stale()) return superseded(job);
      if (e?.name !== 'OverconstrainedError') throw e;
      s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
    }
    if (stale()) return superseded(job, s);
    // before the video is shown: no visible switch of resolution
    await upgradeCamera(s.getVideoTracks()[0], stale);
    if (stale()) return superseded(job, s);
    if (stream) stopStream();   // never two streams
    stream = s;
    const track = s.getVideoTracks()[0];
    if (track) track.onended = onTrackEnded;
    video.srcObject = s;
    try {
      // not awaited: play() of a stream that never delivers a frame stays pending, which would skip the timeout
      video.play()?.catch?.(() => {});
      await waitForVideo(8000, stale);
    } catch (e) {
      if (stream === s) stopStream(); else stopTracks(s);   // a failed start releases the camera (R2-35)
      throw e;
    }
    if (stale()) return superseded(job);   // the newer start already stopped this stream
    lastMediaTime = -1;
    wantCamera = true; camRetry.started(performance.now());
    requestWakeLock();
    emit('status', 'camera-on');
    emit('resize', { vw: video.videoWidth, vh: video.videoHeight });
    diagStart();
    if (loopOn) scheduleLoop();
    return { vw: video.videoWidth, vh: video.videoHeight, facing, mirror: facing === 'user' };
  }

  function waitForVideo(timeoutMs = 8000, cancelled = () => false) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const check = () => {
        if (cancelled()) return resolve();
        if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
        if (performance.now() - t0 > timeoutMs) return reject(Object.assign(new Error('video not ready'), { name: 'NotReadableError' }));
        setTimeout(check, 30);
      };
      check();
    });
  }

  function onTrackEnded() {
    if (closed) return;
    emit('status', 'camera-ended');
    if (!wantCamera || camBusy()) return;
    const r = camRetry.next(performance.now(), false);
    if (r.notify) emit('error', { code: 'camera', error: new Error('camera ended'), fatal: true });
    scheduleRestart(r.delay);
  }

  function scheduleRestart(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = 0; restartCamera(); }, ms);
  }

  /** One recovery attempt (failures schedule the next one, see startCamera). Hidden page → onVisibility retries. */
  function restartCamera() {
    if (closed || !wantCamera || camBusy() || document.visibilityState !== 'visible') return;
    startCamera().catch(() => {});
  }

  function cameraEnded() {
    const t = stream?.getVideoTracks?.()[0];
    return !t || t.readyState === 'ended';
  }
  const cameraLost = () => wantCamera && !camBusy() && (!stream || cameraEnded());

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      paused = false;
      if (cameraLost()) { clearTimeout(retryTimer); retryTimer = 0; restartCamera(); }
      else if (video?.paused && stream) video.play().catch(() => {});
      if (stream) requestWakeLock();
      if (loopOn) scheduleLoop();
      emit('status', 'visible');
    } else {
      paused = true;
      emit('status', 'hidden');
    }
  };
  // a camera plugged (back) in → try at once instead of waiting for the next retry
  const onDeviceChange = () => { if (cameraLost()) { clearTimeout(retryTimer); retryTimer = 0; restartCamera(); } };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  try { navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange); } catch (e) { /* */ }

  // ---- detection --------------------------------------------------------------------------------------
  // rate windows are pruned at every push (R2-36): no path may depend on metrics() being called
  function pruneWindow(arr, now, ms) { let i = 0; while (i < arr.length && now - arr[i] > ms) i++; if (i) arr.splice(0, i); }
  /** 8×8 grey thumbnail of a frame (tests: proves the frame on screen is the frame that was detected). */
  let hashCv = null;
  function frameHash(f) {
    try {
      hashCv ||= typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(8, 8) : Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
      const g = hashCv.getContext('2d', { willReadFrequently: true });
      g.drawImage(f, 0, 0, 8, 8);
      const d = g.getImageData(0, 0, 8, 8).data, out = [];
      for (let i = 0; i < d.length; i += 4) out.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
      return out;
    } catch (e) { return null; }
  }

  /** time of the frame the video shows now: the frame callback's mediaTime while the loop runs (R2-14) */
  const frameMt = () => (loopOn && curFrameMt >= 0 ? curFrameMt : video.currentTime);
  /** no requestVideoFrameCallback: identify the current frame by its VideoFrame timestamp (currentTime runs) */
  function probeFrameTime() {
    if (typeof VideoFrame === 'function' && video.readyState >= 2) {
      try { const f = new VideoFrame(video); const t = f.timestamp / 1e6; f.close(); if (Number.isFinite(t)) return t; } catch (e) { /* */ }
    }
    return video.currentTime;
  }
  /** does VideoFrame(video).timestamp use the frame callback's clock? (Chrome: yes) — checked on a few frames */
  function checkVfClock() {
    if (vfClock || vfMiss >= 5 || typeof VideoFrame !== 'function' || curFrameMt < 0) return;
    try {
      const f = new VideoFrame(video); const t = f.timestamp / 1e6; f.close();
      if (Math.abs(t - curFrameMt) < 0.002) { if (++vfAgree >= 3) vfClock = true; } else { vfAgree = 0; vfMiss++; }
    } catch (e) { vfMiss = 5; }
  }

  function grabFrame(mt) {
    if (frameSource === 'none') return null;
    if (frameSource === 'auto' && typeof VideoFrame === 'function') {
      try { return new VideoFrame(video, { timestamp: Math.round((mt || 0) * 1e6) }); }
      catch (e) { frameSource = 'bitmap'; }
    }
    return 'bitmap';
  }

  function toHands(res) {
    const out = [];
    const lms = res.landmarks || [];
    for (let i = 0; i < lms.length; i++) {
      const h = res.handedness?.[i]?.[0] || res.handednesses?.[i]?.[0];
      const g = res.gestures?.[i]?.[0];
      out.push({
        lm: lms[i], wl: res.worldLandmarks?.[i] || [],
        handed: h?.categoryName === 'Left' ? 'Left' : 'Right', handScore: h?.score ?? 0,
        canned: g ? { name: g.categoryName, score: g.score } : null,
      });
    }
    return out;
  }

  /** detection copy size for a w×h frame (long side ≤ detectLong), or null when the frame is small enough */
  function detectSize(w, h) {
    const L = DETECT_LONG();
    if (!L || !w || !h || Math.max(w, h) <= L) return null;
    const k = L / Math.max(w, h);
    return { w: Math.max(2, Math.round(w * k)), h: Math.max(2, Math.round(h * k)) };
  }

  function retireFrames(keep) {
    while (pendingFrames.length > keep) { const f = pendingFrames.shift(); try { f.close(); } catch (e) { /* */ } }
  }

  /**
   * Detect hands on the current video frame. Async (ImageBitmap path awaits), resolves null when there
   * is no new frame / video not ready / tracker rebuilding. nowMs is used as the MediaPipe timestamp
   * (forced strictly increasing).
   */
  async function detect(nowMs = performance.now(), { force = false } = {}) {
    if (closed || !task || rebuilding || !video) return null;
    if (video.readyState < 2 || !video.videoWidth) return null;
    const mt = frameMt();
    if (!force && mt === lastMediaTime) { m.skipped++; return null; }
    lastMediaTime = mt;
    let frame = grabFrame(mt), src = video;
    if (frame === 'bitmap') {
      try { frame = await createImageBitmap(video); } catch (e) { frame = null; }
      if (closed || !task) { frame?.close?.(); return null; }
    }
    if (frame) src = frame;
    const vw = frame ? (frame.displayWidth || frame.width) : video.videoWidth;
    const vh = frame ? (frame.displayHeight || frame.height) : video.videoHeight;
    // a big camera frame is detected on a downscaled copy (same aspect → normalized landmarks map onto the full frame)
    let small = null;
    const sz = detectSize(vw, vh);
    if (sz && detScaleOk && typeof createImageBitmap === 'function') {
      try { small = await createImageBitmap(src, { resizeWidth: sz.w, resizeHeight: sz.h, resizeQuality: 'medium' }); }
      catch (e) { detScaleOk = false; small = null; }
      if (closed || !task || rebuilding) { small?.close(); try { frame?.close(); } catch (_) { /* */ } return null; }
    }
    const ts = Math.max(nowMs, lastTs + 1);
    lastTs = ts;
    let res;
    const t0 = performance.now();
    try {
      const inp = small || src;
      res = cur.backend === 'gesture' ? task.recognizeForVideo(inp, ts) : task.detectForVideo(inp, ts);
      small?.close(); small = null;
    } catch (e) {
      m.errors++;
      try { small?.close(); } catch (_) { /* */ }
      try { frame?.close(); } catch (_) { /* */ }
      // Input-type problems (e.g. a browser whose MediaPipe path can't take VideoFrame): step down
      // VideoFrame → ImageBitmap → the <video> element itself (frame = null → stage uses a live VideoTexture).
      if (frame && typeof VideoFrame === 'function' && frame instanceof VideoFrame) frameSource = 'bitmap';
      else if (frame) frameSource = 'none';
      console.warn('[tracker] detect failed → rebuild', e?.message || e);
      if (rebuildsInRow >= TC().maxRebuilds) { emit('error', { code: 'tracker', error: e, fatal: true }); return null; }
      rebuild(e);
      return null;
    }
    const dt = performance.now() - t0;
    m.detW = sz && detScaleOk ? sz.w : vw;
    rebuildsInRow = 0;
    // Software-GL "GPU" (blocklisted GPU → SwiftShader) is ~20× slower than the CPU delegate: demote.
    // Ignore the warm-up detections (shader compile), then the median of the next N decides.
    // After that the GPU stays watched (rolling median): it can degrade later (GPU contention, thermal).
    if (cur.delegate === 'GPU' && !forceDelegate && chainIdx + 1 < chain.length) {
      if (slowSamples.length < GPU_CHECK.warmup + GPU_CHECK.samples) {
        slowSamples.push(dt);
        if (slowSamples.length === GPU_CHECK.warmup + GPU_CHECK.samples) {
          const s = slowSamples.slice(GPU_CHECK.warmup).sort((a, b) => a - b), med = s[s.length >> 1];
          gpuCheck = { state: 'kept-gpu', gpuMedMs: +med.toFixed(1) };
          if (med > GPU_CHECK.maxMs) {
            console.warn(`[tracker] GPU delegate too slow (${med.toFixed(0)} ms) → CPU`);
            gpuCheck.state = 'demoted-slow';
            demote();
          }
        }
      } else if (gpuWatch.push(dt)) {
        const med = gpuWatch.median();
        gpuCheck.watchMedMs = +med.toFixed(1);
        if (med > GPU_CHECK.maxMs && !rebuilding) {
          console.warn(`[tracker] GPU delegate became slow (${med.toFixed(0)} ms) → CPU`);
          gpuCheck.state = 'demoted-watch';
          demote();
        }
      }
    }
    m.detectMs = m.frames ? m.detectMs * 0.9 + dt * 0.1 : dt;
    if (m.lastDetectAt) { const fps = 1000 / Math.max(1, t0 - m.lastDetectAt); m.detectFps = m.detectFps ? m.detectFps * 0.9 + fps * 0.1 : fps; }
    m.lastDetectAt = t0; m.lastMt = mt;
    { const tr = performance.now(); resultTimes.push(tr); pruneWindow(resultTimes, tr, 1000); }   // same metric as the worker path; pruned here (R2-36)
    m.frames++;
    const hands = toHands(res);
    { const rid = ++seq; for (const h of hands) h.src = rid; }   // result id: frame-count gates count per result (R2-5)
    m.handsSum += hands.length;
    m.lastHash = hashOn && frame ? frameHash(frame) : null;
    if (frame) { pendingFrames.push(frame); retireFrames(2); }
    deliverTs = Math.max(deliverTs + 1, ts);
    return { hands, vw, vh, frame, nowMs: deliverTs, mediaTime: mt, frameMode: 'sync', frameHash: m.lastHash };
  }

  // ---- worker detection -------------------------------------------------------------------------------
  function rate(arr, now) { pruneWindow(arr, now, 1000); return arr.length; }

  /** Count closes explicitly (no inference from frame fields): close() is wrapped once; set = current owner. */
  function trackFrame(f, set) {
    set.add(f);
    if (!f.__hsSet) {
      const oc = f.close;
      try {
        f.close = function () { if (f.__hsSet?.delete(f)) ledger.closedCounted++; return oc.call(f); };
      } catch (e) { /* non-writable: the ledger then over-reports open frames (never under-reports) */ }
    }
    f.__hsSet = set;
    return f;
  }
  function moveFrame(f, to) { f.__hsSet?.delete(f); trackFrame(f, to); }
  function closeDisplay(f) { if (f) { try { f.close(); } catch (e) { /* */ } ledger.displayClosedEarly++; } }
  function flushRing() { for (const e of ring.splice(0)) { try { e.frame.close(); } catch (er) { /* */ } } }

  /** Adaptive frame mode (tracker-sync.js FrameModeCtl). */
  function updateMode(now) {
    let changed = null;
    if (syncPref !== 'auto') changed = modeCtl.set(syncPref, now) ? syncPref : null;
    else {
      if (!m.firstResultAt || now - m.firstResultAt < 1000) return;   // window not full yet
      changed = modeCtl.update(now, rate(resultTimes, now), rate(videoTimes, now), frameSource === 'none' ? 'live' : 'delayed');
    }
    if (changed) onModeChange(changed);
  }
  function onModeChange(mode) {
    presentShift = null;
    if (mode !== 'delayed') { flushRing(); hist.length = 0; }
    // frames of the previous mode are not needed any more (the stage already uploaded what it shows)
    if (mode !== 'sync') retireFrames(0);
    emit('status', 'frame-' + mode);
  }

  /** delay of the 'delayed' video: latency + one result interval (+ a little), so that results bracket it */
  function delayMs() { return Math.min(SY.maxDelayMs, (m.latencyMs || 0) + (m.intervalMs || 0) + 15); }

  /** ring capacity for frames of this size (count and bytes limits) */
  const ringCap = f => ringCapFor(f?.width, f?.height, SY);

  /**
   * 'delayed' mode: copy the current camera frame into the ring (ImageBitmap = no camera buffer held).
   * Large frames (1080p, 縦) are copied downscaled so the whole display delay fits the ring (R2-13).
   */
  function bufferFrame(mt, wall) {
    if (modeCtl.mode !== 'delayed' || ringPending > 2 || typeof createImageBitmap !== 'function') return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const plan = ringPlan(vw, vh, delayMs(), rate(videoTimes, wall), SY);
    const resize = resizeOk && (plan.w !== vw || plan.h !== vh);
    const gen = streamGen; ringPending++;
    const grab = resize
      ? createImageBitmap(video, { resizeWidth: plan.w, resizeHeight: plan.h, resizeQuality: 'medium' }).catch(() => { resizeOk = false; return null; })
      : createImageBitmap(video);
    grab.then(bmp => {
      ringPending--;
      if (!bmp) return;   // resize unsupported: this frame is skipped (a later grab would be a newer frame)
      if (closed || gen !== streamGen || modeCtl.mode !== 'delayed' || !loopOn) { try { bmp.close(); } catch (e) { /* */ } return; }
      trackFrame(bmp, ringSet); ledger.ringMade++;
      let i = ring.length; while (i > 0 && ring[i - 1].mt > mt) i--;
      ring.splice(i, 0, { mt, wall, frame: bmp, vw, vh });
      present(performance.now());
      const cap = ringCap(bmp);
      while (ring.length > cap) { const e = ring.shift(); try { e.frame.close(); } catch (er) { /* */ } }
    }, () => { ringPending--; });
  }

  /** 'delayed' mode: show the buffered frame at (newest camera time − delay) with hands interpolated to it. */
  function present(now) {
    if (modeCtl.mode !== 'delayed' || !loopOn || !ring.length || !hist.length) return;
    const target = lastTickMt - delayMs() / 1000;
    const p = pickPresentation(ring, hist, target, lastShownMt, 0.5, ring.length >= ringCap(ring[0].frame));
    if (!p) return;
    const e = ring[p.idx];
    for (let i = 0; i < p.idx; i++) { try { ring[i].frame.close(); } catch (er) { /* */ } }   // skipped (older)
    ring.splice(0, p.idx + 1);
    while (hist.length > 1 && hist[1].mt <= e.mt) hist.shift();   // keep the result at/below for the next frames
    lastShownMt = e.mt;
    moveFrame(e.frame, displaySet); ledger.displayMade++;
    pendingFrames.push(e.frame); retireFrames(2);
    if (presentShift == null) presentShift = Math.max(0, deliverTs + 1 - e.wall);   // entering 'delayed': no jump back
    const nowMs = deliverTs = Math.max(deliverTs + 1, e.wall + presentShift);
    m.lastMt = e.mt; m.lastHash = null; m.held = (m.held || 0) + (p.held ? 1 : 0);
    m.lagMs = (m.lagMs || 0) * 0.95 + p.lag * 1000 * 0.05;   // skeleton behind its frame (0 = on the frame)
    presentTimes.push(now); pruneWindow(presentTimes, now, 1000);
    const h0 = hist[hist.length - 1];
    // vw/vh = the camera size (a downscaled ring copy has the same aspect, so the mapping does not change)
    deliver({ hands: p.hands, vw: e.vw || h0.vw || e.frame.width, vh: e.vh || h0.vh || e.frame.height, frame: e.frame, nowMs,
      mediaTime: e.mt, frameMode: 'delayed', interpolated: p.f != null, held: p.held });
  }

  /** Worker variant of detect(): resolves with the result of THIS frame, or null (no new frame / busy / delayed). */
  async function detectWorker(nowMs = performance.now()) {
    if (closed || !worker || inflight || !video) return null;
    if (video.readyState < 2 || !video.videoWidth) return null;
    // label = the time of THIS frame (R2-14): the frame callback's mediaTime, or — for a detect started between
    // frame callbacks (worker answered → newest frame sent at once) — the VideoFrame's own timestamp
    let mt = frameMt(), frame = null, display = null;
    if (frameSource === 'auto' && typeof VideoFrame === 'function') {
      try {
        frame = new VideoFrame(video);
        const ft = frame.timestamp / 1e6;
        if ((vfClock || !hasRVFC) && Number.isFinite(ft) && Math.abs(ft - mt) >= 0.0005) mt = ft;
      } catch (e) { frameSource = 'bitmap'; frame = null; }
    }
    if (mt === lastMediaTime) { try { frame?.close(); } catch (e) { /* */ } m.skipped++; return null; }
    lastMediaTime = mt;
    const slot = inflight = { seq: ++seq, mt, gen: streamGen, display: null, resolve: null, posted: false };
    const wantDisplay = modeCtl.mode === 'sync' && frameSource !== 'none';
    try {
      // 'auto' → VideoFrame; 'bitmap' / 'none' → ImageBitmap (a copy: holds no camera buffer)
      if (!frame) frame = await createImageBitmap(video);
      if (wantDisplay) {
        display = typeof frame.clone === 'function' ? frame.clone() : await createImageBitmap(frame);
        trackFrame(display, displaySet); ledger.displayMade++;
      }
    } catch (e) {
      try { frame?.close(); } catch (_) { /* */ }   // never reached the worker; closed here
      closeDisplay(display);
      if (inflight === slot) inflight = null;
      return null;
    }
    if (closed || !worker || inflight !== slot || slot.gen !== streamGen) {
      try { frame.close(); } catch (e) { /* */ } closeDisplay(display);
      if (inflight === slot) inflight = null;
      return null;
    }
    const ts = Math.max(nowMs, lastTs + 1);
    lastTs = ts;
    slot.ts = ts; slot.display = display;
    slot.vw = frame.displayWidth || frame.width; slot.vh = frame.displayHeight || frame.height;
    return new Promise(resolve => {
      slot.resolve = resolve;
      try {
        slot.sentAt = performance.now();
        worker.postMessage({ t: 'detect', seq: slot.seq, frame, ts, hash: hashOn }, [frame]);
        slot.posted = true; ledger.made++;
      } catch (e) {
        // transfer not supported for this frame type → try ImageBitmap next time, or give up on the worker
        try { frame.close(); } catch (_) { /* */ }
        inflight = null; closeDisplay(display); resolve(null);
        if (frameSource === 'auto') frameSource = 'bitmap'; else fallbackToMain('postMessage: ' + (e?.message || e));
      }
    });
  }

  function onWorkerMessage(ev) {
    const msg = ev.data || {};
    if (msg.closed != null) ledger.workerClosed = msg.closed;
    if (msg.check) gpuCheck = msg.check;
    if (msg.t === 'result' || msg.t === 'skip') {
      const slot = inflight;
      if (!slot || slot.seq !== msg.seq) return;
      inflight = null;
      const now = performance.now();
      if (slot.gen !== streamGen) { closeDisplay(slot.display); slot.resolve?.(null); return; }   // camera changed meanwhile
      if (msg.t === 'skip') {
        closeDisplay(slot.display);
        if (msg.reason === 'error') {
          m.errors++;
          if (frameSource === 'auto' && /video ?frame|unsupported|type/i.test(msg.message || '')) frameSource = 'bitmap';
          console.warn('[tracker] worker detect failed → rebuild', msg.message);
          emit('error', { code: msg.fatal ? 'tracker' : 'detect', error: new Error(msg.message), fatal: false });
          if (msg.fatal) fallbackToMain('worker detect errors: ' + msg.message);
          else m.rebuilds++;
        }
        slot.resolve?.(null);
        return;
      }
      if (msg.cur && (!cur || msg.cur.backend !== cur.backend || msg.cur.delegate !== cur.delegate || msg.cur.numHands !== cur.numHands)) cur = { ...msg.cur };
      const dt = msg.ms;
      m.detectMs = m.frames ? m.detectMs * 0.9 + dt * 0.1 : dt;
      m.prepMs = m.frames ? (m.prepMs || 0) * 0.9 + (msg.prepMs || 0) * 0.1 : (msg.prepMs || 0);
      m.detW = msg.dw || msg.vw || 0;
      if (m.lastDetectAt) {
        const iv = Math.max(1, now - m.lastDetectAt);
        m.detectFps = m.detectFps ? m.detectFps * 0.9 + (1000 / iv) * 0.1 : 1000 / iv;
        m.intervalMs = m.intervalMs ? m.intervalMs * 0.9 + Math.min(iv, 1000) * 0.1 : Math.min(iv, 1000);
      }
      m.lastDetectAt = now;
      m.latencyMs = m.latencyMs ? m.latencyMs * 0.9 + (now - slot.sentAt) * 0.1 : now - slot.sentAt;
      m.frames++;
      for (const h of msg.hands) h.src = slot.seq;   // result id: delayed mode presents it on several frames (R2-5)
      m.handsSum += msg.hands.length;
      m.firstResultAt ||= now;
      resultTimes.push(now); pruneWindow(resultTimes, now, 1000);
      updateMode(now);
      const mode = modeCtl.mode;
      if (mode === 'delayed') {
        // delivered through present(), at camera rate, on the buffered frame of the same time
        closeDisplay(slot.display);
        hist.push({ mt: slot.mt, hands: msg.hands, vw: msg.vw || slot.vw, vh: msg.vh || slot.vh });
        while (hist.length > 8) hist.shift();
        slot.resolve?.(null);
        present(now);
        return;
      }
      let frame = slot.display;
      if (frame && mode !== 'sync') { closeDisplay(frame); frame = null; }
      if (frame) { pendingFrames.push(frame); retireFrames(2); }
      m.lastMt = slot.mt; m.lastHash = msg.hash || null;
      deliverTs = Math.max(deliverTs + 1, slot.ts);
      slot.resolve?.({ hands: msg.hands, vw: msg.vw || slot.vw, vh: msg.vh || slot.vh, frame, nowMs: deliverTs, mediaTime: slot.mt, frameMode: mode, frameHash: m.lastHash });
      return;
    }
    if (msg.t === 'backend') {
      cur = { ...msg.cur }; slowSamples = [];
      if (msg.initMs) m.initMs = msg.initMs;
      emit('backend', { ...cur, reason: msg.reason });
      return;
    }
    if (msg.t === 'gpuCheck') { gpuCheck = { ...msg }; delete gpuCheck.t; return; }
    if (msg.t === 'fatal') { fallbackToMain('worker fatal: ' + msg.message); return; }
  }

  function killWorker() {
    if (!worker) return;
    try { worker.postMessage({ t: 'close' }); } catch (e) { /* */ }
    try { worker.terminate(); } catch (e) { /* */ }
    worker = null;
    if (inflight) { const s = inflight; inflight = null; closeDisplay(s.display); s.resolve?.(null); }
  }

  /** Worker broke at runtime → the original main-thread path (frames stay in 'sync'). */
  function fallbackToMain(reason) {
    if (!useWorker) return;
    console.warn('[tracker] worker path off → main thread:', reason);
    useWorker = false; workerFallback = String(reason).slice(0, 200);
    if (modeCtl.set('sync', performance.now())) onModeChange('sync');
    killWorker();
    // start where the worker was: once it had moved to CPU (GPU slow / slower than CPU) the GPU is not re-tested
    // on the render thread (R2-33)
    const startIdx = mainStartIdx(chain, cur, gpuCheck.state);
    rebuilding = (async () => {
      try { if (!closed) { await loadVision(); await buildFrom(startIdx); } }
      catch (e) { emit('error', { code: 'tracker', error: e, fatal: true }); }
      finally { rebuilding = null; }
    })();
  }

  /** true, or why the worker path is not used */
  function workerSupport() {
    if (o.worker === false) return 'disabled-by-query';
    if (TC().worker === false) return 'disabled-by-config';
    if (!(typeof Worker === 'function' && typeof OffscreenCanvas === 'function'
      && (typeof VideoFrame === 'function' || typeof createImageBitmap === 'function'))) return 'unsupported';
    // Safari 16.4–16.x: OffscreenCanvas without WebGL → the worker would silently run on CPU while the main
    // thread could use the GPU delegate.
    if (chain[0].delegate === 'GPU') {
      try {
        const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
        if (!gl) return 'no-offscreen-webgl2';
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      } catch (e) { return 'no-offscreen-webgl2'; }
    }
    return true;
  }

  /** Start tracker.worker.js with the preloaded wasm + model. Resolves true when its first task is ready. */
  async function startWorker() {
    const bytes = await loadModel(chain[0].backend);
    const C = CORE_T();
    let w;
    try { w = new Worker(o.workerUrl || new URL('./tracker.worker.js', import.meta.url)); }
    catch (e) { workerFallback = 'new Worker: ' + (e?.message || e); return false; }
    const ok = await new Promise(resolve => {
      const timer = setTimeout(() => { workerFallback = 'init timeout'; resolve(false); }, TC().workerInitMs ?? 45000);
      w.onmessage = ev => {
        const msg = ev.data || {};
        if (msg.t === 'ready') {
          clearTimeout(timer);
          cur = { ...msg.cur }; m.initMs = msg.initMs; gpuCheck = msg.check || gpuCheck;
          resolve(true);
        } else if (msg.t === 'initError') { clearTimeout(timer); workerFallback = 'init: ' + msg.message; resolve(false); }
      };
      w.onerror = ev => { ev.preventDefault?.(); clearTimeout(timer); workerFallback = 'worker error: ' + (ev.message || 'load'); resolve(false); };
      const copy = bytes.slice();
      w.postMessage({
        t: 'init',
        bundleUrl: url('vendor/mediapipe/vision_bundle.js'),
        fileset: { wasmLoaderPath: wasmFileset.wasmLoaderPath, wasmBinaryPath: wasmFileset.wasmBinaryPath },
        models: { [chain[0].backend]: copy },
        modelUrls: { gesture: url(MODEL_FILE.gesture), landmarker: url(MODEL_FILE.landmarker) },
        chain, forceDelegate: forceDelegate || null,
        hands: { GPU: handsFor('GPU'), CPU: handsFor('CPU') },
        conf: { minDetection: C.minDetection ?? 0.6, minPresence: C.minPresence ?? 0.6, minTracking: C.minTracking ?? 0.5 },
        gpuCheck: GPU_CHECK, maxRebuilds: TC().maxRebuilds, detectLong: DETECT_LONG(),
      }, [copy.buffer]);
    });
    if (!ok) { try { w.terminate(); } catch (e) { /* */ } return false; }
    if (closed) { try { w.terminate(); } catch (e) { /* */ } return false; }
    worker = w;
    w.onmessage = onWorkerMessage;
    w.onerror = ev => { ev.preventDefault?.(); fallbackToMain('worker error: ' + (ev.message || '?')); };
    w.onmessageerror = () => fallbackToMain('messageerror');
    emit('backend', { ...cur });
    return true;
  }

  // ---- loop (requestVideoFrameCallback, fallback rAF + VideoFrame timestamp) --------------------------
  let onResult = null;
  const hasRVFC = !!video && typeof video.requestVideoFrameCallback === 'function';
  let rvfcHandle = 0, rafHandle = 0;
  function scheduleLoop() {
    if (!loopOn || closed) return;
    const token = loopToken;
    if (hasRVFC) {
      if (rvfcHandle) { try { video.cancelVideoFrameCallback(rvfcHandle); } catch (e) { /* */ } }
      rvfcHandle = video.requestVideoFrameCallback((t, md) => {
        rvfcHandle = 0;
        curFrameMt = Number.isFinite(md?.mediaTime) ? md.mediaTime : video.currentTime;
        tick(token);
      });
    } else {
      cancelAnimationFrame(rafHandle);
      rafHandle = requestAnimationFrame(() => { curFrameMt = probeFrameTime(); tick(token); });
    }
  }
  // A video frame that arrived while the worker was busy is not queued; but when the result comes back, the
  // NEWEST frame (the video's current one) is sent right away instead of waiting for the next frame callback.
  let missed = false;
  async function runWorkerDetect(token, now) {
    busy = true; missed = false;
    try {
      const r = await detectWorker(now);
      if (r && token === loopToken && loopOn) deliver(r);
      // stopped meanwhile (freeze): drop the result; its frame is in pendingFrames and closed later
    } catch (e) { console.error(e); }
    finally { busy = false; }
    if (missed && useWorker && !paused && token === loopToken && loopOn) runWorkerDetect(token, performance.now());
  }
  const deliver = r => { for (const fn of listeners.result) { try { fn(r); } catch (e) { console.error(e); } } };
  async function tick(token) {
    if (token !== loopToken || !loopOn) return;
    if (useWorker) {
      // keep receiving every video frame (mode clock + camera fps); detection runs only when the worker is idle
      scheduleLoop();
      const now = performance.now();
      if (curFrameMt !== lastTickMt) {
        lastTickMt = curFrameMt; videoTimes.push(now); pruneWindow(videoTimes, now, 1000);
        if (!vfClock) checkVfClock();
        bufferFrame(lastTickMt, now);
      }
      updateMode(now);
      present(now);
      // watchdog: a detect the worker never answers (GPU stall, frame lost in transfer) → main thread
      if (inflight?.posted && workerStalled(inflight.sentAt, now, m.detectMs, m.frames)) { fallbackToMain('worker timeout'); return; }
      if (busy || paused) { if (busy) { m.skipped++; missed = true; } return; }
      runWorkerDetect(token, now);
      return;
    }
    if (!busy && !paused) {
      busy = true;
      try {
        const r = await detect(performance.now());
        if (r) deliver(r);
      } catch (e) { console.error(e); }
      finally { busy = false; }
    }
    if (token === loopToken) scheduleLoop();
  }

  // ---- local diagnostics (owner's PC, zero effort) ------------------------------------------------------
  // Only when the page comes from the local server (http on localhost/127.0.0.1 and /api/info answers
  // 'hand-sculptor'): every diagMs a small JSON goes to the SAME origin's /api/diag → launcher/diag.json.
  // Never on GitHub Pages / other origins, never anywhere else.
  let diagTimer = 0, diagOn = null;
  const apiUrl = p => new URL('../api/' + p, import.meta.url);
  async function diagCheck() {
    if (diagOn != null) return diagOn;
    diagOn = false;
    try {
      if (!(TC().diagMs > 0) || typeof fetch !== 'function' || typeof location === 'undefined') return false;
      if (location.protocol !== 'http:' || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return false;
      // like link.js shouldProbe: the app at the server root (server.mjs), not a test/static server's /app/
      const base = new URL('../', import.meta.url);
      if (base.origin !== location.origin || base.pathname !== '/') return false;
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const to = setTimeout(() => ac?.abort(), 1500);
      const r = await fetch(apiUrl('info'), { cache: 'no-store', signal: ac?.signal });
      clearTimeout(to);
      const j = r.ok ? await r.json() : null;
      diagOn = j?.app === 'hand-sculptor';
    } catch (e) { diagOn = false; }
    return diagOn;
  }
  function diagSnapshot() {
    const tm = api.metrics();
    const t = stream?.getVideoTracks?.()[0], ts = t?.getSettings?.() || {};
    let hs = null, st = null;
    try { hs = window.__hs?.metrics?.() || null; } catch (e) { /* */ }
    try { st = window.__hs?.state?.() || null; } catch (e) { /* */ }
    let cv = null;
    try {
      for (const c of document.querySelectorAll('canvas')) {
        if (!c.clientWidth || (cv && c.width * c.height <= cv.w * cv.h)) continue;
        cv = { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight, ratio: +(c.width / c.clientWidth).toFixed(3) };
      }
    } catch (e) { /* */ }
    let extra = null;
    try { extra = o.diag?.() ?? null; } catch (e) { /* */ }
    return {
      v: 1, ua: String(navigator.userAgent || '').slice(0, 200),
      camera: { ...(camInfo || {}), now: { w: ts.width || 0, h: ts.height || 0, fps: ts.frameRate || 0 }, video: { w: tm.vw, h: tm.vh }, facing },
      screen: { dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, w: screen?.width, h: screen?.height, innerW: innerWidth, innerH: innerHeight },
      canvas: cv,
      stage: { quality: st?.quality ?? null, effective: st?.effectiveQuality ?? null, renderFps: hs?.fps ?? null },
      detect: {
        worker: tm.worker, workerFallback: tm.workerFallback, backend: tm.backend, delegate: tm.delegate, numHands: tm.numHands,
        ms: tm.detectMs, prepMs: tm.prepMs, inputW: tm.detectW, fps: tm.resultRate, latencyMs: tm.latencyMs, gpuCheck: tm.gpuCheck,
      },
      frame: { mode: tm.frameMode, source: tm.frameSource, videoFps: tm.videoFps, shownFps: tm.presentRate, delayMs: tm.displayDelayMs, ringMax: tm.ringMax },
      extra,
    };
  }
  function diagSend() {
    if (closed || !diagOn || !stream || document.visibilityState !== 'visible') return;
    let body;
    try { body = JSON.stringify(diagSnapshot()); } catch (e) { return; }
    fetch(apiUrl('diag'), { method: 'POST', headers: { 'X-HS': '1', 'Content-Type': 'application/json' }, body, cache: 'no-store' }).catch(() => {});
  }
  function diagStart() {
    if (diagTimer || closed) return;
    diagCheck().then(ok => {
      if (!ok || closed || diagTimer) return;
      setTimeout(diagSend, 3000);   // first one soon after the camera started (detection warmed up a little)
      diagTimer = setInterval(diagSend, TC().diagMs);
    });
  }

  // ---- build the first task (preload: no camera needed) ---------------------------------------------
  const tLoad = performance.now();
  function releaseAll() {
    closed = true; clearTimeout(retryTimer); retryTimer = 0; camJob = null; wantCamera = false;
    clearInterval(diagTimer); diagTimer = 0;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    try { navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange); } catch (e) { /* */ }
  }
  try {
    await loadVision();
    await loadModel(chain[0].backend);
    // downloads done (task init still to come): the SW may now cache them — a 304, no second download
    precacheHint([wasmUrl, url(MODEL_FILE[chain[0].backend])]);
    const support = workerSupport();
    if (support === true) {
      try { useWorker = await startWorker(); } catch (e) { useWorker = false; workerFallback = 'start: ' + (e?.message || e); }
      if (!useWorker) console.warn('[tracker] worker unavailable → main-thread detection:', workerFallback);
    } else workerFallback = support;
    if (!useWorker) await buildFrom(0);
  } catch (e) {
    // failed preload (model download): leave nothing behind, the caller may simply create a new tracker (R2-1)
    releaseAll(); killWorker(); closeTask();
    if (wasmFileset?.wasmBinaryPath?.startsWith?.('blob:')) URL.revokeObjectURL(wasmFileset.wasmBinaryPath);
    throw e;
  }
  m.loadMs = Math.round(performance.now() - tLoad);

  const api = {
    get backend() { return cur?.backend; },
    get delegate() { return cur?.delegate; },
    get numHands() { return cur?.numHands; },
    get facing() { return facing; },
    get mirror() { return facing === 'user'; },
    get stream() { return stream; },
    get running() { return loopOn; },
    get worker() { return useWorker; },
    get frameMode() { return modeCtl.mode; },
    /** Detect on the current video frame (worker or main thread). Resolves null when there is nothing new. */
    detect(nowMs, opts) { return useWorker ? detectWorker(nowMs) : detect(nowMs, opts); },
    /** 'auto' (adaptive) | 'sync' | 'delayed' | 'live' — tests force a mode before freezing on a frame. */
    setFrameSync(p) {
      syncPref = p === 'sync' || p === 'delayed' || p === 'live' ? p : 'auto';
      if (syncPref !== 'auto' && useWorker && modeCtl.set(syncPref, performance.now())) onModeChange(syncPref);
    },
    /** Tests: attach an 8×8 grey thumbnail of the DETECTED frame to every result (metrics().lastFrameHash). */
    setFrameHash(on) { hashOn = !!on; },
    frameHash,
    startCamera,
    stopCamera() {
      wantCamera = false; camJob = null; clearTimeout(retryTimer); retryTimer = 0; camRetry.reset();
      stopStream(); try { wakeLock?.release(); } catch (e) { /* */ } wakeLock = null; emit('status', 'camera-off');
    },
    /** Toggle (or set) front/back camera. Returns startCamera() info; back camera → mirror false.
     *  No camera in use (touch mode) → only remembers the side, never turns a camera on (R2-34). */
    switchCamera(to) {
      facing = to || (facing === 'user' ? 'environment' : 'user');
      return stream || wantCamera ? startCamera() : Promise.resolve({ vw: 0, vh: 0, facing, mirror: facing === 'user' });
    },
    /** 縦 capture mode re-requests the camera with more pixels. */
    setPortrait(on) { if (portrait === !!on) return Promise.resolve(); portrait = !!on; return stream || wantCamera ? startCamera() : Promise.resolve(); },
    /** Start the detection loop. fn(result) is called for every detected frame. */
    start(fn) { if (fn) listeners.result.add(fn); if (!loopOn) { loopOn = true; loopToken++; scheduleLoop(); } },
    stop() {
      loopOn = false; loopToken++;
      if (rvfcHandle) { try { video.cancelVideoFrameCallback(rvfcHandle); } catch (e) { /* */ } rvfcHandle = 0; }
      cancelAnimationFrame(rafHandle);
      flushRing(); hist.length = 0;    // the frame on screen is in pendingFrames, not in the ring
    },
    /** on('result'|'resize'|'status'|'error'|'backend', fn) → unsubscribe() */
    on(name, fn) { listeners[name]?.add(fn); return () => listeners[name]?.delete(fn); },
    metrics() {
      const now = performance.now();
      return {
        backend: cur?.backend, delegate: cur?.delegate, numHands: cur?.numHands,
        detectMs: +m.detectMs.toFixed(2), detectFps: +m.detectFps.toFixed(1), frames: m.frames,
        handsPerFrame: m.frames ? +(m.handsSum / m.frames).toFixed(2) : 0,
        errors: m.errors, rebuilds: m.rebuilds, skipped: m.skipped, initMs: m.initMs, loadMs: m.loadMs,
        loadBytes: m.loadBytes, loadTotal: m.loadTotal,
        vw: video?.videoWidth || 0, vh: video?.videoHeight || 0,
        // camera mode chosen by upgradeCamera; detectW = width of the copy MediaPipe analyses (≤ detectLong)
        camera: camInfo ? { ...camInfo } : null, detectW: m.detW || 0, prepMs: +(m.prepMs || 0).toFixed(2),
        worker: useWorker, workerFallback, frameMode: modeCtl.mode, frameSource, modeSwitches: modeCtl.switches,
        resultRate: rate(resultTimes, now), videoFps: rate(videoTimes, now), presentRate: rate(presentTimes, now),
        latencyMs: +(m.latencyMs || 0).toFixed(1), displayDelayMs: modeCtl.mode === 'delayed' ? Math.round(delayMs()) : 0,
        heldPresentations: m.held || 0, skeletonLagMs: modeCtl.mode === 'delayed' ? +(m.lagMs || 0).toFixed(1) : modeCtl.mode === 'sync' ? 0 : null,
        gpuCheck: { ...gpuCheck },
        lastMediaTime: m.lastMt ?? null, lastFrameHash: m.lastHash ?? null,   // of the last delivered result
        // leak ledger: frames sent to the worker − closed there = in flight (0/1); handed-out frames still open
        // (≤ 3: 2 pending + the stage's); ring = buffered camera copies in 'delayed' (≤ ringMax)
        framesSent: ledger.made, framesWorkerClosed: ledger.workerClosed, framesInFlight: inflight?.posted ? 1 : 0,
        displayMade: ledger.displayMade, displayOpen: displaySet.size, ringOpen: ringSet.size, ringMax: ring.length ? ringCap(ring[0].frame) : SY.ringMax,
      };
    },
    close() {
      releaseAll(); api.stop(); stopStream();
      try { wakeLock?.release(); } catch (e) { /* */ }
      killWorker();
      flushRing(); retireFrames(0); closeTask();
      if (wasmFileset?.wasmBinaryPath?.startsWith?.('blob:')) URL.revokeObjectURL(wasmFileset.wasmBinaryPath);
      for (const k in listeners) listeners[k].clear();
    },
  };
  return api;
}
