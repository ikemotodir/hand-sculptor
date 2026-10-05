// PURE: hand identity tracking + per-hand filtering + debounced pose state machine (SPEC §5.3, §13.2).
// update(rawHands, mapping, nowMs) → TrackedHand[] (live hands first, then lost-in-grace hands, lost:true).
import { OneEuroFilter, PointsFilter, OneEuroVec, emaAlpha } from './filters.js';
import {
  toPoints, pxPerM, PALM_M, palmCenter, meanLandmarkDist, grabAnchor, palmSize, dist2, clamp,
} from './handmath.js';
import { classifyFrame, ACTION_POSES } from './classify.js';
import { CORE } from '../config/core.js';

/**
 * RawHand (tracker.js): { lm:[{x,y,z}]x21 normalized, wl:[{x,y,z}]x21 meters, handed:'Left'|'Right',
 *   handScore:number, canned:{name,score}|null, src?:number }   ([x,y,z] arrays and `score` are accepted too).
 * `src` (optional) = id of the detection result this hand comes from. In 'delayed' frame mode one result is
 * presented on several camera frames (interpolated); the tracker tags each with the OLDER result's id (tracker-sync lerpHands), and the
 * frame-count gates (pinch onset/release, pose debounce, delete/swipe detections) then count one per result,
 * not one per presented frame (R2-5). Untagged hands count every frame (sync mode, replay, tests).
 */
function prepRaw(r, mapping) {
  const lm = toPoints(r.lm), wl = toPoints(r.wl);
  const screen = mapping.mapPoints(lm);
  let ppm = pxPerM(screen, wl);
  // Fallback when world landmarks are degenerate: 2D palm edges / nominal palm size.
  if (!(ppm > 0) || !isFinite(ppm)) {
    const e = (dist2(screen[0], screen[5]) + dist2(screen[0], screen[17]) + dist2(screen[5], screen[17])) / 3;
    ppm = e / 0.085;
  }
  const score = r.handScore ?? r.score ?? 0.5;
  return { src: r.src ?? null, lm, wl, screen, ppm, palmPx: ppm * PALM_M, pc: palmCenter(screen), handed: r.handed || 'Right', score,
    canned: r.canned && !Array.isArray(r.canned) ? r.canned : (Array.isArray(r.canned) ? { name: r.canned[0], score: r.canned[1] } : null) };
}

let NEXT_ID = 1;

export class HandTracker {
  constructor(cfg = CORE) {
    this.cfg = cfg;
    this.tracks = [];
    this.stats = { frames: 0, duplicatesRemoved: 0, dupEvents: [], newIds: 0, mergeSuspects: 0, scaleOutliers: 0 };
    this.lastLiveCount = 0;
    this.lastT = null;             // time of the last update() (R3-10 gap expiry)
    this.updMs = 0;                // mean interval between update() calls
    this.lastReset = false;        // the previous update() was a gap reset (R3-10)
  }

  reset() { this.tracks = []; this.lastLiveCount = 0; this.lastT = null; this.updMs = 0; this.lastReset = false; }

  /** Number of live (non-lost) hands after the last update. */
  get liveCount() { return this.tracks.reduce((n, t) => n + (t.lost ? 0 : 1), 0); }

