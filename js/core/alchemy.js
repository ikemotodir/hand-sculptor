// PURE: two-hand 合掌→ひらく spawn detector (SPEC §5.4 as amended by §13.3).
// update(hands, nowMs, ctx) → AlchemyState. ctx = { grabbing:boolean, transformEndAt:number, releaseAt:number }
// (Interaction.alchemyCtx() returns exactly that).
import { dist2, clamp } from './handmath.js';
import { CORE } from '../config/core.js';
import { RENDER } from '../config/render.js';

const BLOCKED = new Set(['point', 'victory', 'pinky', 'fist', 'thumbup', 'pinch']);

/**
 * AlchemyState = { phase:'idle'|'armed'|'growing'|'cooldown', a, b (hand ids|null), mid {x,y}|null, dist px,
 *   progress 0..1, palmRef, armDist, commitDist, path:'close'|'merge'|'clap'|null, posA, posB,
 *   suppress:boolean (interaction must ignore a/b), ignore:number[] (hand ids interaction must ignore),
 *   armedAt, event: null | {type:'spawn', mid, distPx, sizePx, a, b} | {type:'cancel', reason} }
 */
export class Alchemy {
  constructor(cfg = CORE) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.phase = 'idle';
    this.a = null; this.b = null;
    this.hist = [];                 // [{t, live:[{id,x,y,p}]}]
    this.closeSince = new Map();    // pairKey → ms
    this.blockedPairs = new Set();  // pairs that must separate before re-arming
    this.known = new Map();         // id → {x,y,vx,vy,t,p}
    this.flatAt = new Map();        // id → last ms the hand had ≥3 fingers extended
    this.ignore = new Map();        // id → true while ignored after commit
    this.cooldownUntil = 0;
    this.lastReason = '';
    this.stats = { arms: 0, spawns: 0, cancels: 0, armPaths: { close: 0, merge: 0, clap: 0 }, cancelReasons: {} };
    this._s = null;
  }

  update(hands, nowMs, ctx = {}) {
    const A = this.cfg.alchemy;
    const live = hands.filter(h => !h.lost);
    let event = null;

    for (const h of live) {
      if (h.cls && h.cls.nExt >= 3) this.flatAt.set(h.id, nowMs);
      this.known.set(h.id, { x: h.palmCenterRaw.x, y: h.palmCenterRaw.y, vx: h.velocity.x, vy: h.velocity.y, t: nowMs, p: h.palmPx });
    }
    for (const id of [...this.known.keys()]) if (!hands.some(h => h.id === id)) { this.known.delete(id); this.flatAt.delete(id); }

    // post-commit ignore: until each hand is calm (or gone)
    for (const id of [...this.ignore.keys()]) {
      const h = hands.find(x => x.id === id);
      if (!h) { this.ignore.delete(id); continue; }
      if (!h.lost && h.speedPalm < A.calmPalmPerS && (this.phase !== 'cooldown')) this.ignore.delete(id);
    }

    // per-pair closeness timers + separation unblock
    const pairs = [];
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      const p = (a.palmPx + b.palmPx) / 2;
      const d = dist2(a.palmCenterRaw, b.palmCenterRaw);
      const elig = this._eligible(a, b, 'close');
      const close = d < A.closePalm * p;
      if (close && elig.ok) { if (!this.closeSince.has(key)) this.closeSince.set(key, nowMs); } else this.closeSince.delete(key);
      if (!close) this.blockedPairs.delete(key);
      pairs.push({ a, b, key, p, d, elig });
    }
    for (const key of [...this.closeSince.keys()]) if (!pairs.some(q => q.key === key)) this.closeSince.delete(key);

    if (this.phase === 'cooldown' && nowMs >= this.cooldownUntil) { this.phase = 'idle'; this.a = this.b = null; this._s = null; }

    if (this.phase === 'idle') {
      // Lockout after a GRAB release / two-hand transform end (from Interaction). A pinch that grabbed nothing does
      // not lock: on the demo a spurious pinch at 30.5 s would otherwise block the 31.2 s clap.
      const locked = ctx.grabbing || nowMs - (ctx.releaseAt ?? -1e9) < A.lockoutMs || nowMs - (ctx.transformEndAt ?? -1e9) < A.lockoutMs;
      if (!locked) {
        let best = null;
        for (const q of pairs) {
          if (this.blockedPairs.has(q.key)) continue;
          const loose = q.elig.ok ? q.elig : this._eligible(q.a, q.b, 'loose');
          if (!loose.ok) continue;
          if (this.ignore.has(q.a.id) || this.ignore.has(q.b.id)) continue;
          const mid = { x: (q.a.palmCenterRaw.x + q.b.palmCenterRaw.x) / 2, y: (q.a.palmCenterRaw.y + q.b.palmCenterRaw.y) / 2 };
          let path = null, blob = null;
          if (q.d < A.closePalm * q.p) {
            const since = this.closeSince.get(q.key);
            if (q.elig.ok && since != null && nowMs - since >= A.closeMs) path = 'close';
            else if ((blob = this._findBlob(mid, q.p, nowMs, A.mergeWindowMs))) path = 'merge';
            // joined palms are often not detected at all (demo 0.67–1.47 s, 31.0–31.2 s): both hands appear
            // together, already close, after a frame where neither was visible → same evidence as a merge blob
            else if (q.a.age <= A.appearMs && q.b.age <= A.appearMs && this._noneNear(mid, q.p, nowMs - Math.max(q.a.age, q.b.age))) path = 'merge';
          } else if (q.d <= A.lateMergeMaxPalm * q.p && (q.a.age < 400 || q.b.age < 400 || q.a.recovered || q.b.recovered || this._recentlyAbsent(q, nowMs))) {
            if ((blob = this._findBlob(mid, q.p, nowMs, A.lateMergeWindowMs))) path = 'clap';
          }
          if (path && (!best || q.d < best.q.d)) best = { q, path, mid, blob };
        }
        if (best) this._arm(best, nowMs);
      }
    }

    if (this.phase === 'armed' || this.phase === 'growing') event = this._track(hands, nowMs);

    // history (after decisions so the current frame is not its own blob)
    this.hist.push({ t: nowMs, live: live.map(h => ({ id: h.id, x: h.palmCenterRaw.x, y: h.palmCenterRaw.y, p: h.palmPx })) });
    while (this.hist.length && nowMs - this.hist[0].t > 1600) this.hist.shift();

    const s = this._s;
    const ignore = [...this.ignore.keys()];
    if ((this.phase === 'armed' || this.phase === 'growing') && s) {
      const st = {
        phase: this.phase, a: this.a, b: this.b, mid: s.mid, dist: s.dist, progress: s.progress, palmRef: s.palmRef,
        armDist: s.armDist, commitDist: s.commitDist, path: s.path, posA: s.posA, posB: s.posB, armedAt: s.armedAt,
        suppress: this.phase === 'growing' && s.progress > A.suppressProgress, ignore, event,
      };
      if (st.suppress) for (const id of [this.a, this.b]) if (!st.ignore.includes(id)) st.ignore.push(id);
      return st;
    }
    return {
      phase: this.phase, a: this.phase === 'cooldown' ? this.a : null, b: this.phase === 'cooldown' ? this.b : null,
      mid: this.phase === 'cooldown' && s ? s.mid : null, dist: 0, progress: this.phase === 'cooldown' ? 1 : 0,
      palmRef: s ? s.palmRef : 0, armDist: 0, commitDist: 0, path: s ? s.path : null, posA: null, posB: null, armedAt: 0,
      suppress: false, ignore, event,
    };
  }

  /**
   * SPEC §13.3 pair eligibility. mode 'close' = path (a) (both visible & close: flat, palms facing each other);
   * mode 'loose' = merge/clap paths (the joined palms are mis-detected for a few frames, so flatness is checked
   * at COMMIT instead, palm facing is skipped and the scale ratio is looser). Returns {ok, reason}.
   */
  _eligible(a, b, mode = 'close') {
    const A = this.cfg.alchemy, idc = this.cfg.identity;
    const close = mode === 'close';
    if (close && (!(a.cls && a.cls.nExt >= 3) || !(b.cls && b.cls.nExt >= 3))) return { ok: false, reason: 'notFlat' };
    const blocked = h => h.pinch || (close ? BLOCKED.has(h.pose) : (h.pose === 'fist' || h.pose === 'pinch'));
    if (blocked(a) || blocked(b)) return { ok: false, reason: 'pose' };
    // handedness only when both tracks have a stable label (labels flip at 0.95 on real data)
    if (a.handedStable && b.handedStable && a.handScore >= idc.handedScoreMin && b.handScore >= idc.handedScoreMin && a.handed === b.handed) return { ok: false, reason: 'sameHand' };
    const r = a.palmPx / b.palmPx;
    const rr = close ? A.scaleRatio : A.looseScaleRatio;
    if (r < rr[0] || r > rr[1]) return { ok: false, reason: 'scale' };
    const p = (a.palmPx + b.palmPx) / 2;
    if (Math.abs(a.palmCenterRaw.y - b.palmCenterRaw.y) > A.maxDyPalm * p) return { ok: false, reason: 'dy' };
    if (close && (Math.abs(a.nz) > A.maxNz || Math.abs(b.nz) > A.maxNz)) return { ok: false, reason: 'facing' };
    return { ok: true, reason: '' };
  }

  /**
   * Commit-time checks: each hand was open (≥3 fingers) at least once since arming and at least one is open now
   * (a hand pushed toward the camera reads as curled on real data — demo 7.3–8 s), and similar size.
   * Two fists moving apart never pass.
   */
  _commitOk(pa, pb, nowMs) {
    const A = this.cfg.alchemy, s = this._s;
    const flatNow = id => nowMs - (this.flatAt.get(id) ?? -1e9) <= A.flatRecentMs;
    for (const id of [this.a, this.b]) if (this.flatAt.has(id) && this.flatAt.get(id) >= s.armedAt - 200) s.wasFlat.add(id);
    if (!s.wasFlat.has(this.a) || !s.wasFlat.has(this.b)) return false;
    if (!flatNow(this.a) && !flatNow(this.b)) return false;
    if (pa.h && pb.h && !pa.h.lost && !pb.h.lost) {
      const r = pa.h.palmPx / pb.h.palmPx;
      if (r < A.scaleRatio[0] || r > A.scaleRatio[1]) return false;
    }
    return true;
  }

  /** A pair member was absent (not live) in some frame of the last freshMs → the pair is "fresh". */
  _recentlyAbsent(q, nowMs) {
    const win = this.cfg.alchemy.freshMs ?? 300;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      const f = this.hist[i];
      if (nowMs - f.t > win) break;
      if (!f.live.some(h => h.id === q.a.id) || !f.live.some(h => h.id === q.b.id)) return true;
    }
    return false;
  }

  /** In the last frame before tAppear no live hand was near `mid` (the pair just appeared there). */
  _noneNear(mid, p, tAppear) {
    let f = null;
    for (let i = this.hist.length - 1; i >= 0; i--) if (this.hist[i].t < tAppear) { f = this.hist[i]; break; }
    if (!f || tAppear - f.t > 200) return true;
    return !f.live.some(h => Math.hypot(h.x - mid.x, h.y - mid.y) < this.cfg.alchemy.closePalm * p);
  }

  /**
   * Frame (within windowMs) where exactly one hand was near `mid` and on the midpoint — the joined palms. Of those,
   * the one CLOSEST to the midpoint: once the spread starts, the single detection follows one hand outward (the
   * other is still undetected), and the most recent such frame is already off-centre (long data: 22.5 s, 19.6 s).
   */
  _findBlob(mid, p, nowMs, windowMs) {
    const A = this.cfg.alchemy;
    let best = null, bd = Infinity;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      const f = this.hist[i];
      if (nowMs - f.t > windowMs) break;
      const near = f.live.filter(h => Math.hypot(h.x - mid.x, h.y - mid.y) < A.closePalm * p);
      if (near.length !== 1) continue;
      const d = Math.hypot(near[0].x - mid.x, near[0].y - mid.y);
      if (d < A.mergeCenterPalm * p && d < bd - 1e-6) { bd = d; best = { t: f.t, x: near[0].x, y: near[0].y, id: near[0].id }; }
    }
    return best;
  }

  _arm({ q, path, mid, blob }, nowMs) {
    const A = this.cfg.alchemy;
    const palmRef = q.p;
    const late = path === 'clap';
    const armMid = blob && path !== 'close' ? { x: blob.x, y: blob.y } : mid;
    this.phase = 'armed';
    this.a = q.a.id; this.b = q.b.id;
    this._s = {
      path, palmRef, armedAt: nowMs, armDist: A.closePalm * palmRef, commitDist: A.commitPalm * palmRef,
      distAtArm: late ? 0 : q.d, armMid,
      startA: late ? armMid : { ...q.a.palmCenterRaw }, startB: late ? armMid : { ...q.b.palmCenterRaw },
      maxDist: q.d, lastGrowT: nowMs, prevDist: q.d, dist: q.d, progress: 0, mid, posA: { ...q.a.palmCenterRaw }, posB: { ...q.b.palmCenterRaw },
      dropped: false, dHist: [], wasFlat: new Set(), refrozen: path === 'close',
    };
    this.stats.arms++; this.stats.armPaths[path]++;
  }

  _pos(hands, id, nowMs, otherId) {
    const A = this.cfg.alchemy;
    const h = hands.find(x => x.id === id);
    if (h && !h.lost) return { x: h.palmCenterRaw.x, y: h.palmCenterRaw.y, live: true, h, id };
    const k = this.known.get(id) || this._lastKnown?.[id];
    if (!k) return null;
    const dt = nowMs - k.t;
    if (dt > A.graceMs) return null;
    const cap = k.p;
    const px = k.x + clamp(k.vx * dt / 1000, -cap, cap), py = k.y + clamp(k.vy * dt / 1000, -cap, cap);
    // re-acquire: the tracker gave the same hand a new id (identity break) → adopt the live hand at the prediction
    let best = null, bd = 1.5 * (this._s ? this._s.palmRef : cap);
    for (const o of hands) {
      if (o.lost || o.id === otherId || o.id === id) continue;
      const d = Math.hypot(o.palmCenterRaw.x - px, o.palmCenterRaw.y - py);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) return { x: best.palmCenterRaw.x, y: best.palmCenterRaw.y, live: true, h: best, id: best.id, adopted: true };
    return { x: px, y: py, live: false, h, id };
  }

  _cancel(reason) {
    this.stats.cancels++;
    this.stats.cancelReasons[reason] = (this.stats.cancelReasons[reason] || 0) + 1;
    const key = this.a < this.b ? `${this.a}-${this.b}` : `${this.b}-${this.a}`;
    if (reason === 'timeout' || reason === 'shrank' || reason === 'asymmetric') this.blockedPairs.add(key);
    this.phase = 'idle'; this.a = this.b = null; this._s = null;
    this.lastReason = reason;
    return { type: 'cancel', reason };
  }

  _track(hands, nowMs) {
    const A = this.cfg.alchemy;
    const s = this._s;
    // keep last-known positions of the pair even after the tracker drops them
    this._lastKnown = this._lastKnown || {};
    for (const id of [this.a, this.b]) { const k = this.known.get(id); if (k) this._lastKnown[id] = k; }
    const pa = this._pos(hands, this.a, nowMs, this.b);
    const pb = this._pos(hands, this.b, nowMs, pa ? pa.id : this.a);
    if (pa && pa.adopted) this.a = pa.id;
    if (pb && pb.adopted) this.b = pb.id;
    for (const p of [pa, pb]) {
      if (p && p.h && !p.h.lost && (p.h.pose === 'pinch' || p.h.pose === 'fist' || p.h.pinch)) return this._cancel('pinchOrFist');
    }
    const dropped = !pa || !pb || !pa.live || !pb.live;
    if (!pa || !pb) {
      // both gone / one gone beyond grace
      if (s.dropped && s.dist >= A.dropCommitFrac * s.commitDist && s.increasing && this._symmetric(s) && s.flatOk) return this._commit(nowMs);
      return this._cancel('lost');
    }
    const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    s.posA = { x: pa.x, y: pa.y }; s.posB = { x: pb.x, y: pb.y };
    s.mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    // merge/clap: the joined palms gave a bad scale at ARM → re-freeze palmRef once both hands are open
    if (!s.refrozen && pa.live && pb.live && pa.h.cls?.nExt >= 3 && pb.h.cls?.nExt >= 3) {
      s.refrozen = true;
      s.palmRef = (pa.h.palmPx + pb.h.palmPx) / 2;
      s.armDist = A.closePalm * s.palmRef; s.commitDist = A.commitPalm * s.palmRef;
    }
    s.increasing = d > s.prevDist + 0.02 * s.palmRef;
    s.prevDist = d; s.dist = d; s.dropped = dropped;
    if (d > s.maxDist) { s.maxDist = d; }
    s.dHist.push({ t: nowMs, d });
    while (s.dHist.length > 2 && nowMs - s.dHist[1].t >= A.stallMs) s.dHist.shift();
    // growth over the last stallMs (rate gate): < stallPalm·palmRef → the hands stopped opening
    const ref = s.dHist[0];
    s.growth = nowMs - ref.t >= A.stallMs * 0.8 ? d - ref.d : Infinity;
    if (s.growth > A.stallPalm * s.palmRef) s.lastGrowT = nowMs;

    if (this.phase === 'armed') {
      if (d >= s.armDist) { this.phase = 'growing'; s.growAt = nowMs; s.lastGrowT = nowMs; }
      else if (nowMs - s.armedAt > A.armTimeoutMs) return this._cancel('timeout');
    }
    if (this.phase === 'growing') {
      s.progress = clamp((d - s.armDist) / (s.commitDist - s.armDist), 0, 1);
      if (d < s.armDist) return this._cancel('shrank');
      // the spawn must follow the spread: once wide enough, a commit that is still blocked (scale / flat / symmetry)
      // after commitLateMs is a stale pose held open, not 合掌→ひらく (long data 244.9 s: committed 1.3 s late)
      if (d >= s.commitDist && s.wideAt == null) s.wideAt = nowMs;
      if (s.wideAt != null && nowMs - s.wideAt > (A.commitLateMs ?? Infinity)) return this._cancel('late');
      const stalled = s.growth <= A.stallPalm * s.palmRef;
      const sym = this._symmetric(s);
      s.flatOk = this._commitOk(pa, pb, nowMs);
      if (sym && s.flatOk && ((d >= s.commitDist && (stalled || d >= A.maxPalm * s.palmRef)) ||
                  (dropped && d >= A.dropCommitFrac * s.commitDist && s.increasing))) return this._commit(nowMs);
      if (stalled && !sym && d >= s.commitDist) return this._cancel('asymmetric');
      if (nowMs - s.lastGrowT > A.armTimeoutMs || nowMs - s.growAt > A.growMaxMs) return this._cancel('timeout');
    }
    return null;
  }

  /** Each hand moved ≥ symmetricFrac of the spread away from the arm midpoint. */
  _symmetric(s) {
    const A = this.cfg.alchemy;
    const spread = s.dist - s.distAtArm;
    if (spread <= 0) return false;
    const need = A.symmetricFrac * spread;
    const ra = Math.hypot(s.posA.x - s.armMid.x, s.posA.y - s.armMid.y) - Math.hypot(s.startA.x - s.armMid.x, s.startA.y - s.armMid.y);
    const rb = Math.hypot(s.posB.x - s.armMid.x, s.posB.y - s.armMid.y) - Math.hypot(s.startB.x - s.armMid.x, s.startB.y - s.armMid.y);
    return ra >= need && rb >= need;
  }

  _commit(nowMs) {
    const A = this.cfg.alchemy;
    const s = this._s;
    s.progress = 1;
    const ev = { type: 'spawn', mid: { ...s.mid }, distPx: s.dist, sizePx: s.dist * A.sizeFactor, a: this.a, b: this.b, path: s.path };
    this.ignore.set(this.a, true); this.ignore.set(this.b, true);
    this.phase = 'cooldown';
    this.cooldownUntil = nowMs + A.cooldownMs;
    this.stats.spawns++;
    return ev;
  }
}

