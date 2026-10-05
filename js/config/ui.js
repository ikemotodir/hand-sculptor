// UI / capture / audio tunables. Owned by the UI and media modules.
export const UI = {
  mobileBreakpoint: 760,          // <= this width, or portrait → mobile layout (bottom toolbar)
  toastMs: 1500,
  hintMs: 3500,                   // hint chip lifetime
  showBones: true,
  mirror: true,
  sound: true,
  depth: false,                   // 奥行き (SPEC §13.4: off by default)
  quality: 'auto',
  orientation: 'landscape',       // 縦/横 capture: 'landscape' | 'portrait'
  recordSec: 15,                  // 15 | 30 | 60
  toolbarSide: 'right',           // 'right' (default, mirror view → right hand) | 'left'
  insetMin: 72,                   // toolbar inset from edges (px) …
  insetPalm: 1.5,                 // … or 1.5 × palmPx, whichever is larger
  insetMax: 140,                  // never push the toolbar further than this
  bandTop: 0.15, bandBottom: 0.70,// toolbar lives inside this vertical band
  fingerTarget: 64,               // min finger target (px) on desktop
  guideW: 276,                    // guide panel width (px, css .hs-guide-panel)
  guideMinW: 240,                 // 縦 frame on a PC: the guide goes beside the frame when the black bar holds this much
  dwellSlopPx: 6,                 // hitTest inflates every target by this much
  lockOnMs: 600,                  // overlay lock-on effect duration
  tutorialStepMs: 15000,          // auto-advance a tutorial step after this
  kioskIdleMs: 45000,
  shareUrl: 'ikemotodir.github.io/hand-sculptor',   // shown in the capture watermark (published 2026-10-05)
  opacityLevels: [0.10, 0.20, 0.40],   // 薄 / 中 / 濃 (face opacity = level × 0.35 in holo.js)
  defaultOpacity: 0.20,
  autosaveMs: 1000,
  undoDepth: 50,
  storageKeys: {
    scene: 'hs.scene.v2', settings: 'hs.settings.v2', tutorialDone: 'hs.tutorial.v2',
    hintsSeen: 'hs.hints.seen', guideOpen: 'hs.guide.open',
  },
};