  update(rawHands, mapping, nowMs) {
    const cfg = this.cfg, idc = cfg.identity;
    this.stats.frames++;
    // camera-image reference size (px) = the displayed image's SHORT side: the 縦 frame crops the covered image,
    // the hand scale does not change (R2-20); a portrait camera (phone upright) has its short side horizontal
    this.viewRef = Math.min(mapping.dispW || mapping.W || 1280, mapping.dispH || mapping.H || 720);
    // One Euro betas are tuned for a 1280×720 display (short side 720); px speeds scale with it, so divide (R3-12)
    this.pxScale = Math.max(0.25, this.viewRef / 720);
    // R3-10: results stopped (tab hidden, camera restart, worker stall) with no empty update in between → every
    // track is stale. Drop them first, so the hand comes back as a NEW track (grab / rotate ended by Interaction's
    // forget loop) instead of re-matching across the gap and teleporting the held object. The limit is the grace or
    // a few result intervals on slow detection. (Per-track ages would also cut the normal last-frame re-match of a
    // lost track — long data 320.1 s false spawn.)
    const gap = this.lastT != null ? nowMs - this.lastT : 0;
    // A gap that caused a reset is a stall, not a result interval: keep it out of the mean, or the next limit grows
    // and a second short stall re-matches across it. Two resets in a row (or no mean yet) = detection really is that
    // slow now: take the gap as the interval, so slow detection stops resetting after the 2nd result.
    const reset = gap > Math.max(idc.graceMs, (idc.gapResetFrames ?? 4) * (this.updMs || 0));
    const g = Math.min(gap, 1000);
    if (reset) {
      this.tracks = [];
      if (!this.updMs || this.lastReset) this.updMs = Math.max(this.updMs, g);
    } else if (gap > 0) this.updMs = this.updMs ? this.updMs + 0.1 * (g - this.updMs) : g;
    this.lastReset = reset;
    this.lastT = nowMs;
    let raws = (rawHands || []).map(r => prepRaw(r, mapping)).filter(r => r.palmPx > 1);

    // 1) Duplicate detections: same handedness + nearly identical landmarks → one hand (keep higher score).
    if (raws.length > 1) {
      const drop = new Set();
      for (let i = 0; i < raws.length; i++) for (let j = i + 1; j < raws.length; j++) {
        if (drop.has(i) || drop.has(j)) continue;
        const a = raws[i], b = raws[j];
        if (a.handed !== b.handed) continue;
        const p = (a.palmPx + b.palmPx) / 2;
        if (meanLandmarkDist(a.screen, b.screen) < idc.dupPalm * p) {
          drop.add(a.score >= b.score ? j : i);
          this.stats.duplicatesRemoved++;
          this.stats.dupEvents.push(nowMs);
        }
      }
      if (drop.size) raws = raws.filter((_, i) => !drop.has(i));
    }

    // 2) Match raws to tracks (greedy by predicted palm-center distance, gated).
    const prevLive = this.tracks.filter(t => !t.lost).map(t => ({ id: t.id, pc: { ...t.palmCenterRaw } }));
    const cands = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      const dt = Math.max(1, nowMs - t.lastSeen);
      const k = Math.max(1, Math.round(dt / t.frameMs));
      const cap = t.palmPx;
      const px = t.palmCenterRaw.x + clamp(t.velocity.x * dt / 1000, -cap, cap);
      const py = t.palmCenterRaw.y + clamp(t.velocity.y * dt / 1000, -cap, cap);
      for (let ri = 0; ri < raws.length; ri++) {
        const r = raws[ri];
        const d = Math.hypot(r.pc.x - px, r.pc.y - py);
        const p = Math.min(t.palmPx, r.palmPx);
        if (d > idc.maxJumpPalm * t.palmPx * k) continue;
        // Handedness labels flip even at 0.95 confidence on real data (demo 1.6–2.4 s), so a confident mismatch
        // only blocks a match that also jumps (≥ 1 palm) — that is the "two hands crossing" case it exists for.
        if (t.handScore >= idc.handedScoreMin && r.score >= idc.handedScoreMin && t.handed !== r.handed && d > idc.handedJumpPalm * p) continue;
        const ratio = r.ppm / t.pxPerM;
        const scaleOk = ratio >= idc.scaleRatio[0] && ratio <= idc.scaleRatio[1];
        // A scale glitch at (almost) the same place is the same hand with a bad world-landmark frame.
        if (!scaleOk && d > 0.6 * p) continue;
        cands.push({ ti, ri, d: d / Math.max(1, t.palmPx), scaleOk });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    const usedT = new Set(), usedR = new Set();
    const matched = [];
    for (const c of cands) {
      if (usedT.has(c.ti) || usedR.has(c.ri)) continue;
      usedT.add(c.ti); usedR.add(c.ri); matched.push(c);
    }

    for (const m of matched) this._updateTrack(this.tracks[m.ti], raws[m.ri], nowMs, m.scaleOk);
    for (let ri = 0; ri < raws.length; ri++) if (!usedR.has(ri)) this.tracks.push(this._newTrack(raws[ri], nowMs));
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      if (t.lastSeen === nowMs) continue;
      if (!t.lost) { t.lost = true; t.lostAt = nowMs; t.justLost = true; } else t.justLost = false;
      t.isNew = false; t.recovered = false; t.pinchOnset = false; t.pinchRelease = false;
      t.lostMs = nowMs - t.lostAt;
    }
    this.tracks = this.tracks.filter(t => !t.lost || nowMs - t.lostAt <= idc.graceMs);

    // 3) Merge-suspect (SPEC §13.2): a hand vanished next to another → the survivor may be two merged palms.
    const live = this.tracks.filter(t => !t.lost);
    for (const t of this.tracks) {
      if (!t.justLost) continue;
      const lostPrev = prevLive.find(p => p.id === t.id);
      if (!lostPrev) continue;
      for (const s of live) {
        const sPrev = prevLive.find(p => p.id === s.id);
        if (!sPrev) continue;
        const mid = { x: (lostPrev.pc.x + sPrev.pc.x) / 2, y: (lostPrev.pc.y + sPrev.pc.y) / 2 };
        if (dist2(s.palmCenterRaw, mid) < idc.mergeSuspectPalm * s.palmPx) {
          s.mergeSuspect = true; s.mergeOrigin = mid; s.mergeUntil = nowMs + idc.mergeSuspectMs;
          this.stats.mergeSuspects++;
        }
      }
    }
    for (const s of live) {
      if (s.mergeSuspect && (nowMs > s.mergeUntil || dist2(s.palmCenterRaw, s.mergeOrigin) > idc.mergeClearPalm * s.palmPx)) s.mergeSuspect = false;
    }
    this.lastLiveCount = live.length;

    // live first, then lost (stable order by id inside each group)
    for (const t of this.tracks) t.viewRef = this.viewRef;
    const out = this.tracks.slice().sort((a, b) => (a.lost - b.lost) || (a.id - b.id));
    return out;
  }

