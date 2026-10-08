// PURE helpers for tracker.js (no DOM, unit-tested in tools/tests/tracker_sync.test.mjs):
//   FrameModeCtl      — adaptive 'sync' ↔ 'delayed' (or 'live') switch with hysteresis + minimum dwell
//   lerpHands         — landmark interpolation between two detection results
//   pickPresentation  — delayed-sync: which buffered camera frame to show now, and the hands for exactly it
//   workerStalled     — watchdog for a detect the worker never answers
//   RollingMedian     — GPU slowness monitor (main-thread path; the worker has its own copy)
//   ringPlan / ringCapFor — 'delayed' ring: copy size + capacity;  mainStartIdx — worker→main fallback step
//   CameraRetry       — lost-camera backoff + "tell the user once" policy
//
// Frame modes (worker path):
//   'sync'    the background is the detected frame itself (skeleton exact; video updates at the result rate)
//   'delayed' every camera frame is buffered and shown ~(latency + one result interval) late, with the hands
//             interpolated to that frame's time → smooth video at camera fps AND skeleton on the same frame
//   'live'    no frames can be kept (videoFrames 'none'): live VideoTexture, skeleton lags (last resort)

export const FRAME_SYNC_DEFAULTS = {
  liveBelow: 20, syncAbove: 24,      // results/s (also capped to 70% / 85% of the camera fps)
  liveAfterMs: 1500, syncAfterMs: 4000, minDwellMs: 5000,
  ringMax: 12,                       // buffered camera frames in 'delayed' (ImageBitmap copies, not camera buffers)
  ringBytes: 120e6,                  // … and at most this many bytes: 12 full 1920×1080 copies fit (larger ones are downscaled)
  maxDelayMs: 400,                   // never show the video later than this
  minShort: 540,                     // ring copies are never smaller than this on the short side
};

/**
 * 'delayed' ring sizing (R2-13): frames needed to cover the display delay at the camera rate (+2), and the copy
 * size at which that many frames fit into ringBytes. Full size when it fits (up to 1920×1080 / 1080×1920 with the
 * default 120 MB: the camera's full resolution is shown); larger frames are copied downscaled instead of keeping
 * only a few frames (5 frames froze the skeleton below ~12 results/s).
 * @returns {{w:number, h:number, need:number}}
 */
export function ringPlan(w, h, delayMs, fps, c = FRAME_SYNC_DEFAULTS) {
  w = w || 1280; h = h || 720;
  const rate = fps > 5 ? fps : 30;
  const need = Math.min(c.ringMax, Math.ceil(Math.min(c.maxDelayMs, Math.max(0, delayMs || 0)) * rate / 1000) + 2);
  let s = Math.min(1, Math.sqrt(c.ringBytes / (need * w * h * 4)));
  if (s < 1) s = Math.floor(s * 16) / 16;                                  // few distinct sizes (no per-frame churn)
  s = Math.min(1, Math.max(s, (c.minShort || 0) / Math.min(w, h)));
  return { w: Math.round(w * s), h: Math.round(h * s), need };
}

/** Ring capacity for frames of this size (count and bytes limits). */
export const ringCapFor = (fw, fh, c = FRAME_SYNC_DEFAULTS) =>
  Math.max(3, Math.min(c.ringMax, Math.floor(c.ringBytes / Math.max(1, (fw || 1280) * (fh || 720) * 4))));

/**
 * Main-thread fallback after the worker failed (R2-33): start where the worker already was when it had moved
 * to a CPU step (GPU too slow / slower than CPU), instead of re-testing the GPU on the render thread.
 */
export function mainStartIdx(chain, cur, gpuState) {
  const demoted = /^demoted/.test(gpuState || '') || cur?.delegate === 'CPU';
  if (!demoted) return 0;
  let i = chain.findIndex(s => s.backend === cur?.backend && s.delegate === 'CPU');
  if (i < 0) i = chain.findIndex(s => s.delegate === 'CPU');
  return Math.max(0, i);
}

/**
 * Camera recovery policy (R2-12). After the camera ended or a restart failed, next() gives the wait before the
 * next attempt (backoff; then the last delay, forever) and whether to tell the user — once per outage: at the
 * first failed restart, or when a camera keeps ending right after each start (more than maxRestarts times).
 * The count only resets after the camera ran for stableMs.
 */
export class CameraRetry {
  constructor({ delays = [600, 1000, 2000, 4000, 5000], maxRestarts = 5, stableMs = 10000 } = {}) {
    this.delays = delays.length ? delays : [1000]; this.max = maxRestarts; this.stableMs = stableMs;
    this.reset();
  }
  reset() { this.n = 0; this.okAt = 0; this.told = false; }
  /** the camera is running (start succeeded) */
  started(now) { this.okAt = now; }
  /** @returns {{delay:number, notify:boolean, attempt:number}} */
  next(now, failed = false) {
    if (this.okAt && now - this.okAt >= this.stableMs) { this.n = 0; this.told = false; }
    this.okAt = 0;
    const delay = this.delays[Math.min(this.n, this.delays.length - 1)];
    this.n++;
    const notify = !this.told && (failed || this.n > this.max);
    if (notify) this.told = true;
    return { delay, notify, attempt: this.n };
  }
}

