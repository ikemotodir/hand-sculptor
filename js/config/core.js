// Hand pipeline tunables (tracker, filters, classifier, hand tracking, alchemy, interaction).
// Owned by the core-logic module. Tuned on tools/data/demo_landmarks*.json with `node tools/replay.mjs`
// (labels: tools/data/labels.json). "palm" = palmPx = pxPerM × 0.075 (rotation-robust hand scale, SPEC §13.2);
// every distance / speed threshold below is in palm units unless it says px.
export const CORE = {
  tracker: {
    backend: 'gesture',            // 'gesture' (GestureRecognizer) | 'landmarker'
    delegate: 'GPU',               // 'GPU' | 'CPU' (tests force CPU)
    numHands: 2,                   // fallback when the tracker cannot decide
    numHandsDesktop: 4,            // desktop + GPU (SPEC §13.2); the core logic handles up to 4 hands
    numHandsMobile: 2,             // mobile or CPU
    minDetection: 0.6, minPresence: 0.6, minTracking: 0.5,
  },
  // One Euro, screen px — INTERACTION filter (grab / hover / rotate). Grid search on the demo: index tip in still
  // windows 2.9 px raw → 0.85 px, median lag on fast moves 26 ms (targets < 1.5 px, < 50 ms). Betas are for a
  // 720 px tall video display; handtrack divides them by (display height / 720) so px behaviour is size-independent.
  filter: { minCutoff: 0.5, beta: 0.007, dCutoff: 1.0 },
  // One Euro, screen px — DISPLAY filter for the overlay skeleton (SPEC §13.5 fixed: light, stays on the frame; 5 ms lag).
  displayFilter: { minCutoff: 4.0, beta: 0.05, dCutoff: 1.0 },
  // One Euro, world meters — consumers only; classification uses RAW world landmarks + debounce (no added lag).
  worldFilter: { minCutoff: 3.0, beta: 2.0, dCutoff: 1.0 },
  // One Euro on pxPerM (SPEC §13.2 minCutoff 0.5); single-frame scale glitches (×2 on the demo) are also rejected.
  scaleFilter: { minCutoff: 0.5, beta: 0.002, dCutoff: 1.0 },
  classify: {
    extR: 1.45, curlR: 1.20,       // R_f = |tip−wrist|/|mcp−wrist|: demo is bimodal (fist ≈0.8, open ≈1.7) — SPEC values held
    newTrackR: 1.33,               // dead-band start state of a new track (SPEC)
    curlBend: 1.9,                 // PIP+DIP > 1.9 rad overrides an R in (1.20, 1.45) to curled (demo: R/bend agree 84%)
    thumbStraight: 0.6,            // thumbup needs thumb bend < 0.6 rad (SPEC)
    thumbUpMargin: 0.3,            // thumb tip above every finger joint by 0.3 palm (SPEC)
    thumbUpConeDeg: 45,            // thumb 2→4 within 45° of screen-up (SPEC)
    thumbExtBend: 0.9, thumbExtAway: 0.75,   // thumb "out" for 'spread': bend < 0.9 rad and |4−5| > 0.75·palmSize
    spreadDeg: 35, pointDeg: 20,   // angle(2→4, 5→8): > 35° spread, < 20° point, between keeps the previous (SPEC)
    cannedMin: 0.7, cannedThumbMin: 0.6,
  },
  // Pinch onset: min(raw, 30 ms EMA) < enter for 2 frames (raw alternates 0.22/0.31 inside a held pinch on the demo).
  // enter 0.30: open hands never go below 0.32 on the demo. exit 0.42: held pinches stay 0.17–0.39.
  // indexReachMin 0.55: a fist has its thumb on the folded index (ratio ≈ 0.2) — the folded index blocks the pinch.
  pinch: { enter: 0.30, exit: 0.42, smoothMs: 30, onsetFrames: 2, releaseFrames: 2, releaseMs: 50, indexReachMin: 0.55 },
  // Debounces are max(ms, frames) (SPEC §13.2). Demo: 1.3 debounced pose switches per hand-second.
  debounce: { poseMs: 90, poseFrames: 3, actionPoseMs: 150, actionFrames: 4, thumbupMs: 250, thumbupFrames: 4 },
  identity: {
    maxJumpPalm: 3,                // max palm-center jump per elapsed frame (SPEC)
    graceMs: 300,                  // lost tracks kept (lost:true) this long = SPEC §13.4 grab hold; same id on return
    gapResetFrames: 4,             // no update() for max(graceMs, 4 result intervals) = results stopped → drop all tracks (R3-10)
    handedScoreMin: 0.8,           // a confident handedness mismatch blocks a match only if it also jumps ≥ 1 palm:
    handedJumpPalm: 1.0,           //   the demo flips L0.97↔R0.95 on the same still hand (1.6–2.4 s)
    scaleRatio: [0.75, 1.33],      // pxPerM ratio gate (SPEC); a mismatch at < 0.6 palm = glitch frame, same hand
    dupPalm: 0.35,                 // same-handed detections < 0.35 palm apart = one hand (removes the demo's 3 duplicates)
    mergeSuspectPalm: 2, mergeClearPalm: 3, mergeSuspectMs: 3000,   // SPEC §13.2
  },
  alchemy: {
    closePalm: 2.2,                // ARM distance (SPEC §13.3)
    closeMs: 250,                  // path (a): both visible, flat, palms facing, close this long (SPEC)
    maxNz: 0.75,                   // path (a) palms facing / edge-on: |n.z| < 0.75 (SPEC 0.5; demo's close frames reach 0.72)
    mergeWindowMs: 1200,           // path (b): one hand alone on the midpoint within this window (SPEC)
    mergeCenterPalm: 1.0,          //   …within 1 palm of the current midpoint (SPEC)
    appearMs: 120,                 // path (b'): joined palms undetected (demo 0.7–1.5 s, 31.0–31.2 s) → both hands appear together close
    lateMergeMaxPalm: 8,           // path (c) fast clap: the pair is first seen already apart (≤ 8 palm; a child at arm's
                                   //   length reads 7–7.5 palm, long data 226.9 s) right after a blob…
    lateMergeWindowMs: 800,        //   …seen ≤ 800 ms ago (demo E1: blob 1.20 s, both hands open by 1.67 s)
    freshMs: 500,                  //   …and a pair member was undetected within the last 500 ms (long data 121.6 s: a
                                   //   merge arm on a ghost pair ate 600 ms; 300 ms then missed the real spread)
    looseScaleRatio: [0.6, 1.67],  // merge/clap arm: joined palms give a bad world scale for a few frames
    flatRecentMs: 150,             // commit: each hand open once since arm AND one open within 150 ms (demo 7.3–8 s: a
                                   //   hand pushed toward the camera reads as curled) — two fists never commit
    commitPalm: 3.5, maxPalm: 7,   // SPEC; palmRef re-frozen once both hands open (joined palms inflate it by 25%)
    stallMs: 150, stallPalm: 0.3,  // "stopped opening" = grew < 0.3 palm in 150 ms (< 2 palm/s); the demo keeps drifting
                                   //   apart slowly after the spread, so a max-based stall fired 0.8 s late
    commitLateMs: 500,             // no commit within 500 ms of first reaching commitPalm → cancel ('late')
    growMaxMs: 1500,               // growing longer than this = drifting, not 合掌→ひらく (killed a 3 s late spawn)
    dropCommitFrac: 0.75,          // a hand drops while dist ≥ 0.75·commit and still increasing → commit (SPEC)
    symmetricFrac: 0.3,            // each hand moved ≥ 30% of the spread from the arm midpoint (SPEC)
    graceMs: 350,                  // alchemy's own dropout tolerance, extrapolated ≤ 1 palm (SPEC)
    armTimeoutMs: 2500, cooldownMs: 700,
    lockoutMs: 1000,               // after a GRAB release / two-hand end (a pinch that grabbed nothing does not lock)
    scaleRatio: [0.8, 1.25], maxDyPalm: 0.8,   // SPEC pair checks (scale at commit, Δy at arm)
    calmPalmPerS: 3,               // post-commit: the pair is ignored by interaction until slower than this (SPEC)
    suppressProgress: 0.1,         // interaction ignores the pair once growing past 10% (SPEC)
    sizeFactor: 0.55,              // sizePx = dist × 0.55 (SPEC)
    rareChance: 0.05, rareColor: '#ffd75e',
  },
  interact: {
    hoverSelectMs: 350, hoverSpeedPalm: 1.5,                 // SPEC §13.4
    uiDwellMs: 700, uiSpeedPalm: 2, uiOffTargetMs: 150,      // SPEC §13.4
    pickSlopPalm: 0.5, pickSlopMinPx: 28,                    // pick slop = max(28 px, 0.5 palm): generous → easy to select
    selectedReach: 2,              // a pinch within 2× radius of the selection grabs it (SPEC §5.5)
    stillSpeedPx: 20, stillMs: 120, stillUnlockPx: 4,        // grab stillness lock (SPEC); speed over a 100 ms window
    unlockEaseMs: 100,             // unlock keeps the offset (no motion lost) and eases the lock drift in (R2-6)
    rewindMs: 200, rewindRatio: 0.33,                        // release rewind (SPEC)
    lostHoldMs: 300, resumePalm: 2, resumeRatio: 0.42,       // lost-hand grab hold (SPEC)
    rotGainPalm: 0.45, flingPalmPerS: 10, spinMax: 12,       // fist rotate (SPEC); fling = fastest sample of last 200 ms
    swipePalm: 2.5, swipeMs: 200, swipeMinDetections: 3, swipeOppositeMs: 700, swipeRepeatMs: 400, swipeGain: 0.6,
    swipePairMs: 120,              // two hands swiping opposite ways within 120 ms = clap/spread, not a swipe
    thumbupBlockMs: 400,           // SPEC: no thumbup during / 400 ms after fist-rotate
    deleteHoldMs: 700, deleteFrames: 8, deleteSpeedPalm: 3, deleteOtherPalm: 3, deleteNz: 0.5,   // SPEC pinky delete
    fistArmMs: 400,                // fist rotate may start on the first unblocked frame within 400 ms of fist entry
    spreadAfterSelectMs: 600,      // squeeze arms only for a selection made ≥ 600 ms before the spread (L-point) began
    spreadHoldMs: 300, spreadSpeedPalm: 2, squeezeExp: 1.2, squeezeDead: 0.04, squeezeExitMs: 150, squeezeRewindMs: 120,
    squeezeFilter: { minCutoff: 0.6, beta: 0.02, dCutoff: 1.0 },
    twoHandRadiusMul: 3, twoScaleDead: 0.03, twoRotDeadDeg: 1.5,
    twoDistFilter: { minCutoff: 1.0, beta: 0.01, dCutoff: 1.0 },
    scaleRange: [0.25, 6],
    closerPalmFrac: 0.06, closerMs: 1000,                    // 「もっと ちかくに」 (SPEC §13.7)
    minScore: 0.85,                // pinky-delete / thumbup-deselect / fist onset need handScore ≥ 0.85 (SPEC)
  },
  // Depth from hand size while grabbing — OFF by default (SPEC §13.4, setting 「奥行き」).
  depth: { enabled: false, gain: 2.0, deadZone: 0.08, freezeMs: 150, minZ: -6, maxZ: 4 },
};
