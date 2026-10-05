// MediaPipe hand detection in a dedicated CLASSIC worker (the ESM bundle cannot load its wasm loader inside
// module workers: "ModuleFactory not set"). Started by tracker.js; every URL arrives absolute in 'init'.
//
// main → worker
//   {t:'init', bundleUrl, fileset:{wasmLoaderPath, wasmBinaryPath}, models:{backend:Uint8Array}, modelUrls,
//    chain:[{backend,delegate}], forceDelegate, hands:{GPU,CPU}, conf:{minDetection,minPresence,minTracking},
//    gpuCheck:{warmup,samples,maxMs,ratio,cpuSamples}, maxRebuilds, detectLong}
//   {t:'detect', seq, frame (VideoFrame|ImageBitmap, transferred), ts, hash?:boolean}
//   {t:'close'}
// worker → main
//   {t:'ready', cur, initMs} | {t:'initError', message}
//   {t:'result', seq, hands, vw, vh, ms, prepMs, dw, ts, cur, check, hash?}   (vw/vh = the camera frame; dw = width MediaPipe saw) | {t:'skip', seq, reason, message?}   (every detect is answered once)
//   {t:'backend', cur, initMs, reason} | {t:'gpuCheck', ...} | {t:'fatal', message} | {t:'closedFrames', n}
// The worker closes every frame it receives, exactly once (counted in `closed`, reported with each answer).
/* global Vision, importScripts */
'use strict';

let V = null, cfg = null;
let task = null, cur = null, chainIdx = 0;
let lastTs = 0, rebuildsInRow = 0, rebuilding = null, closedAll = false, pendingDemote = null;
let closed = 0;                     // frames closed by the worker (leak accounting)
const models = {};
// GPU sanity check (replaces the absolute "slow GPU" threshold): ignore warm-up, median of N samples, a short
// CPU calibration - and afterwards a rolling median keeps watching (the GPU can degrade later: contention with
// the renderer, thermal throttling). Demotion is one-way (never back to GPU) -> no flip-flop.
let gpu = null;                      // {phase:'warmup'|'measure'|'calibrating'|'watch', n, samples, cpuTask, cpuSamples, win, wn}
const check = { state: 'n/a', gpuMedMs: 0, cpuMedMs: 0, watchMedMs: 0 };

const post = (m, tr) => self.postMessage(m, tr || []);
const closeFrame = f => { if (!f) return; try { f.close(); } catch (e) { /* */ } closed++; };
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