export class FrameModeCtl {
  constructor(cfg = {}) {
    this.c = { ...FRAME_SYNC_DEFAULTS, ...cfg };
    this.mode = 'sync'; this.below = 0; this.above = 0; this.since = -Infinity; this.switches = 0;
  }
  /** Force a mode (tests / pref). Returns true when it changed. */
  set(mode, now) {
    if (mode === this.mode) return false;
    this.mode = mode; this.below = this.above = 0; this.since = now; this.switches++;
    return true;
  }
  /**
   * @param {number} now   ms
   * @param {number} r     results in the last second
   * @param {number} vfps  camera frames in the last second
   * @param {'delayed'|'live'} slow  the mode to use when detection is slow
   * @returns {string|null} the new mode when it switched, else null
   */
  update(now, r, vfps, slow = 'delayed') {
    const c = this.c, cap = vfps > 5 ? vfps : 30;
    const lo = Math.min(c.liveBelow, 0.7 * cap), hi = Math.min(c.syncAbove, 0.85 * cap);
    if (this.mode !== 'sync' && this.mode !== slow) return this.set(slow, now) ? slow : null;   // slow kind changed
    let want = this.mode;
    if (this.mode === 'sync') {
      if (r < lo) { this.below ||= now; if (now - this.below > c.liveAfterMs) want = slow; } else this.below = 0;
    } else if (r > hi) { this.above ||= now; if (now - this.above > c.syncAfterMs) want = 'sync'; } else this.above = 0;
    if (want === this.mode || now - this.since < c.minDwellMs) return null;
    this.set(want, now);
    return want;
  }
}

const lerp = (a, b, f) => a + (b - a) * f;
const lerpPts = (a, b, f) => {
  if (!a?.length || !b?.length || a.length !== b.length) return (f < 0.5 ? a : b) || [];
  return b.map((p, i) => ({ x: lerp(a[i].x, p.x, f), y: lerp(a[i].y, p.y, f), z: lerp(a[i].z || 0, p.z || 0, f) }));
};

/**
 * Hands at fraction f (0 = a, 1 = b) between two results. Hands are matched by handedness + nearest wrist
 * (normalized video units, ≤ maxWrist); unmatched hands are taken from the nearer result.
 */