/**
 * Spawn style picker (SPEC §13.3): 🎲 random shape (never the same twice in a row) + random color unless the
 * user fixed them; `rareChance` → gold 'rare' spawn. rng is injectable for tests.
 * pick({type:'random'|shape, colorIdx:-1|idx}) → {type, color, colorIdx, rare}
 */
export class SpawnStyler {
  constructor({ shapes, colors, rareChance = CORE.alchemy.rareChance, rareColor = CORE.alchemy.rareColor, rng = Math.random } = {}) {
    this.shapes = shapes || RENDER.shapes;
    this.colors = colors || RENDER.colors;
    this.rareChance = rareChance; this.rareColor = rareColor; this.rng = rng;
    this.lastType = null;
  }
  pick({ type = 'random', colorIdx = -1 } = {}) {
    let t = type;
    if (!t || t === 'random') {
      const opts = this.shapes.filter(s => s !== this.lastType);
      t = opts[Math.floor(this.rng() * opts.length) % opts.length];
    }
    this.lastType = t;
    const rare = this.rng() < this.rareChance;
    let ci = colorIdx;
    if (ci == null || ci < 0) ci = Math.floor(this.rng() * this.colors.length) % this.colors.length;
    return { type: t, colorIdx: ci, color: rare ? this.rareColor : this.colors[ci], rare };
  }
}