async function loadModel(backend) {
  if (!models[backend]) {
    const r = await fetch(cfg.modelUrls[backend]);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${cfg.modelUrls[backend]}`);
    models[backend] = new Uint8Array(await r.arrayBuffer());
  }
  return models[backend];
}

async function createTask(step, numHands) {
  const bytes = await loadModel(step.backend);
  const C = cfg.conf;
  const opts = {
    baseOptions: { modelAssetBuffer: bytes, delegate: step.delegate },
    runningMode: 'VIDEO', numHands,
    minHandDetectionConfidence: C.minDetection, minHandPresenceConfidence: C.minPresence, minTrackingConfidence: C.minTracking,
  };
  // R3-5: always hand MediaPipe a canvas. Without one it sniffs the UA, and on iOS Chrome / Firefox / in-app
  // browsers ("Safari" without "Chrome" or "Version/17+") it calls document.createElement → throws in a worker.
  if (typeof OffscreenCanvas === 'function') opts.canvas = new OffscreenCanvas(1, 1);
  const Cls = step.backend === 'gesture' ? V.GestureRecognizer : V.HandLandmarker;
  return Cls.createFromOptions(cfg.fileset, opts);
}

function closeTask(t) { try { t?.close(); } catch (e) { /* */ } }

async function buildFrom(idx, reason) {
  let lastErr = null;
  for (let i = idx; i < cfg.chain.length; i++) {
    const step = cfg.chain[i];
    const t0 = performance.now();
    try {
      const numHands = cfg.hands[step.delegate];
      const t = await createTask(step, numHands);
      closeTask(task);
      task = t; cur = { ...step, numHands }; chainIdx = i;
      lastTs = Math.max(lastTs, performance.now());
      if (gpu?.cpuTask) closeTask(gpu.cpuTask);
      gpu = (step.delegate === 'GPU' && !cfg.forceDelegate) ? { phase: 'warmup', n: 0, samples: [], cpuTask: null, cpuSamples: [], win: [], wn: 0 } : null;
      if (gpu) check.state = 'warmup';
      const initMs = Math.round(performance.now() - t0);
      if (reason) post({ t: 'backend', cur, initMs, reason });
      return { cur, initMs };
    } catch (e) {
      lastErr = e;
      console.warn(`[tracker.worker] ${step.backend}/${step.delegate} failed`, e?.message || e);
    }
  }
  throw new Error('no backend could start: ' + (lastErr?.message || lastErr));
}

function toHands(res) {
  const out = [];
  const lms = res.landmarks || [];
  const pts = a => (a || []).map(p => ({ x: p.x, y: p.y, z: p.z }));
  for (let i = 0; i < lms.length; i++) {
    const h = res.handedness?.[i]?.[0] || res.handednesses?.[i]?.[0];
    const g = res.gestures?.[i]?.[0];
    out.push({
      lm: pts(lms[i]), wl: pts(res.worldLandmarks?.[i]),
      handed: h?.categoryName === 'Left' ? 'Left' : 'Right', handScore: h?.score ?? 0,
      canned: g ? { name: g.categoryName, score: g.score } : null,
    });
  }
  return out;
}

const run = (t, backend, src, ts) => backend === 'gesture' ? t.recognizeForVideo(src, ts) : t.detectForVideo(src, ts);

function nextTs(ts) { const v = Math.max(ts, lastTs + 1); lastTs = v; return v; }

const cpuIndex = () => cfg.chain.findIndex((st, i) => i > chainIdx && st.delegate === 'CPU');

/** GPU check: warm-up ignored, then median of `samples`; > maxMs -> CPU; else a short CPU calibration on the
 *  next frames (results used normally) and demote when gpu > ratio x cpu; then keep watching (rolling median). */
function gpuSample(dt) {
  const G = cfg.gpuCheck, g = gpu;
  g.n++;
  if (g.phase === 'warmup') { if (g.n > G.warmup) g.phase = 'measure'; else return; }
  if (g.phase === 'measure') {
    g.samples.push(dt);
    if (g.samples.length < G.samples) { check.state = 'measuring'; return; }
    check.gpuMedMs = +median(g.samples).toFixed(1);
    const cpuIdx = cpuIndex();
    if (cpuIdx < 0) { check.state = 'kept-gpu'; gpu = null; post({ t: 'gpuCheck', ...check }); return; }
    if (check.gpuMedMs > G.maxMs) { check.state = 'demoted-slow'; demote(cpuIdx, 'gpu-slow'); return; }
    check.state = 'calibrating';
    g.phase = 'calibrating';
    // same numHands as the GPU task, so calibration frames keep every hand
    createTask(cfg.chain[cpuIdx], cfg.hands.GPU).then(t => {
      if (closedAll || gpu !== g || g.phase !== 'calibrating') { closeTask(t); return; }   // rebuilt meanwhile
      g.cpuTask = t; g.cpuStep = cfg.chain[cpuIdx]; g.cpuIdx = cpuIdx;
    }).catch(e => {
      console.warn('[tracker.worker] CPU calibration task failed', e?.message || e);
      if (gpu !== g) return;
      check.state = 'kept-gpu'; g.phase = 'watch'; post({ t: 'gpuCheck', ...check });
    });
    return;
  }
  if (g.phase !== 'watch') return;   // calibrating: GPU timings while the CPU task builds are not used
  g.win.push(dt); if (g.win.length > G.watch) g.win.shift();
  g.wn++;
  if (g.win.length < G.watch || g.wn % 5) return;
  const med = median(g.win);
  check.watchMedMs = +med.toFixed(1);
  if (med > G.maxMs || (check.cpuMedMs > 0 && med > G.ratio * check.cpuMedMs)) {
    const cpuIdx = cpuIndex();
    if (cpuIdx < 0) return;
    check.state = 'demoted-watch';
    demote(cpuIdx, 'gpu-degraded');
  }
}

function cpuCalibrationDone() {
  const G = cfg.gpuCheck, g = gpu;
  check.cpuMedMs = +median(g.cpuSamples.slice(1)).toFixed(1);   // first CPU run = warm-up
  const { cpuTask, cpuStep, cpuIdx } = g;
  g.cpuTask = null;
  if (check.gpuMedMs > G.ratio * check.cpuMedMs) {
    // adopt the already-built CPU task (built with the GPU hand count)
    closeTask(task);
    task = cpuTask; cur = { ...cpuStep, numHands: cfg.hands.GPU }; chainIdx = cpuIdx; gpu = null;
    check.state = 'demoted-ratio';
    post({ t: 'backend', cur, initMs: 0, reason: 'gpu-slower-than-cpu' });
  } else {
    closeTask(cpuTask);
    g.phase = 'watch';
    check.state = 'kept-gpu';
  }
  post({ t: 'gpuCheck', ...check });
}

function demote(idx, reason) {
  if (rebuilding) { pendingDemote = { idx, reason }; return; }   // retried when the rebuild finishes
  console.warn(`[tracker.worker] GPU delegate slow (${reason}: median ${check.watchMedMs || check.gpuMedMs} ms) -> CPU`);
  post({ t: 'gpuCheck', ...check });
  rebuilding = buildFrom(idx, reason).catch(e => post({ t: 'fatal', message: String(e?.message || e) })).finally(afterRebuild);
}

function afterRebuild() {
  rebuilding = null;
  const p = pendingDemote; pendingDemote = null;
  if (p && !closedAll && cur?.delegate === 'GPU') demote(p.idx, p.reason);
}

function rebuild(err) {
  if (rebuilding) return;
  rebuildsInRow++;
  const next = rebuildsInRow <= 1 ? chainIdx : Math.min(chainIdx + 1, cfg.chain.length - 1);
  closeTask(task); task = null;
  rebuilding = buildFrom(next, 'detect-error: ' + (err?.message || err))
    .catch(e => post({ t: 'fatal', message: String(e?.message || e) }))
    .finally(afterRebuild);
}

let hashCv = null;
/** 8x8 grey thumbnail (tests: frame identity between the detected frame and the one on screen) */
function frameHash(f) {
  try {
    hashCv ||= new OffscreenCanvas(8, 8);
    const g = hashCv.getContext('2d', { willReadFrequently: true });
    g.drawImage(f, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data, out = [];
    for (let i = 0; i < d.length; i += 4) out.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
    return out;
  } catch (e) { return null; }
}

let scaleOk = true;                 // createImageBitmap(frame, {resize…}) works here
/** detection copy size: long side <= cfg.detectLong (same aspect), or null when the frame is small enough */
function detectSize(w, h) {
  const L = cfg?.detectLong || 0;
  if (!L || !w || !h || Math.max(w, h) <= L) return null;
  const k = L / Math.max(w, h);
  return { w: Math.max(2, Math.round(w * k)), h: Math.max(2, Math.round(h * k)) };
}

async function detect({ seq, frame, ts, hash }) {
  if (closedAll || !task || rebuilding) { closeFrame(frame); post({ t: 'skip', seq, reason: 'busy', closed }); return; }
  const vw = frame.displayWidth || frame.width, vh = frame.displayHeight || frame.height;
  const hv = hash ? frameHash(frame) : null;
  // a big camera frame (1080p) is detected on a downscaled copy: MediaPipe's cost stays that of ~960 px, and the
  // normalized landmarks map onto the full frame (same aspect). The camera frame is released right away.
  let src = frame, small = null, prepMs = 0;
  const sz = scaleOk && detectSize(vw, vh);
  if (sz) {
    const tp = performance.now();
    try { small = await createImageBitmap(frame, { resizeWidth: sz.w, resizeHeight: sz.h, resizeQuality: 'medium' }); src = small; }
    catch (e) { scaleOk = false; small = null; }
    prepMs = performance.now() - tp;
    if (small) closeFrame(frame);
    if (closedAll || !task || rebuilding) {
      try { small?.close(); } catch (e) { /* */ }
      if (!small) closeFrame(frame);
      post({ t: 'skip', seq, reason: 'busy', closed }); return;
    }
  }
  const dw = small ? sz.w : vw;      // width MediaPipe analyses (metrics)
  const release = () => { if (small) { try { small.close(); } catch (e) { /* */ } small = null; } else closeFrame(frame); };
  const t0 = performance.now();
  let res, useCpuCal = false;
  try {
    // during CPU calibration, alternate: the CPU task analyses the frame (its result is used normally)
    if (gpu?.cpuTask) {
      useCpuCal = true;
      res = run(gpu.cpuTask, gpu.cpuStep.backend, src, nextTs(ts));
    } else {
      res = run(task, cur.backend, src, nextTs(ts));
    }
  } catch (e) {
    release();
    if (useCpuCal) { closeTask(gpu.cpuTask); gpu.cpuTask = null; gpu.phase = 'watch'; check.state = 'kept-gpu'; post({ t: 'skip', seq, reason: 'calibration-error', closed }); return; }
    const fatal = rebuildsInRow >= cfg.maxRebuilds;
    post({ t: 'skip', seq, reason: 'error', message: String(e?.message || e), fatal, closed });
    if (!fatal) rebuild(e);
    return;
  }
  const ms = performance.now() - t0;
  release();
  rebuildsInRow = 0;
  // during calibration the result comes from the CPU task: report that step (same hand count as the GPU task)
  const rc = useCpuCal ? { ...gpu.cpuStep, numHands: cfg.hands.GPU } : cur;
  if (useCpuCal) { gpu.cpuSamples.push(ms); if (gpu.cpuSamples.length >= cfg.gpuCheck.cpuSamples) cpuCalibrationDone(); }
  else if (gpu) gpuSample(ms);
  post({ t: 'result', seq, hands: toHands(res), vw, vh, ms, prepMs, dw, ts, closed, cur: rc, check: { ...check }, hash: hv });
}

// a message (e.g. a transferred frame) that cannot be deserialized here: the main thread would wait forever
self.onmessageerror = () => post({ t: 'fatal', message: 'messageerror' });

self.onmessage = async (e) => {
  const m = e.data;
  if (m.t === 'detect') return detect(m);
  if (m.t === 'init') {
    cfg = m;
    try {
      importScripts(m.bundleUrl);
      V = self.Vision;
      if (!V?.FilesetResolver) throw new Error('vision bundle did not define Vision');
      Object.assign(models, m.models || {});
      const r = await buildFrom(0);
      post({ t: 'ready', ...r, check: { ...check } });
    } catch (err) {
      post({ t: 'initError', message: String(err?.message || err) });
    }
    return;
  }
  if (m.t === 'close') {
    closedAll = true;
    closeTask(task); task = null;
    if (gpu?.cpuTask) closeTask(gpu.cpuTask);
    gpu = null;
    self.close();
  }
};