  _px(p) { return { ...p, beta: p.beta / (this.pxScale || 1) }; }

  _newTrack(r, nowMs) {
    const cfg = this.cfg;
    const t = {
      id: NEXT_ID++, handed: r.handed, handScore: r.score, score: r.score,
      bornAt: nowMs, age: 0, frames: 0, lost: false, lostAt: 0, lostMs: 0, isNew: true, recovered: false, justLost: false,
      lastSeen: nowMs, frameMs: 33.3, fps: 30,
      fScreen: new PointsFilter(this._px(cfg.filter), 21, 2),
      fDisplay: new PointsFilter(this._px(cfg.displayFilter || { minCutoff: 4, beta: 0.05, dCutoff: 1 }), 21, 2),
      fWorld: new PointsFilter(cfg.worldFilter, 21, 3),
      fScale: new OneEuroFilter(cfg.scaleFilter || { minCutoff: 0.5, beta: 0, dCutoff: 1 }),
      fAnchor: new OneEuroVec(this._px(cfg.filter), 2),
      pxPerM: r.ppm, palmPx: r.palmPx, palmPxRaw: r.palmPx, scaleOutRun: 0,
      handVotes: { Left: 0, Right: 0 }, handedStable: false, lastConfHanded: null, handFlipAt: null,
      velocity: { x: 0, y: 0 }, speed: 0, speedPalm: 0,
      palmCenterRaw: { ...r.pc }, rawHistory: [],
      cls: null, pose: 'neutral', rawPose: 'neutral', poseSince: nowMs, prevPose: null,
      cand: null, candSince: nowMs, candFrames: 0, lastSrc: undefined, fresh: true,
      pinch: false, pinchSmooth: null, pinchOnCount: 0, pinchOffCount: 0, pinchOffSince: 0, pinchSince: 0,
      pinchOnset: false, pinchRelease: false,
      mergeSuspect: false, mergeOrigin: null, mergeUntil: 0,
    };
    this.stats.newIds++;
    this._updateTrack(t, r, nowMs, true);
    t.isNew = true;
    return t;
  }