export function lerpHands(a = [], b = [], f = 0, maxWrist = 0.15) {
  if (f <= 0) return a; if (f >= 1) return b;
  const used = new Set(), out = [];
  const matchOf = hb => {
    let best = -1, bd = maxWrist;
    a.forEach((ha, i) => {
      if (used.has(i) || ha.handed !== hb.handed || !ha.lm?.[0] || !hb.lm?.[0]) return;
      const d = Math.hypot(ha.lm[0].x - hb.lm[0].x, ha.lm[0].y - hb.lm[0].y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  for (const hb of b) {
    const i = matchOf(hb);
    if (i < 0) { if (f >= 0.5) out.push(hb); continue; }
    used.add(i);
    const ha = a[i];
    out.push({
      lm: lerpPts(ha.lm, hb.lm, f), wl: lerpPts(ha.wl, hb.wl, f), handed: hb.handed,
      handScore: lerp(ha.handScore ?? 0, hb.handScore ?? 0, f), canned: f < 0.5 ? ha.canned : hb.canned,
      // the OLDER result's id: the newer one counts as a new detection only once it is reached (R2-5)
      src: ha.src,
    });
  }
  if (f < 0.5) a.forEach((ha, i) => { if (!used.has(i)) out.push(ha); });
  return out;
}

/**
 * Delayed-sync presentation.
 * @param {{mt:number}[]} ring   buffered camera frames, ascending mt (seconds)
 * @param {{mt:number, hands:any[]}[]} hist  recent detection results, ascending mt
 * @param {number} targetMt  media time to show now (latest camera mt − delay)
 * @param {number} lastMt    media time last shown (never go back / repeat)
 * @param {number} [maxGap=0.5]  seconds; results further apart are not interpolated (nearest is used)
 * @param {boolean} [forceOldest=false]  the ring is full: show its oldest unshown frame even if newer than target
 * @returns {{idx:number, mt:number, hands:any[], f:number|null, held:boolean, lag:number}|null}
 */
export function pickPresentation(ring, hist, targetMt, lastMt, maxGap = 0.5, forceOldest = false) {
  if (!ring.length || !hist.length) return null;
  // never show a frame newer than the newest result: the skeleton would have to be held (drift). Instead the
  // video waits for the result (the delay adapts to the real latency), unless the ring is full.
  const tgt = Math.min(targetMt, hist[hist.length - 1].mt);
  let idx = -1, first = -1;
  for (let i = 0; i < ring.length; i++) {
    if (ring[i].mt <= lastMt) continue;
    if (first < 0) first = i;
    if (ring[i].mt <= tgt) idx = i; else break;
  }
  // every unshown frame is newer than the target: wait, unless the ring is full (then the delay is ring-limited)
  if (idx < 0) { if (!forceOldest || first < 0) return null; idx = first; }
  const mt = ring[idx].mt;
  let a = null, b = null;
  for (const h of hist) { if (h.mt <= mt) a = h; else { b = h; break; } }
  let hands, f = null, held = false;
  if (a && a.mt === mt) hands = a.hands;
  else if (a && b && b.mt - a.mt <= maxGap) { f = (mt - a.mt) / (b.mt - a.mt); hands = lerpHands(a.hands, b.hands, f); }
  else if (a && b) hands = (mt - a.mt <= b.mt - mt ? a : b).hands;
  else if (a) { hands = a.hands; held = true; }
  else hands = b.hands;
  // lag = how far the skeleton is behind the frame (s): 0 when exact/interpolated, > 0 when held
  return { idx, mt, hands, f, held, lag: held ? mt - a.mt : 0 };
}

/** A detect posted to the worker and not answered within this window means the worker is stuck. */
export function workerStalled(sentAt, now, detectMs, frames) {
  if (!sentAt) return false;
  const limit = frames ? Math.max(4000, 20 * (detectMs || 0)) : 20000;   // first detections compile shaders
  return now - sentAt > limit;
}

/** Fixed-size rolling window with median; check() every `every` samples once full. */
export class RollingMedian {
  constructor(size = 20, every = 5) { this.size = size; this.every = every; this.win = []; this.n = 0; }
  push(v) { this.win.push(v); if (this.win.length > this.size) this.win.shift(); this.n++; return this.ready(); }
  ready() { return this.win.length >= this.size && this.n % this.every === 0; }
  median() { const s = this.win.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; }
  reset() { this.win = []; this.n = 0; }
}

// ── self-healing detection chain (2026-10-08: iPhone showed the camera but never a skeleton) ─────────────
/**
 * Detection strategies, tried in order until one is HEALTHY (HealthCheck):
 *   a  W-VF   worker + VideoFrame transfer (fastest; Chrome desktop/Android)
 *   b  W-BM   worker + ImageBitmap drawn from a 2D canvas (most compatible capture; iOS starts here, CPU delegate)
 *   c  M-VID  main thread + the <video> element itself handed to MediaPipe (no frame copies; live video texture)
 * Reason codes: `${code}-${reason}` (W-VF-timeout, W-BM-black, M-VID-error, …).
 */
export const STRATEGIES = {
  a: { key: 'a', code: 'W-VF', worker: true, capture: 'vf' },
  b: { key: 'b', code: 'W-BM', worker: true, capture: 'canvas' },
  c: { key: 'c', code: 'M-VID', worker: false, capture: 'video' },
};

/** iOS (any browser: all are WebKit) or Safari itself (UA "Safari/" without Chrome/Edge/Opera/Android). */
export function appleBrowser(ua = '') {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/.test(ua);
}

/**
 * Camera-side picture controls (config media.camera.tune, desktop only). Pure: decides WHAT to apply, tracker.js
 * applies it once. Each key of `tune` (sharpness, contrast, saturation, brightness) is a fraction 0–1 of the track's
 * own capability range {min, max[, step]}; the resulting value is rounded to the step and clamped. Returns the
 * constraint set for applyConstraints({advanced:[set]}) or null when nothing should be touched:
 * iOS/Safari or any phone/tablet (a mid-stream applyConstraints can freeze/blacken the feed there), no tune config,
 * a control the camera does not expose, or a value the camera already has.
 * @param {object} caps     track.getCapabilities()
 * @param {object} settings track.getSettings()
 * @param {object} tune     e.g. { sharpness: 0.4 }
 * @param {{apple?:boolean, mobile?:boolean}} env
 */
export function cameraTune(caps, settings, tune, { apple = false, mobile = false } = {}) {
  if (apple || mobile || !tune || typeof tune !== 'object' || !caps || typeof caps !== 'object') return null;
  const out = {};
  for (const [k, frac] of Object.entries(tune)) {
    const r = caps[k];
    if (typeof frac !== 'number' || !isFinite(frac) || !r || typeof r !== 'object') continue;
    const min = Number(r.min), max = Number(r.max);
    if (!isFinite(min) || !isFinite(max) || max <= min) continue;
    const step = Number(r.step) > 0 ? Number(r.step) : 1;
    const f = Math.min(1, Math.max(0, frac));
    let v = min + Math.round((max - min) * f / step) * step;
    v = Math.min(max, Math.max(min, +v.toFixed(6)));
    const cur = settings && typeof settings[k] === 'number' ? settings[k] : null;
    if (cur != null && Math.abs(cur - v) < step / 2) continue;   // already there
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Ordered strategy keys for this device.
 * @param {object} o
 * @param {'a'|'b'|'c'|null} [o.forced]   ?cfg.media.tracker.strategy / createTracker({strategy}): start here
 * @param {boolean} [o.apple]             iOS / Safari → start at b (MediaPipe GPU in Safari workers is unreliable;
 *                                        VideoFrame transfer to a worker is not)
 * @param {boolean} [o.workerOk]          Worker + OffscreenCanvas available (tracker.js workerSupport)
 * @param {boolean} [o.hasVideoFrame]     typeof VideoFrame === 'function'
 * @param {boolean} [o.noWorker]          ?worker=0 / config worker:false → main thread only
 */
export function strategyPlan({ forced = null, apple = false, workerOk = true, hasVideoFrame = true, noWorker = false } = {}) {
  const all = ['a', 'b', 'c'];
  if (noWorker || !workerOk) return ['c'];
  let keys = (apple || !hasVideoFrame) ? ['b', 'c'] : all;
  if (forced && STRATEGIES[forced]) keys = all.slice(all.indexOf(forced));
  return keys;
}

/** mean grey level (0–255) of an 8×8 thumbnail (tracker frameHash), or null */
export function meanLum(hash) {
  if (!hash || !hash.length) return null;
  let s = 0; for (const v of hash) s += v;
  return s / hash.length;
}

/**
 * Per-strategy health check, two phases. arm(now, delegate) when the strategy's task is ready AND camera frames
 * flow. (1) The FIRST result must arrive within firstMs[delegate] (the GPU delegate compiles shaders on its first
 * detection: measured 3–8 s on an Intel UHD in headless Chrome; CPU starts in ~1 s). (2) From that first result,
 * minResults results (hands or not) within windowMs, and lumSamples of them (taken ≥ lumAfterMs after arming:
 * cameras open dark) must not all be black (mean grey < blackLum) → verdict 'ok' | 'black'; tick(now) past either
 * budget → 'timeout'. Frames whose brightness cannot be measured count as not-black.
 */
export class HealthCheck {
  constructor({ windowMs = 4000, firstMs = { GPU: 12000, CPU: 6000 }, minResults = 3, lumSamples = 3, blackLum = 8, lumAfterMs = 500 } = {}) {
    this.windowMs = windowMs; this.firstMs = { GPU: 12000, CPU: 6000, ...(firstMs || {}) };
    this.minResults = minResults; this.lumSamples = lumSamples; this.blackLum = blackLum; this.lumAfterMs = lumAfterMs;
    this.reset();
  }
  reset() { this.on = false; this.armedAt = 0; this.firstAt = 0; this.delegate = 'GPU'; this.results = 0; this.lums = []; this.lumFail = 0; this.verdict = null; this.mean = null; }
  arm(now, delegate = 'GPU') { this.reset(); this.on = true; this.armedAt = now; this.delegate = delegate === 'CPU' ? 'CPU' : 'GPU'; }
  /** armed and undecided (after a verdict: false until the next arm()) */
  get armed() { return this.on && !this.verdict; }
  /** should the next result carry a brightness sample? */
  wantLum(now) { return this.armed && this.lums.length < this.lumSamples && now - this.armedAt >= this.lumAfterMs; }
  /** @returns {'ok'|'black'|null} */
  result(now, lum = null) {
    if (!this.armed) return null;
    this.results++;
    if (!this.firstAt) this.firstAt = now;
    if (now - this.armedAt >= this.lumAfterMs && this.lums.length < this.lumSamples) {
      if (lum != null && Number.isFinite(lum)) this.lums.push(lum); else this.lumFail++;
    }
    if (this.results < this.minResults) return null;
    if (this.lums.length < this.lumSamples && this.lumFail < this.lumSamples) return null;   // samples pending (tick() covers a stall)
    this.mean = this.lums.length ? this.lums.reduce((a, b) => a + b, 0) / this.lums.length : null;
    this.verdict = this.lums.length === this.lumSamples && this.mean < this.blackLum ? 'black' : 'ok';
    return this.verdict;
  }
  /** @returns {'timeout'|null} */
  tick(now) {
    if (!this.armed) return null;
    const over = this.firstAt ? now - this.firstAt > this.windowMs : now - this.armedAt > (this.firstMs[this.delegate] ?? 12000);
    if (!over) return null;
    this.verdict = 'timeout';
    return 'timeout';
  }
}
