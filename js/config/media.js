// Tracker / capture / audio / storage tunables. Owned by the media modules.
// 'auto' values are resolved at runtime (desktop vs mobile, GPU vs CPU) — see tracker.js.
export const MEDIA = {
  tracker: {
    backend: 'auto',        // 'auto' (desktop: gesture, mobile: landmarker) | 'gesture' | 'landmarker'
    delegate: 'auto',       // 'auto' (try GPU, then CPU) | 'GPU' | 'CPU'   (headless tests: ?cfg.media.tracker.delegate=CPU)
    numHands: 'auto',       // 'auto' (desktop+GPU 4, else 2) | number
    videoFrames: 'auto',    // 'auto' (VideoFrame if supported, else ImageBitmap) | 'bitmap' | 'none' (no frame returned)
    maxRebuilds: 4,         // detect errors → rebuild; after this many in a row → fatal error event
    worker: true,           // detection in tracker.worker.js (false → main thread; also ?worker=0)
    workerInitMs: 45000,    // worker not ready within this → main thread
    // adaptive frame mode (tracker-sync.js): results/s below liveBelow for liveAfterMs → 'delayed' (buffered video
    // shown ~latency late, hands interpolated); above syncAbove for syncAfterMs → 'sync'; ≥ minDwellMs between switches
    // ring copies stay full size up to 1920×1080 (12 × 8.3 MB fits ringBytes); only larger frames are downscaled (ringPlan)
    frameSync: { liveBelow: 20, syncAbove: 24, liveAfterMs: 1500, syncAfterMs: 4000, minDwellMs: 5000, ringMax: 12, ringBytes: 120e6, maxDelayMs: 400, minShort: 540 },
    // MediaPipe gets a copy with this long side at most (worker + main thread); the screen keeps the full camera frame.
    // Landmarks are normalized, so the mapping is unchanged. 0 = no downscale.
    detectLong: 960,
    // local server only (server.mjs answers /api/info): POST a small diagnostics JSON to /api/diag → launcher/diag.json
    diagMs: 10000,
    // GPU delegate check: skip `warmup` detections, median of `samples` > maxMs → CPU; else a CPU calibration
    // (cpuSamples) and GPU > ratio × CPU → CPU. Afterwards a rolling median of `watch` detections keeps checking.
    gpuCheck: { warmup: 10, samples: 20, maxMs: 150, ratio: 1.5, cpuSamples: 6, watch: 20 },
  },
  camera: {
    width: 1280, height: 720, frameRate: 30,  // first request (safe everywhere) …
    portraitWidth: 1920, portraitHeight: 1080, // 縦 capture mode asks for more pixels
    // … then raised to the camera's largest mode within maxLong × maxShort (its own aspect, no crop) while keeping
    // ≥ minFps (tracker.js upgradeCamera). Kept as it was when the camera cannot do more or the fps would drop.
    maxLong: 1920, maxShort: 1080, mobileMaxLong: 1920, mobileMaxShort: 1080, minFps: 24, upgrade: true,
    // lost camera (unplugged, OS toggle, driver reset): retry after restartDelayMs, then retryDelaysMs (the last one
    // repeats while the page is visible; also on visibilitychange / devicechange). The user is told once per outage.
    restartDelayMs: 600, retryDelaysMs: [1000, 2000, 4000, 5000], maxRestarts: 5, stableMs: 10000,
  },
  // 横 photo/video = the camera's own resolution over the stage (capture.js landscapeScale): long ≤ desktopLong /
  // mobileLong; video short side in [minShort, maxShort]. bitrate = at 1920×1080, scaled by pixel count (≥ minBitrate).
  record: { defaultSec: 15, maxSec: 60, bitrate: 12_000_000, minBitrate: 3_000_000, desktopLong: 1920, mobileLong: 1280, maxShort: 1080, minShort: 720, fps: 30, timesliceMs: 1000 },
  photo: { countdownSec: 3 },
  capture: { orientation: 'landscape', trayMax: 8, portraitW: 1080, portraitH: 1920, thumbLong: 240 },   // 'landscape' | 'portrait' (9:16)
  watermark: { title: 'HAND SCULPTOR', url: '', x: 0.044, y: 0.088, font: 0.031, opacity: 0.85 },     // url filled in when published
  masterGain: 0.25,
};