  _updateTrack(t, r, nowMs, scaleOk) {
    const cfg = this.cfg;
    const wasLost = t.lost;
    if (t.frames > 0 && !wasLost) {
      const dtf = nowMs - t.lastSeen;
      if (dtf > 0 && dtf < 1000) t.frameMs += 0.2 * (dtf - t.frameMs);
      t.fps = 1000 / t.frameMs;
    }
    const dtMs = t.frames > 0 ? nowMs - t.lastSeen : 0;
    t.isNew = false;
    t.recovered = wasLost;
    // a new detection result (or untagged) → frame-count gates advance; a re-presented one only updates positions
    const fresh = r.src == null || r.src !== t.lastSrc || wasLost;
    t.lastSrc = r.src; t.fresh = fresh;
    t.lost = false; t.lostMs = 0; t.justLost = false;
    t.lastSeen = nowMs; t.frames++; t.age = nowMs - t.bornAt;

    // handedness: score-weighted votes with ~2 s memory; `handedStable` = the label never confidently flipped lately
    const decay = Math.exp(-Math.max(0, dtMs) / 2000);
    t.handVotes.Left *= decay; t.handVotes.Right *= decay;
    if (r.score >= 0.5) t.handVotes[r.handed === 'Left' ? 'Left' : 'Right'] += r.score;
    if (r.score >= cfg.identity.handedScoreMin) { if (t.lastConfHanded && t.lastConfHanded !== r.handed) t.handFlipAt = nowMs; t.lastConfHanded = r.handed; }
    const vl = t.handVotes.Left, vr = t.handVotes.Right;
    t.handed = vl > vr ? 'Left' : vr > vl ? 'Right' : r.handed;
    t.handScore = r.score;
    t.handedStable = Math.max(vl, vr) / Math.max(1e-6, vl + vr) >= 0.85 && nowMs - (t.handFlipAt ?? -1e9) > 2000;
    t.score = t.frames === 1 ? r.score : t.score + emaAlpha(dtMs, 150) * (r.score - t.score);
    t.canned = r.canned;

    // scale (rotation-robust): reject single-frame world-landmark glitches; 3 in a row = the scale really changed
    if (scaleOk) { t.pxPerM = t.fScale.filter(r.ppm, nowMs); t.scaleOutRun = 0; }
    else if (++t.scaleOutRun >= 3) { t.fScale.reset(); t.pxPerM = t.fScale.filter(r.ppm, nowMs); t.scaleOutRun = 0; }
    else this.stats.scaleOutliers++;
    t.palmPx = t.pxPerM * PALM_M;
    t.palmPxRaw = r.palmPx;

    // landmarks
    t.screenRaw = r.screen; t.wlRaw = r.wl; t.lmRaw = r.lm;
    t.screen = t.fScreen.filter(r.screen, nowMs);
    t.screenDisplay = t.fDisplay.filter(r.screen, nowMs);
    t.wl = t.fWorld.filter(r.wl, nowMs);
    t.palmSize = palmSize(t.wl);
    const a = t.fAnchor.filter([(r.screen[2].x + r.screen[5].x + r.screen[6].x) / 3, (r.screen[2].y + r.screen[5].y + r.screen[6].y) / 3], nowMs);
    t.anchor = { x: a[0], y: a[1] };
    t.indexTip = { x: t.screen[8].x, y: t.screen[8].y };
    t.indexTipDisplay = { x: t.screenDisplay[8].x, y: t.screenDisplay[8].y };
    t.pinchPoint = { x: (t.screen[4].x + t.screen[8].x) / 2, y: (t.screen[4].y + t.screen[8].y) / 2 };
    const pcF = palmCenter(t.screen);
    t.palmCenter = { x: pcF.x, y: pcF.y };

    // velocity from the filtered palm center (EMA, tau 50 ms)
    if (t.prevPc && dtMs > 0) {
      const vx = (pcF.x - t.prevPc.x) / (dtMs / 1000), vy = (pcF.y - t.prevPc.y) / (dtMs / 1000);
      const al = wasLost ? 1 : emaAlpha(dtMs, 50);
      t.velocity = { x: t.velocity.x + al * (vx - t.velocity.x), y: t.velocity.y + al * (vy - t.velocity.y) };
    }
    t.prevPc = { x: pcF.x, y: pcF.y };
    t.speed = Math.hypot(t.velocity.x, t.velocity.y);
    t.speedPalm = t.speed / Math.max(1, t.palmPx);
    t.palmCenterRaw = { ...r.pc };
    if (fresh) t.rawHistory.push({ t: nowMs, x: r.pc.x, y: r.pc.y });
    while (t.rawHistory.length && nowMs - t.rawHistory[0].t > 600) t.rawHistory.shift();

    // classification (raw world landmarks; pinch handled below with hysteresis)
    const cls = classifyFrame(r.wl, t.canned, { screen: t.screen, palmPx: t.palmPx, prev: t.cls, pinchEnter: -1, cfg: cfg.classify });
    t.cls = cls; t.feat = cls; t.ext = cls.ext; t.curled = cls.curled; t.nz = cls.nz;
    t.pinchRatio = cls.pinchRatio; t.indexReach = cls.indexReach;

    // pinch hysteresis on a lightly smoothed ratio
    const pc = cfg.pinch;
    t.pinchSmooth = t.pinchSmooth == null || wasLost ? cls.pinchRatio : t.pinchSmooth + emaAlpha(dtMs, pc.smoothMs) * (cls.pinchRatio - t.pinchSmooth);
    t.pinchOnset = false; t.pinchRelease = false;
    if (!t.pinch) {
      // raw OR smoothed below enter: a clean close triggers on its 2nd frame, an alternating 0.22/0.31 run via the EMA
      if (fresh) { if (Math.min(cls.pinchRatio, t.pinchSmooth) < pc.enter && cls.indexReach > pc.indexReachMin) t.pinchOnCount++; else t.pinchOnCount = 0; }
      if (fresh && t.pinchOnCount >= pc.onsetFrames) { t.pinch = true; t.pinchOnset = true; t.pinchSince = nowMs; t.pinchOffCount = 0; t.pinchOffSince = nowMs; }
    } else {
      // release: ≥ releaseFrames consecutive frames above exit AND ≥ releaseMs since the last frame it was closed
      if (t.pinchSmooth > pc.exit) {
        if (fresh) t.pinchOffCount++;
        if (fresh && t.pinchOffCount >= pc.releaseFrames && nowMs - t.pinchOffSince >= pc.releaseMs) {
          t.pinch = false; t.pinchRelease = true; t.pinchOnCount = 0; t.pinchOffCount = 0;
        }
      } else { if (fresh) t.pinchOffCount = 0; t.pinchOffSince = nowMs; }
    }

    // debounced pose
    t.rawPose = t.pinch ? 'pinch' : cls.pose;
    if (fresh) { if (cls.pose !== t.cand) { t.cand = cls.pose; t.candSince = nowMs; t.candFrames = 1; } else t.candFrames++; }
    const db = cfg.debounce;
    let prevPose = t.pose;
    if (t.pinch) {
      if (t.pose !== 'pinch') { t.pose = 'pinch'; t.poseSince = nowMs; }
    } else {
      if (t.pose === 'pinch') { t.pose = 'neutral'; t.poseSince = nowMs; }
      const c = t.cand;
      const ms = c === 'thumbup' ? db.thumbupMs : ACTION_POSES.has(c) ? db.actionPoseMs : db.poseMs;
      const fr = c === 'thumbup' ? db.thumbupFrames : ACTION_POSES.has(c) ? db.actionFrames : db.poseFrames;
      if (c !== t.pose && nowMs - t.candSince >= ms && t.candFrames >= fr) { t.pose = c; t.poseSince = nowMs; }
    }
    if (t.pose !== prevPose) t.prevPose = prevPose;
  }
}

/** Test helper: reset the global id counter (ids stay unique per process otherwise). */
export function _resetIds() { NEXT_ID = 1; }
