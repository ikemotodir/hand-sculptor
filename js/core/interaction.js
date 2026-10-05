// PURE: gesture → intents state machine (SPEC §5.5 as amended by §13.4). Drives a SceneAPI; no DOM/THREE.
//
// Per frame (main loop):
//   const hands = tracker.update(raw, mapping, now);
//   const alch  = alchemy.update(hands, now, interaction.alchemyCtx());
//   const out   = interaction.update(hands, alch, now);   // → HUD / overlay / audio / tutorial
//
// SceneAPI used: pick(sx,sy,slop) getScreenInfo(id)->{x,y,r,z?} getSelected() select(id|null) setHover(id|null)
//   beginTransform(id) endTransform(id) setGrabPose(id,sx,sy,z?) rotateBy(id,ax,ay,az) setSpin(id,wx,wy)
//   scaleBy(id,f) remove(id) spawn({type,color,colorIdx,opacity,sx,sy,sizePx,rare})->id
import { OneEuroFilter, emaAlpha } from './filters.js';
import { dist2, clamp } from './handmath.js';
import { SpawnStyler } from './alchemy.js';
import { CORE } from '../config/core.js';

export const HINTS = {
  pickFirst: '☝️で えらんでね',
  closer: 'もっと ちかくに',
};

const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export class Interaction {
  /**
   * @param {object} o
   * @param {object} o.scene SceneAPI
   * @param {object} [o.cfg] CORE config
   * @param {number} [o.W] [o.H] stage size px
   * @param {(sx:number, sy:number)=>({id:string}|null)} [o.uiHit] DOM hit-test (hud.hitTest) for finger dwell
   * @param {string[]} [o.shapes] [o.colors] for random spawn style
   * @param {()=>number} [o.rng]
   */
  constructor({ scene, cfg = CORE, W = 1280, H = 720, uiHit = null, shapes, colors, rng = Math.random } = {}) {
    this.scene = scene; this.cfg = cfg; this.W = W; this.H = H; this.uiHit = uiHit;
    this.styler = new SpawnStyler({ shapes, colors, rng, rareChance: cfg.alchemy.rareChance, rareColor: cfg.alchemy.rareColor });
    this.style = { type: 'random', colorIdx: -1, opacity: 0.2 };
    this.enabled = true;
    this.uiDwellWhenDisabled = true;
    this.reset();
  }

  reset() {
    this.hs = new Map();            // handId → per-hand state
    this.grabs = new Map();         // objId → { hands:Set<handId>, two:null|{…} }
    this.hoverId = null;
    this.transformEndAt = -1e9;
    this.releaseAt = -1e9;
    this.rotateEndAt = -1e9;
    this.selectAt = -1e9;          // last select made by a hand gesture (hover / pinch)
    this.lastT = null;
    this.prevAlchPhase = 'idle';
    this.noHandsSince = 0;
    this.handsSeen = false;
    this.closerSince = null;
    this.hintUntil = 0; this.hintKey = null;
    this.pendingSwipes = [];
    this.stats = { grabs: 0, releases: 0, selects: 0, deselects: 0, deletes: 0, rotates: 0, spins: 0, swipes: 0, squeezes: 0,
      twoHand: 0, uiClicks: 0, spawns: 0, pinchOnsets: 0, pinchOnsetTimes: [], deleteTimes: [], deselectTimes: [], rotateTimes: [], swipeTimes: [], squeezeTimes: [] };
  }

  setViewport(W, H) { this.W = W; this.H = H; }
  setUiHitTest(fn) { this.uiHit = fn; }
  /** Spawn style for alchemy: type 'random' or a shape; colorIdx -1 = random; opacity 0..1. */
  setStyle(s) { Object.assign(this.style, s); }
  /**
   * false → no scene intents (phone-link mode); cursors still reported. Ends any ongoing transforms.
   * While disabled, finger dwell on UI targets (uiDwell / uiClick) keeps working unless `uiDwell: false`,
   * so the HUD (e.g. back to AR) stays usable by hand.
   */
  setEnabled(b, { uiDwell = true } = {}) {
    if (!b && this.enabled) this._endAll(this.lastT ?? 0);
    this.enabled = !!b;
    this.uiDwellWhenDisabled = !!uiDwell;
  }
  isGrabbing() { return this.grabs.size > 0; }
  /**
   * Spawn with the current style (SPEC §13.4: tapping a shape button spawns it at screen center). Pass `type`
   * to force a shape (the button's), otherwise the style's type / 🎲. Returns {id, type, color, rare}.
   */
  spawnShape({ type, sx = this.W / 2, sy = this.H / 2, sizePx = Math.min(this.W, this.H) * 0.28 } = {}) {
    const st = this.styler.pick({ ...this.style, type: type || this.style.type });
    const id = this.scene.spawn({ type: st.type, color: st.color, colorIdx: st.colorIdx, opacity: this.style.opacity, sx, sy, sizePx, rare: st.rare });
    return { id, type: st.type, color: st.color, rare: st.rare };
  }
  /** Context for Alchemy.update (SPEC §13.3 lockout). */
  alchemyCtx() { return { grabbing: this.isGrabbing(), transformEndAt: this.transformEndAt, releaseAt: this.releaseAt }; }

  _state(id) {
    let s = this.hs.get(id);
    if (!s) {
      s = { mode: 'idle', grab: null, rot: null, sq: null, hover: { id: null, ms: 0 }, dwell: { id: null, p: 0, lastOn: -1e9, done: false },
        del: { ms: 0, frames: 0, done: false }, spreadMs: 0, thumbFired: false, lastPose: null, idxPrev: null, idxSpeed: 0,
        lastSwipe: null, lastSeen: 0 };
      this.hs.set(id, s);
    }
    return s;
  }

  update(hands, alch, nowMs) {
    const C = this.cfg.interact;
    this._handsRef = hands;
    const dt = this.lastT == null ? 0 : Math.max(0, Math.min(250, nowMs - this.lastT));
    this.lastT = nowMs;
    alch = alch || { phase: 'idle', ignore: [], suppress: false, a: null, b: null, event: null };
    const out = { cursors: [], hoverId: null, selectedId: null, intents: [], events: [], hint: null, hintKey: null, grabs: [], alchemy: alch };
    const sc = this.scene;
    let sel = sc.getSelected();
    const live = hands.filter(h => !h.lost);

    // tutorial: hands appeared
    if (live.length) {
      if (!this.handsSeen || (this.noHandsSince && nowMs - this.noHandsSince > 1000)) out.events.push('hands');
      this.handsSeen = true; this.noHandsSince = 0;
    } else if (!this.noHandsSince) this.noHandsSince = nowMs;

    // alchemy spawn
    if (alch.event && alch.event.type === 'spawn' && this.enabled) {
      const st = this.styler.pick(this.style);
      const id = sc.spawn({ type: st.type, color: st.color, colorIdx: st.colorIdx, opacity: this.style.opacity,
        sx: alch.event.mid.x, sy: alch.event.mid.y, sizePx: alch.event.sizePx, rare: st.rare });
      out.intents.push({ type: 'spawn', id, shape: st.type, color: st.color, rare: st.rare, sx: alch.event.mid.x, sy: alch.event.mid.y });
      out.events.push('alchemySpawn');
      if (st.rare) out.events.push('rare');
      this.stats.spawns++;
    }
    if (alch.phase === 'armed' && this.prevAlchPhase !== 'armed') for (const s of this.hs.values()) { s.del.ms = 0; s.del.frames = 0; }
    this.prevAlchPhase = alch.phase;

    const ignored = new Set(alch.ignore || []);
    if (alch.suppress) { ignored.add(alch.a); ignored.add(alch.b); }
    const inAlch = id => (alch.phase === 'armed' || alch.phase === 'growing') && (id === alch.a || id === alch.b);
    const blocked = h => h.mergeSuspect || alch.phase !== 'idle' || (h.score ?? 1) < C.minScore;

    // forget states of hands that no longer exist
    for (const [id, s] of this.hs) if (!hands.some(h => h.id === id)) { this._endHand(id, s, nowMs, out, false); this.hs.delete(id); }

    let hoverCandidate = null;

    for (const h of hands) {
      const s = this._state(h.id);
      // index-tip speed (palm/s) for hover/dwell gates
      if (!h.lost) {
        if (s.idxPrev && dt > 0) {
          const v = dist2(h.indexTip, s.idxPrev) / (dt / 1000);
          s.idxSpeed += emaAlpha(dt, 60) * (v - s.idxSpeed);
        }
        s.idxPrev = { ...h.indexTip };
      }
      if (!this.enabled) {
        // phone-link mode: no scene intents, but the PC HUD stays usable by finger dwell (SPEC §13.4 UI dwell)
        if (!h.lost) {
          const c = { id: h.id, x: h.indexTipDisplay.x, y: h.indexTipDisplay.y, pose: h.pose, kind: 'point', progress: 0, objId: null };
          if (this.uiDwellWhenDisabled && (h.pose === 'point' || h.pose === 'spread')) this._uiDwell(h, s, nowMs, out, dt);
          else this._dwellExpire(s, nowMs);
          if (s.dwell.id != null && (h.pose === 'point' || h.pose === 'spread')) { c.kind = 'dwell'; c.progress = s.dwell.p; c.uiId = s.dwell.id; }
          out.cursors.push(c);
          s.lastPose = h.pose;
        }
        continue;
      }

      // ---- lost hands: a grab, fist-rotate or squeeze is held through a short dropout (the object stays still);
      // the tracker drops the track after its grace period and the forget loop above ends the mode (R2-3)
      if (h.lost) {
        if (s.mode === 'grab') this._grabLost(h, s, nowMs, out);
        else if ((s.mode === 'rotate' || s.mode === 'squeeze') && (h.lostMs ?? 0) <= C.lostHoldMs) { /* hold */ }
        else if (s.mode !== 'idle') this._endHand(h.id, s, nowMs, out, false);
        continue;
      }
      if (s.mode === 'grab' && s.grab.lostSince != null) this._grabResume(h, s, nowMs, out);

      // ---- alchemy owns these hands
      if (ignored.has(h.id)) {
        if (s.mode !== 'idle' && s.mode !== 'grab') this._endHand(h.id, s, nowMs, out, false);
        this._resetTimers(s);
        out.cursors.push({ id: h.id, x: h.palmCenter.x, y: h.palmCenter.y, pose: h.pose, kind: 'alchemy', progress: alch.progress || 0, objId: null });
        s.lastPose = h.pose;
        continue;
      }

      const poseEntered = h.pose !== s.lastPose;
      // ---- ongoing modes
      if (s.mode === 'grab') { this._grabUpdate(h, s, nowMs, out); }
      else if (s.mode === 'rotate') { this._rotateUpdate(h, s, nowMs, out, dt); }
      else if (s.mode === 'squeeze') { this._squeezeUpdate(h, s, nowMs, out, dt); }

      // ---- onsets (idle only)
      if (s.mode !== 'idle' || h.pose !== 'spread') s.spreadOk = false; // re-evaluated on the next spread entry
      if (s.mode !== 'idle') s.fistAt = null;
      if (s.mode === 'idle') {
        sel = sc.getSelected();
        if (h.pinchOnset) {
          this.stats.pinchOnsets++; this.stats.pinchOnsetTimes.push(nowMs);
          if (!inAlch(h.id)) this._tryGrab(h, s, nowMs, out);
        }
        if (s.mode === 'idle') {
          if (h.pose === 'fist') {
            // armed on fist entry; starts on the first unblocked frame within fistArmMs (a blocked entry frame
            // no longer kills the whole fist). Never on an object another hand is holding.
            if (poseEntered) s.fistAt = nowMs;
            if (sel != null && s.fistAt != null && nowMs - s.fistAt <= C.fistArmMs && !blocked(h) && !this.grabs.has(sel)) {
              s.fistAt = null;
              this._rotateStart(h, s, sel, nowMs, out);
            } else if (sel == null) { s.fistAt = null; this._hint('pickFirst', nowMs, 1500); } // no late start on a later selection
          } else s.fistAt = null;
          if (h.pose === 'thumbup') {
            const fistBlock = nowMs - this.rotateEndAt < C.thumbupBlockMs || [...this.hs.values()].some(x => x.mode === 'rotate');
            if (!s.thumbFired && !blocked(h) && !fistBlock && sel != null) {
              sc.select(null); s.thumbFired = true;
              out.intents.push({ type: 'deselect', id: sel }); out.events.push('deselect');
              this.stats.deselects++; this.stats.deselectTimes.push(nowMs);
              sel = null;
            }
          } else s.thumbFired = false;
          if (h.pose === 'pinky') this._deleteUpdate(h, s, sel, live, nowMs, out, dt, blocked(h));
          else { s.del.ms = 0; s.del.frames = 0; s.del.done = false; }
          if (h.pose === 'spread' && poseEntered) {
            // squeeze may arm only for a selection that already existed (and settled) when the L-hand began:
            // an L-shaped point that selects must not turn into a resize (owner #14/#15)
            s.spreadSel = sel;
            s.spreadOk = sel != null && nowMs - this.selectAt >= C.spreadAfterSelectMs;
          }
          if (h.pose === 'point' || h.pose === 'spread') {
            const hv = this._point(h, s, sel, nowMs, out, dt);
            if (hv && !hoverCandidate) hoverCandidate = hv;
          } else {
            s.hover.id = null; s.hover.ms = 0;
            this._dwellExpire(s, nowMs); // a brief pose misread keeps the dwell (no second uiClick)
          }
          const sel2 = sc.getSelected();
          if (h.pose === 'spread' && sel2 != null && s.spreadOk && sel2 === s.spreadSel && s.dwell.id == null
            && (s.hover.id == null || s.hover.id === sel2) && !this.grabs.has(sel2)) this._spreadArm(h, s, sel2, nowMs, out, dt);
          else s.spreadMs = 0;
          if (h.pose === 'open' && !h.pinch) this._swipeDetect(h, s, nowMs, inAlch(h.id));
        }
      }

      // ---- cursor
      this._cursor(h, s, sel, out);
      s.lastPose = h.pose;
      s.lastSeen = nowMs;
    }

    // two-hand transforms
    for (const [objId, g] of this.grabs) this._twoHand(objId, g, hands, nowMs, out);

    // swipes (fire after the pair window so a two-hand clap/spread is not a swipe)
    this._flushSwipes(nowMs, alch, out);

    // hover (one global hover id)
    const hov = hoverCandidate;
    if (hov !== this.hoverId) { sc.setHover(hov); this.hoverId = hov; }

    // hints
    // against the camera image size (not the 縦 frame width): the same hand has the same palmPx in both (R2-20)
    if (live.length && live.every(h => h.palmPx < C.closerPalmFrac * (h.viewRef || Math.min(this.W, this.H)))) {
      if (this.closerSince == null) this.closerSince = nowMs;
      if (nowMs - this.closerSince >= C.closerMs) this._hint('closer', nowMs, 300);
    } else this.closerSince = null;
    if (this.hintKey && nowMs < this.hintUntil) { out.hintKey = this.hintKey; out.hint = HINTS[this.hintKey]; }
    else this.hintKey = null;

    out.hoverId = this.hoverId;
    out.selectedId = sc.getSelected();
    for (const [objId, g] of this.grabs) out.grabs.push({ objId, hands: [...g.hands], two: !!g.two });
    return out;
  }

  _hint(key, nowMs, ms) { this.hintKey = key; this.hintUntil = Math.max(this.hintUntil, nowMs + ms); }

  _resetTimers(s) {
    s.hover.id = null; s.hover.ms = 0; s.dwell.id = null; s.dwell.p = 0; s.del.ms = 0; s.del.frames = 0; s.spreadMs = 0;
  }

  // ------------------------------------------------------------------ grab
  _tryGrab(h, s, nowMs, out) {
    const C = this.cfg.interact, sc = this.scene;
    const pp = h.pinchPoint;
    const slop = Math.max(C.pickSlopMinPx, C.pickSlopPalm * h.palmPx);
    // join an object another hand is already holding (two-hand)
    for (const [objId, g] of this.grabs) {
      const info = sc.getScreenInfo(objId);
      if (info && dist2(pp, info) < C.twoHandRadiusMul * Math.max(info.r, slop)) { this._grabStart(h, s, objId, nowMs, out); return; }
    }
    let target = sc.pick(pp.x, pp.y, slop);
    if (target == null) {
      const sel = sc.getSelected();
      if (sel != null) {
        const info = sc.getScreenInfo(sel);
        if (info && dist2(pp, info) < C.selectedReach * Math.max(info.r, slop)) target = sel;
      }
    }
    if (target == null) return;
    if (sc.getSelected() !== target) { sc.select(target); this.selectAt = nowMs; out.intents.push({ type: 'select', id: target }); out.events.push('select'); this.stats.selects++; }
    this._grabStart(h, s, target, nowMs, out);
  }

  _grabStart(h, s, objId, nowMs, out) {
    const sc = this.scene;
    // R1-23: a grab wins over another hand's fist-rotate / squeeze on the same object. End that one first
    // (its own undo step), so two transforms never overlap and undo stays coherent.
    for (const [id, o] of this.hs) {
      if (id === h.id) continue;
      if (o.mode === 'rotate' && o.rot && o.rot.objId === objId) this._rotateEnd(this._handById(id), o, nowMs, out, false);
      else if (o.mode === 'squeeze' && o.sq && o.sq.objId === objId) this._squeezeEnd(o, nowMs, out, false);
    }
    let g = this.grabs.get(objId);
    if (!g) { g = { hands: new Set(), two: null }; this.grabs.set(objId, g); sc.beginTransform(objId); }
    else { sc.endTransform(objId); sc.beginTransform(objId); this.transformEndAt = nowMs; }
    g.hands.add(h.id);
    if (g.hands.size >= 2) g.two = null; // re-captured in _twoHand
    for (const id of g.hands) { const o = this.hs.get(id); if (o && o.grab && id !== h.id) this._rebase(o.grab, this._handById(id) || h); }
    const info = sc.getScreenInfo(objId) || { x: h.anchor.x, y: h.anchor.y, r: 0 };
    s.mode = 'grab';
    s.grab = {
      objId, palmPx0: h.palmPx, offset: { x: info.x - h.anchor.x, y: info.y - h.anchor.y }, objPos: { x: info.x, y: info.y },
      z0: info.z, k0: null, startT: nowMs, hist: [], aHist: [], lastAnchor: { ...h.anchor }, aSpeed: 0, stillMs: 0, locked: false, lockAnchor: null,
      lostSince: null, lastPred: { ...h.anchor },
    };
    out.intents.push({ type: 'grab', id: objId, hand: h.id }); out.events.push('grab');
    this.stats.grabs++;
  }

  _handById(id) { return this._handsRef ? this._handsRef.find(h => h.id === id) : null; }

  /**
   * Offset scale factor. SPEC: offset·(palmPx/palmPx0). Applied only with depth ON: with depth OFF the object
   * stays in its plane, and palmPx noise × a large offset (big object grabbed at its rim) reads as jitter.
   */
  _k(g, h) { return this.cfg.depth.enabled ? h.palmPx / g.palmPx0 : 1; }

  /** Re-base so the object stays exactly where it is (no jump). */
  _rebase(g, h) {
    const sc = this._k(g, h);
    g.offset = { x: (g.objPos.x - h.anchor.x) / sc, y: (g.objPos.y - h.anchor.y) / sc };
    g.lastAnchor = { ...h.anchor }; g.locked = false; g.stillMs = 0; g.ease = null; g.lockLast = null;
  }

  _grabUpdate(h, s, nowMs, out) {
    const C = this.cfg.interact, P = this.cfg.pinch;
    const g = s.grab;
    if (this.scene.getScreenInfo(g.objId) == null) { this._grabEnd(h, s, nowMs, out, false); return; } // object gone (deleted / undo)
    if (!h.pinch) {
      // fist-grip keeps holding (pinch closed into a fist: index folded, nothing extended)
      const grip = h.indexReach < P.indexReachMin && h.cls && h.cls.nExt === 0;
      if (!grip) { this._grabEnd(h, s, nowMs, out, true); return; }
    }
    const grp = this.grabs.get(g.objId);
    const dtA = Math.max(1, nowMs - (g.lastT || nowMs - 33));
    g.lastT = nowMs;
    // anchor speed over a ~100 ms window (frame-to-frame differences of a 1 px jitter read as 30 px/s)
    g.aHist.push({ t: nowMs, x: h.anchor.x, y: h.anchor.y });
    while (g.aHist.length > 2 && nowMs - g.aHist[1].t >= 100) g.aHist.shift();
    const a0 = g.aHist[0];
    g.aSpeed = nowMs > a0.t ? dist2(h.anchor, a0) / ((nowMs - a0.t) / 1000) : 0;
    g.lastAnchor = { ...h.anchor };
    g.hist.push({ t: nowMs, ratio: h.pinchRatio, x: g.objPos.x, y: g.objPos.y });
    while (g.hist.length && nowMs - g.hist[0].t > C.rewindMs + 100) g.hist.shift();
    if (grp && grp.hands.size >= 2) return; // two-hand mode moves the object

    // stillness lock
    if (g.aSpeed < C.stillSpeedPx) g.stillMs += dtA; else g.stillMs = 0;
    if (!g.locked && g.stillMs >= C.stillMs) { g.locked = true; g.lockAnchor = { ...h.anchor }; g.lockLast = { ...h.anchor }; }
    const k = this._k(g, h);
    if (g.locked) {
      // unlock WITHOUT re-basing: the offset is kept, so no hand motion is thrown away (R2-6). Only the few px the
      // anchor drifted while locked (up to the last locked frame) fade out over unlockEaseMs; the hand's motion
      // itself is followed 1:1 from the unlock frame on (R3-11: easing the motion made the object lag, then jump)
      if (dist2(h.anchor, g.lockAnchor) > C.stillUnlockPx) {
        const ref = g.lockLast || g.lockAnchor;
        g.locked = false; g.stillMs = 0;
        g.ease = { x: g.objPos.x - (ref.x + g.offset.x * k), y: g.objPos.y - (ref.y + g.offset.y * k), t0: nowMs };
      } else { g.lockLast = { ...h.anchor }; return; }
    }
    let x = h.anchor.x + g.offset.x * k, y = h.anchor.y + g.offset.y * k;
    if (g.ease) {
      const p = (nowMs - g.ease.t0) / C.unlockEaseMs;
      if (p < 1) { x += g.ease.x * (1 - p); y += g.ease.y * (1 - p); } else g.ease = null;
    }
    if (Math.abs(x - g.objPos.x) + Math.abs(y - g.objPos.y) < 0.05) return;
    g.objPos = { x, y };
    g.hist[g.hist.length - 1].x = x; g.hist[g.hist.length - 1].y = y;
    this.scene.setGrabPose(g.objId, x, y, this._depth(h, g, nowMs));
  }

  _depth(h, g, nowMs) {
    const D = this.cfg.depth;
    if (!D.enabled || g.z0 == null || !h.wl) return undefined;
    const w = h.wl, s = h.screen;
    const e2 = (a, b) => Math.hypot(s[a].x - s[b].x, s[a].y - s[b].y);
    const ew = (a, b) => Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y);
    const wxy = (ew(0, 5) + ew(0, 17) + ew(5, 17)) / 3;
    if (wxy < 1e-6) return undefined;
    const k = ((e2(0, 5) + e2(0, 17) + e2(5, 17)) / 3) / wxy;
    if (nowMs - g.startT < D.freezeMs) { g.k0 = k; return g.z0; }
    if (g.k0 == null) g.k0 = k;
    let l = Math.log(k / g.k0);
    if (Math.abs(l) < D.deadZone) return g.zLast ?? g.z0;
    l -= Math.sign(l) * D.deadZone;
    g.zLast = clamp(g.z0 + Math.min(2, D.gain) * l, D.minZ, D.maxZ);
    return g.zLast;
  }

  _grabEnd(h, s, nowMs, out, rewind) {
    const C = this.cfg.interact;
    const g = s.grab;
    const grp = this.grabs.get(g.objId);
    if (rewind && g.hist.length > 1 && !(grp && grp.hands.size >= 2)) {
      // restore the pose from the first frame of the final "opening" run (ratio > rewindRatio) within rewindMs
      let i = g.hist.length - 1;
      while (i > 0 && g.hist[i].ratio > C.rewindRatio && nowMs - g.hist[i].t <= C.rewindMs) i--;
      const r = g.hist[Math.min(g.hist.length - 1, i + 1)];
      if (r && (r.x !== g.objPos.x || r.y !== g.objPos.y)) {
        g.objPos = { x: r.x, y: r.y };
        this.scene.setGrabPose(g.objId, r.x, r.y, g.zLast);
      }
    }
    s.mode = 'idle'; s.grab = null;
    const gone = this.scene.getScreenInfo(g.objId) == null;
    if (grp) {
      grp.hands.delete(h.id);
      if (!gone) this.scene.endTransform(g.objId);
      if (grp.hands.size === 0 || gone) {
        // object removed: end the other holders too (their own _grabUpdate would do it next frame anyway)
        this.grabs.delete(g.objId);
        for (const id of grp.hands) { const o = this.hs.get(id); if (o && o.mode === 'grab') { o.mode = 'idle'; o.grab = null; out.intents.push({ type: 'release', id: g.objId, hand: id }); } }
      }
      else {
        // remaining hand continues alone: new undo group + re-based offset (no jump)
        this.scene.beginTransform(g.objId);
        if (grp.two) this.transformEndAt = nowMs;
        grp.two = null;
        for (const id of grp.hands) { const o = this.hs.get(id); const hh = this._handById(id); if (o && o.grab && hh) { o.grab.objPos = { ...g.objPos }; this._rebase(o.grab, hh); } }
      }
    }
    out.intents.push({ type: 'release', id: g.objId, hand: h.id });
    this.releaseAt = nowMs;
    this.stats.releases++;
  }

  _grabLost(h, s, nowMs, out) {
    const C = this.cfg.interact;
    const g = s.grab;
    if (g.lostSince == null) g.lostSince = nowMs;
    if (nowMs - g.lostSince > C.lostHoldMs) this._grabEnd(h, s, nowMs, out, false);
  }

  _grabResume(h, s, nowMs, out) {
    const C = this.cfg.interact;
    const g = s.grab;
    const ok = dist2(h.anchor, g.lastAnchor) < C.resumePalm * h.palmPx && h.pinchRatio < C.resumeRatio;
    g.lostSince = null;
    if (ok) this._rebase(g, h);
    else this._grabEnd(h, s, nowMs, out, false);
  }

  // ------------------------------------------------------------------ two-hand
  _twoHand(objId, g, hands, nowMs, out) {
    const C = this.cfg.interact, sc = this.scene;
    if (g.hands.size < 2) { g.two = null; return; }
    const hs = [...g.hands].map(id => hands.find(h => h.id === id)).filter(h => h && !h.lost);
    if (hs.length < 2) return; // a lost hand holds still
    const [h1, h2] = hs;
    const p1 = h1.anchor, p2 = h2.anchor;
    const d = Math.max(1, dist2(p1, p2));
    const th = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    if (!g.two) {
      const info = sc.getScreenInfo(objId) || mid;
      g.two = { d0: d, dApplied: d, thApplied: th, off: { x: info.x - mid.x, y: info.y - mid.y }, f: new OneEuroFilter(C.twoDistFilter), total: 1, objPos: { x: info.x, y: info.y } };
      g.two.f.filter(d, nowMs);
      out.events.push('twoHand'); this.stats.twoHand++;
      return;
    }
    const t = g.two;
    const dF = t.f.filter(d, nowMs);
    const l = Math.log(dF / t.dApplied);
    if (Math.abs(l) > C.twoScaleDead) {
      let f = dF / t.dApplied;
      const tot = clamp(t.total * f, C.scaleRange[0] / 6, 6 / C.scaleRange[0]);
      f = tot / t.total; t.total = tot;
      if (Math.abs(f - 1) > 1e-4) { sc.scaleBy(objId, f); out.intents.push({ type: 'scale', id: objId, factor: f }); }
      t.dApplied = dF;
    }
    const dth = wrapPi(th - t.thApplied);
    if (Math.abs(dth) > C.twoRotDeadDeg * Math.PI / 180) { sc.rotateBy(objId, 0, 0, -dth); t.thApplied = th; }
    const k = t.dApplied / t.d0;
    const x = mid.x + t.off.x * k, y = mid.y + t.off.y * k;
    if (Math.abs(x - t.objPos.x) + Math.abs(y - t.objPos.y) > 0.05) { t.objPos = { x, y }; sc.setGrabPose(objId, x, y); }
    for (const id of g.hands) { const o = this.hs.get(id); if (o && o.grab) o.grab.objPos = { x, y }; }
  }

  // ------------------------------------------------------------------ fist rotate
  _rotateStart(h, s, sel, nowMs, out) {
    s.mode = 'rotate';
    s.rot = { objId: sel, last: { ...h.palmCenter }, v: { x: 0, y: 0 }, vHist: [] };
    this.scene.beginTransform(sel);
    out.intents.push({ type: 'rotateStart', id: sel }); out.events.push('rotate');
    this.stats.rotates++; this.stats.rotateTimes.push(nowMs);
  }

  _rotateUpdate(h, s, nowMs, out) {
    const C = this.cfg.interact;
    const r = s.rot;
    if (h.pose !== 'fist' || this.scene.getScreenInfo(r.objId) == null) { this._rotateEnd(h, s, nowMs, out, true); return; }
    if (h.recovered) r.last = { ...h.palmCenter };   // back from a dropout: no jump for the motion in the gap (R2-3)
    const dx = h.palmCenter.x - r.last.x, dy = h.palmCenter.y - r.last.y;
    r.last = { ...h.palmCenter };
    // fling velocity = fastest sample of the last 200 ms (the pose debounce means the hand has already
    // stopped by the time the fist officially ends)
    r.vHist.push({ t: nowMs, x: h.velocity.x, y: h.velocity.y });
    while (r.vHist.length && nowMs - r.vHist[0].t > 200) r.vHist.shift();
    r.v = r.vHist.reduce((m, e) => (Math.hypot(e.x, e.y) > Math.hypot(m.x, m.y) ? e : m), { x: 0, y: 0 });
    const p = Math.max(1, h.palmPx);
    const ay = dx / p * C.rotGainPalm, ax = dy / p * C.rotGainPalm;
    if (Math.abs(ax) + Math.abs(ay) > 1e-5) this.scene.rotateBy(r.objId, ax, ay, 0);
  }

  _rotateEnd(h, s, nowMs, out, fling) {
    const C = this.cfg.interact;
    const r = s.rot;
    if (fling && h && !h.lost) {
      const p = Math.max(1, h.palmPx);
      if (Math.hypot(r.v.x, r.v.y) / p > C.flingPalmPerS) {
        const wx = clamp(r.v.y / p * C.rotGainPalm, -C.spinMax, C.spinMax), wy = clamp(r.v.x / p * C.rotGainPalm, -C.spinMax, C.spinMax);
        this.scene.setSpin(r.objId, wx, wy);
        out.intents.push({ type: 'spin', id: r.objId, wx, wy });
      }
    }
    if (this.scene.getScreenInfo(r.objId) != null) this.scene.endTransform(r.objId);
    s.mode = 'idle'; s.rot = null;
    this.rotateEndAt = nowMs;
    out.intents.push({ type: 'rotateEnd', id: r.objId });
  }

  // ------------------------------------------------------------------ one-hand squeeze scale ('spread')
  _spreadArm(h, s, sel, nowMs, out, dt) {
    const C = this.cfg.interact;
    if (h.speedPalm < C.spreadSpeedPalm) s.spreadMs += dt; else s.spreadMs = 0;
    if (s.spreadMs >= C.spreadHoldMs) {
      s.spreadMs = 0;
      const f = new OneEuroFilter(C.squeezeFilter);
      const r0 = f.filter(h.pinchRatio, nowMs);
      s.mode = 'squeeze';
      s.sq = { objId: sel, f, rApplied: r0, hist: [], otherSince: null };
      this.scene.beginTransform(sel);
      out.intents.push({ type: 'squeezeStart', id: sel }); out.events.push('scale');
      this.stats.squeezes++; this.stats.squeezeTimes.push(nowMs);
    }
  }

  _squeezeUpdate(h, s, nowMs, out) {
    const C = this.cfg.interact;
    const q = s.sq;
    if (this.scene.getScreenInfo(q.objId) == null || this.scene.getSelected() !== q.objId) { this._squeezeEnd(s, nowMs, out, false); return; }
    // 'point' keeps the squeeze only while the thumb is still out (small L angle) or near the index tip (a full
    // close passes through 'point' on its way to a pinch). A TUCKED-thumb point is the user pointing elsewhere:
    // it ends the squeeze like any other pose, and the tuck itself is not applied as a resize (R2-4).
    const tucked = h.pose === 'point' && h.cls?.thumbExt === false && !(h.pinchRatio < this.cfg.pinch.exit);
    const keep = h.pose === 'spread' || (h.pose === 'point' && !tucked) || h.pose === 'pinch' || h.pinch;
    if (keep) q.otherSince = null;
    else if (q.otherSince == null) q.otherSince = nowMs;
    else if (nowMs - q.otherSince >= C.squeezeExitMs) { this._squeezeEnd(s, nowMs, out, true); return; }
    if (!keep) return; // don't scale while the hand is changing pose
    const r = Math.max(0.02, q.f.filter(h.pinchRatio, nowMs));
    if (Math.abs(Math.log(r / q.rApplied)) > C.squeezeDead) {
      const f = Math.pow(r / q.rApplied, C.squeezeExp);
      this.scene.scaleBy(q.objId, f);
      q.hist.push({ t: nowMs, f });
      out.intents.push({ type: 'scale', id: q.objId, factor: f });
      q.rApplied = r;
    }
    while (q.hist.length && nowMs - q.hist[0].t > 1000) q.hist.shift();
  }

  _squeezeEnd(s, nowMs, out, rewind) {
    const C = this.cfg.interact;
    const q = s.sq;
    if (rewind && q.otherSince != null) {
      let undo = 1;
      for (const e of q.hist) if (e.t >= q.otherSince - C.squeezeRewindMs) undo *= e.f;
      if (Math.abs(undo - 1) > 1e-4) this.scene.scaleBy(q.objId, 1 / undo);
    }
    if (this.scene.getScreenInfo(q.objId) != null) this.scene.endTransform(q.objId);
    s.mode = 'idle'; s.sq = null;
    out.intents.push({ type: 'squeezeEnd', id: q.objId });
  }

  // ------------------------------------------------------------------ pinky delete
  _deleteUpdate(h, s, sel, live, nowMs, out, dt, isBlocked) {
    const C = this.cfg.interact;
    const d = s.del;
    if (sel == null || d.done) return;
    if (this.grabs.has(sel)) { d.ms = 0; d.frames = 0; return; } // another hand is holding it
    const others = live.some(o => o.id !== h.id && dist2(o.palmCenter, h.palmCenter) < C.deleteOtherPalm * h.palmPx);
    const ok = !isBlocked && Math.abs(h.nz) > C.deleteNz && !others && h.speedPalm < C.deleteSpeedPalm;
    if (!ok) { d.ms = 0; d.frames = 0; return; }
    d.ms += dt; if (h.fresh !== false) d.frames++;   // one per detection result (R2-5)
    if (d.ms >= C.deleteHoldMs && d.frames >= C.deleteFrames) {
      d.done = true;
      this.scene.remove(sel);
      out.intents.push({ type: 'delete', id: sel }); out.events.push('delete');
      this.stats.deletes++; this.stats.deleteTimes.push(nowMs);
    }
  }

  // ------------------------------------------------------------------ point: hover-select + UI dwell
  _point(h, s, sel, nowMs, out, dt) {
    const C = this.cfg.interact, sc = this.scene;
    const ui = this._uiDwell(h, s, nowMs, out, dt);
    if (ui === 'on') { s.hover.id = null; s.hover.ms = 0; }
    if (ui) return null; // on, or briefly off, a UI target: keep the dwell, no object hover
    const tip = h.indexTip;
    const spd = s.idxSpeed / Math.max(1, h.palmPx);
    const slop = Math.max(C.pickSlopMinPx, C.pickSlopPalm * h.palmPx);
    const id = sc.pick(tip.x, tip.y, slop);
    const hv = s.hover;
    if (id !== hv.id) { hv.id = id; hv.ms = 0; hv.onSel = false; }
    // pointing at the selected object: once it is deselected elsewhere (👍 of the other hand) this finger does not
    // re-select it until it leaves the object or the pose changes
    if (id != null && id === sel) { hv.ms = 0; hv.onSel = true; }
    if (id != null && id !== sel && !hv.onSel) {
      if (spd < C.hoverSpeedPalm) hv.ms += dt;
      if (hv.ms >= C.hoverSelectMs) {
        sc.select(id); hv.ms = 0;
        this.selectAt = nowMs;
        if (h.pose === 'spread') s.spreadOk = false;
        out.intents.push({ type: 'select', id }); out.events.push('select');
        this.stats.selects++;
      }
    }
    return id;
  }

  /** UI-dwell part of point. Returns 'on' (tip on a UI target), 'near' (briefly off it, dwell kept) or null. */
  _uiDwell(h, s, nowMs, out, dt) {
    const C = this.cfg.interact;
    const tip = h.indexTip;
    const spd = s.idxSpeed / Math.max(1, h.palmPx);
    const hit = this.uiHit ? this.uiHit(tip.x, tip.y) : null;
    const dw = s.dwell;
    if (hit) {
      if (dw.id === hit.id) {
        dw.lastOn = nowMs;
        if (!dw.done && spd < C.uiSpeedPalm) dw.p = Math.min(1, dw.p + dt / C.uiDwellMs);
        if (!dw.done && dw.p >= 1) {
          dw.done = true; dw.doneAt = nowMs;
          out.intents.push({ type: 'uiClick', id: hit.id }); this.stats.uiClicks++;
        }
      } else if (dw.id == null || nowMs - dw.lastOn > C.uiOffTargetMs) {
        dw.id = hit.id; dw.p = 0; dw.done = false; dw.lastOn = nowMs;
      }
      out.intents.push({ type: 'uiDwell', id: dw.id, progress: dw.p, hand: h.id });
      return 'on';
    }
    this._dwellExpire(s, nowMs);
    return dw.id != null ? 'near' : null;
  }

  /** Drop the dwell once the tip has been off its target (position or pose) for longer than uiOffTargetMs. */
  _dwellExpire(s, nowMs) {
    const dw = s.dwell;
    if (dw.id != null && nowMs - dw.lastOn > this.cfg.interact.uiOffTargetMs) { dw.id = null; dw.p = 0; dw.done = false; }
  }

  // ------------------------------------------------------------------ open-hand swipe → spin
  _swipeDetect(h, s, nowMs, inAlchemy) {
    const C = this.cfg.interact;
    if (inAlchemy) return;
    const hist = h.rawHistory || [];
    const win = hist.filter(e => nowMs - e.t <= C.swipeMs);
    if (win.length < C.swipeMinDetections) return;
    const a = win[0], b = win[win.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const p = Math.max(1, h.palmPx);
    const mag = Math.hypot(dx, dy);
    if (mag < C.swipePalm * p) return;
    let axis = null, sign = 0;
    if (Math.abs(dx) > 2 * Math.abs(dy)) { axis = 'y'; sign = Math.sign(dx); }
    else if (Math.abs(dy) > 2 * Math.abs(dx)) { axis = 'x'; sign = Math.sign(dy); }
    if (!axis) return;
    const L = s.lastSwipe;
    if (L && L.axis === axis && L.sign !== sign && nowMs - L.t < C.swipeOppositeMs) return;
    if (L && L.axis === axis && L.sign === sign && nowMs - L.t < C.swipeRepeatMs) return;
    s.lastSwipe = { axis, sign, t: nowMs };
    const speedPalm = mag / p / Math.max(0.033, (b.t - a.t) / 1000);
    this.pendingSwipes.push({ hand: h.id, axis, sign, t: nowMs, spin: sign * Math.min(C.spinMax, C.swipeGain * speedPalm) });
  }

  _flushSwipes(nowMs, alch, out) {
    const C = this.cfg.interact;
    if (!this.pendingSwipes.length) return;
    if (alch.phase === 'armed' || alch.phase === 'growing' || alch.event) { this.pendingSwipes = []; return; }
    const keep = [];
    for (const sw of this.pendingSwipes) {
      if (sw.dead) continue;
      const opp = this.pendingSwipes.find(o => o !== sw && o.hand !== sw.hand && o.axis === sw.axis && o.sign !== sw.sign && Math.abs(o.t - sw.t) <= C.swipePairMs);
      if (opp) { sw.dead = true; opp.dead = true; continue; }
      if (nowMs - sw.t < C.swipePairMs) { keep.push(sw); continue; }
      const sel = this.scene.getSelected();
      if (sel != null && this.scene.getScreenInfo(sel) != null && !this.grabs.has(sel)) {
        const wx = sw.axis === 'x' ? sw.spin : 0, wy = sw.axis === 'y' ? sw.spin : 0;
        this.scene.setSpin(sel, wx, wy);
        out.intents.push({ type: 'spin', id: sel, wx, wy }); out.events.push('spin');
        this.stats.spins++; this.stats.swipeTimes.push(nowMs);
      }
      this.stats.swipes++;
    }
    this.pendingSwipes = keep.filter(s => !s.dead);
  }

  // ------------------------------------------------------------------ cursors
  _cursor(h, s, sel, out) {
    const C = this.cfg.interact;
    const c = { id: h.id, x: h.indexTipDisplay.x, y: h.indexTipDisplay.y, pose: h.pose, kind: 'idle', progress: 0, objId: null };
    if (s.mode === 'grab') {
      const grp = this.grabs.get(s.grab.objId);
      c.kind = 'grab'; c.objId = s.grab.objId; c.two = !!(grp && grp.hands.size >= 2);
      c.x = (h.screenDisplay[4].x + h.screenDisplay[8].x) / 2; c.y = (h.screenDisplay[4].y + h.screenDisplay[8].y) / 2;
    } else if (s.mode === 'rotate') { c.kind = 'rotate'; c.objId = s.rot.objId; c.x = h.palmCenter.x; c.y = h.palmCenter.y; }
    else if (s.mode === 'squeeze') { c.kind = 'squeeze'; c.objId = s.sq.objId; c.progress = 1; }
    else if (h.pinch) { c.kind = 'pinch'; c.x = (h.screenDisplay[4].x + h.screenDisplay[8].x) / 2; c.y = (h.screenDisplay[4].y + h.screenDisplay[8].y) / 2; }
    else if (h.pose === 'pinky' && sel != null) { c.kind = 'delete'; c.objId = sel; c.progress = Math.min(1, s.del.ms / C.deleteHoldMs); c.x = h.screenDisplay[20].x; c.y = h.screenDisplay[20].y; }
    else if (h.pose === 'spread' && sel != null && s.spreadMs > 0) { c.kind = 'spread'; c.objId = sel; c.progress = Math.min(1, s.spreadMs / C.spreadHoldMs); }
    else if (h.pose === 'point' || h.pose === 'spread') {
      if (s.dwell.id != null) { c.kind = 'dwell'; c.progress = s.dwell.p; c.uiId = s.dwell.id; }
      else if (s.hover.id != null && s.hover.id !== sel) { c.kind = 'hover'; c.objId = s.hover.id; c.progress = Math.min(1, s.hover.ms / C.hoverSelectMs); }
      else c.kind = 'point';
    }
    else if (h.pose === 'fist') { c.kind = 'fist'; c.x = h.palmCenter.x; c.y = h.palmCenter.y; }
    else if (h.pose === 'thumbup') c.kind = 'thumbup';
    else if (h.pose === 'open') c.kind = 'open';
    out.cursors.push(c);
  }

  // ------------------------------------------------------------------ teardown
  _endHand(id, s, nowMs, out, fling) {
    const h = this._handById(id) || { id, lost: true };
    if (s.mode === 'grab') this._grabEnd(h, s, nowMs, out, false);
    else if (s.mode === 'rotate') this._rotateEnd(h, s, nowMs, out, fling);
    else if (s.mode === 'squeeze') this._squeezeEnd(s, nowMs, out, false);
    s.mode = 'idle';
  }

  _endAll(nowMs) {
    const out = { intents: [], events: [] };
    for (const [id, s] of this.hs) this._endHand(id, s, nowMs, out, false);
    this.pendingSwipes = [];
  }
}
