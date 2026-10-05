// スマホ連携: TrackedHand stream -> phone commands. PURE (no DOM / THREE / window; time passed in).
//
//   const pm = new PhoneMode();
//   const cmds = pm.update(hands, { W, H, left, top }, nowMs);   // -> [{t:'cmd', action, ...}]
//   W, H, left, top = the stage rect in page px (hand coords are page px; in pillarboxed 縦 the stage is offset).
//   `hands` may include lost:true tracks; a hand missing for ≤ lostGraceMs (one or a few dropped detection
//   frames) holds the primary, the pinch / drag and the zoom instead of ending them.
//
// Commands (x, y are 0..1 on the phone screen):
//   {t:'cmd', action:'cursor', x, y, pose}                      throttled (moved > 0.004 or 50 ms)
//   {t:'cmd', action:'tap',    x, y}                            quick pinch (< 350 ms, small movement)
//   {t:'cmd', action:'drag',   phase:'start'|'move'|'end', x, y} pinch-hold + move (scroll / pan)
//   {t:'cmd', action:'swipe',  dir:'left'|'right'|'up'|'down'}  fast open-hand move
//   {t:'cmd', action:'zoom',   phase:'start'|'move'|'end', scale} both hands pinching; scale relative to gesture start
//   {t:'cmd', action:'hide'}                                    no hand for hideMs
//
// Screen px come from the shared mapping (mirror already applied), so "right" is the user's right.

export const PHONE_DEFAULTS = {
  margin: 0.15,            // cursor x = clamp((sx/W - m) / (1 - 2m))
  cursorMinMove: 0.004,    // send cursor when moved more than this (normalized)...
  cursorMaxMs: 50,         // ...or when this much time passed and it moved at all
  cursorEps: 0.0005,
  tapMaxMs: 350,           // pinch shorter than this with little movement -> tap
  tapBackMs: 120,          // tap / drag-start position = cursor from this long before pinch onset
  onsetFrames: 2,          // pinch must be seen this many consecutive updates
  dragStartPalm: 0.5,      // pinch-point movement (x palmPx) that turns a pinch into a drag
  dragStartNorm: 0.03,     // ...or this much in normalized cursor units
  swipeDistPalm: 2.5,      // palm-center displacement (x palmPx) ...
  swipeWindowMs: 200,      // ...within this window
  swipeMinSamples: 3,
  swipeCooldownMs: 450,    // no second swipe this soon
  swipeOppositeMs: 700,    // ignore the return stroke
  hideMs: 300,
  zoomDeadLn: 0.02,        // send zoom only when |ln(scale/lastSent)| exceeds this
  historyMs: 400,
  lostGraceMs: 300,        // = tracker graceMs / SPEC §13.4 grab hold: a dropout this short keeps primary + pinch + zoom
  switchFrames: 2,         // R3-13: an idle primary hands over to another hand that points / pinches this many updates in a row
};

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const OPEN = new Set(['open']);
const isActive = h => !!h.pinch || h.pose === 'pinch' || h.pose === 'point';

export function cursorFromScreen(sx, sy, W, H, margin = PHONE_DEFAULTS.margin) {
  const span = 1 - 2 * margin;
  return { x: clamp01((sx / W - margin) / span), y: clamp01((sy / H - margin) / span) };
}

function palmPxOf(h) { return h.palmPx > 0 ? h.palmPx : 80; }
function tipOf(h) { return h.indexTip || (h.screen && h.screen[8]) || h.palmCenter || { x: 0, y: 0 }; }
function pinchPtOf(h) { return h.pinchPoint || tipOf(h); }

export class PhoneMode {
  constructor(cfg = {}) {
    this.cfg = { ...PHONE_DEFAULTS, ...cfg };
    this.reset();
  }

  reset() {
    this.primaryId = null;
    this.cursor = null;            // last computed {x,y}
    this.sent = null;              // last sent cursor {x,y,t,pose}
    this.cursorHist = [];          // [{t,x,y}] cursor positions (not while pinching)
    this.lastSeen = -Infinity;
    this.hidden = true;
    this.pinchFrames = 0;
    this.pinch = null;             // active pinch {t0, start:{x,y}, p0:{x,y}, dragging, cursor0, palmPx}
    this.zoom = null;              // {d0, otherId, lastSent}
    this.zoomTail = null;          // R3-13: zoom partner still pinching after the zoom ended; needs a fresh pinch
    this.primSeenAt = -Infinity;   // last update the primary hand was live
    this.seenAt = new Map();       // id -> last live time (zoom partner grace)
    this.palmHist = new Map();     // id -> [{t,x,y,open,pinch}]
    this.activeRun = new Map();    // id -> consecutive updates pointing / pinching (R3-13 hand-over)
    this.lastSwipe = { t: -Infinity, dir: null };
    this.stats = { tap: 0, drag: 0, swipe: 0, zoom: 0, cursor: 0 };
  }

  /** @returns {object[]} commands to send, in order */
  update(hands, view, nowMs) {
    const c = this.cfg, out = [];
    const W = view.W, H = view.H, left = view.left || 0, top = view.top || 0;
    const live = (hands || []).filter(h => h && !h.lost);
    for (const h of live) this.seenAt.set(h.id, nowMs);
    for (const [id, t] of this.seenAt) if (nowMs - t > 2000) this.seenAt.delete(id);

    // ---- swipe history (all hands) ----
    for (const h of live) {
      const pc = h.palmCenterRaw || h.palmCenter || tipOf(h); // raw palm center (spec 13.4): filters lag fast swipes
      let hist = this.palmHist.get(h.id);
      if (!hist) this.palmHist.set(h.id, hist = []);
      hist.push({ t: nowMs, x: pc.x, y: pc.y, open: OPEN.has(h.pose) || OPEN.has(h.rawPose), pinch: !!h.pinch });
      while (hist.length && nowMs - hist[0].t > c.swipeWindowMs) hist.shift();
    }
    for (const id of [...this.palmHist.keys()]) if (!live.some(h => h.id === id)) this.palmHist.delete(id);
    for (const h of live) this.activeRun.set(h.id, isActive(h) ? (this.activeRun.get(h.id) || 0) + 1 : 0);
    for (const id of [...this.activeRun.keys()]) if (!live.some(h => h.id === id)) this.activeRun.delete(id);
    // the zoom partner's leftover pinch is not a new pinch: forget it once that hand lets go (or is gone)
    if (this.zoomTail != null && (live.some(h => h.id === this.zoomTail && !h.pinch) || !this.seenAt.has(this.zoomTail))) this.zoomTail = null;

    if (!live.length) {
      // dropout: hold an active pinch / zoom through the grace window (no split drag, no spurious tap)
      if ((this.pinch || this.zoom) && nowMs - this.lastSeen <= c.lostGraceMs) return out;
      if (this.pinch) out.push(...this._endPinch(nowMs, false));
      if (this.zoom) out.push(this._endZoom());
      this.pinchFrames = 0;
      if (!this.hidden && nowMs - this.lastSeen > c.hideMs) {
        this.hidden = true; this.sent = null; this.primaryId = null; this.cursorHist.length = 0;
        out.push({ t: 'cmd', action: 'hide' });
      }
      return out;
    }
    this.lastSeen = nowMs;

    // ---- primary hand: keep the current one; else prefer pointing / pinching ----
    let prim = live.find(h => h.id === this.primaryId);
    // primary missed a few frames while another hand is visible: keep it (and its pinch) instead of switching
    if (!prim && this.primaryId != null && nowMs - this.primSeenAt <= c.lostGraceMs) return out;
    if (!prim) {
      prim = live.find(h => h.pinch || h.pose === 'pinch') || live.find(h => h.pose === 'point') || live[0];
      this._newPrimary(prim, nowMs, out);
    } else if (!this.pinch && !this.zoom && !isActive(prim)) {
      // R3-13: the sticky primary is idle (e.g. a bystander's open hand) -> hand over to a hand that points / pinches
      const ok = h => h.id !== prim.id && (this.activeRun.get(h.id) || 0) >= c.switchFrames;
      const next = live.find(h => ok(h) && (h.pinch || h.pose === 'pinch')) || live.find(ok);
      if (next) { prim = next; this._newPrimary(prim, nowMs, out); }
    }
    this.primSeenAt = nowMs;
    const pp = palmPxOf(prim);

    // ---- two-hand zoom: both hands pinching ----
    // zoom partner missed a few frames: hold the zoom
    if (this.zoom && !live.some(h => h.id === this.zoom.otherId) && nowMs - (this.seenAt.get(this.zoom.otherId) ?? -Infinity) <= c.lostGraceMs) return out;
    // partner is never the primary itself (R3-1) and is a pinching hand when there is one (R3-13)
    const other = (this.zoom && this.zoom.otherId !== prim.id && live.find(h => h.id === this.zoom.otherId))
      || live.find(h => h.id !== prim.id && h.pinch) || live.find(h => h.id !== prim.id);
    const bothPinch = other && prim.pinch && other.pinch;
    if (bothPinch) {
      const d = dist(pinchPtOf(prim), pinchPtOf(other));
      if (!this.zoom) {
        if (this.pinch) out.push(...this._endPinch(nowMs, false, true));
        this.zoom = { d0: Math.max(1, d), otherId: other.id, lastSent: 1 };
        this.stats.zoom++;
        out.push({ t: 'cmd', action: 'zoom', phase: 'start', scale: 1 });
      } else {
        const s = d / this.zoom.d0;
        if (s > 0 && Number.isFinite(s) && Math.abs(Math.log(s / this.zoom.lastSent)) > c.zoomDeadLn) {
          this.zoom.lastSent = s;
          out.push({ t: 'cmd', action: 'zoom', phase: 'move', scale: +s.toFixed(4) });
        }
      }
      return out; // no cursor / tap while zooming
    }
    if (this.zoom) {
      if (this.zoom.otherId !== prim.id) this.zoomTail = this.zoom.otherId;
      out.push(this._endZoom());
      this.pinchFrames = prim.pinch ? -1e9 : 0; // require a fresh pinch after zoom
    }

    // ---- cursor ----
    const tip = tipOf(prim);
    const raw = cursorFromScreen(tip.x - left, tip.y - top, W, H, c.margin);

    // ---- pinch state ----
    if (prim.pinch) this.pinchFrames++; else this.pinchFrames = 0;
    const pinching = this.pinchFrames >= c.onsetFrames;

    if (pinching && !this.pinch) {
      // onset: use the cursor from tapBackMs ago (the tip dips while the fingers close)
      const back = this._cursorAt(nowMs - c.tapBackMs) || this.cursor || raw;
      this.pinch = { t0: nowMs, p0: { ...pinchPtOf(prim) }, start: { x: back.x, y: back.y }, dragging: false, palmPx: pp, lastDrag: null };
    }

    let cur;
    if (this.pinch) {
      const pt = pinchPtOf(prim);
      const dxN = (pt.x - this.pinch.p0.x) / (W * (1 - 2 * c.margin));
      const dyN = (pt.y - this.pinch.p0.y) / (H * (1 - 2 * c.margin));
      cur = { x: clamp01(this.pinch.start.x + dxN), y: clamp01(this.pinch.start.y + dyN) };
      if (!pinching) {
        out.push(...this._endPinch(nowMs, true, false, cur));
      } else {
        const movedPx = dist(pt, this.pinch.p0);
        const movedN = Math.hypot(dxN, dyN);
        if (!this.pinch.dragging && (movedPx > c.dragStartPalm * this.pinch.palmPx || movedN > c.dragStartNorm)) {
          this.pinch.dragging = true; this.stats.drag++;
          out.push({ t: 'cmd', action: 'drag', phase: 'start', x: r4(this.pinch.start.x), y: r4(this.pinch.start.y) });
          this.pinch.lastDrag = { ...this.pinch.start };
        }
        if (this.pinch.dragging && dist(cur, this.pinch.lastDrag) > c.cursorEps) {
          this.pinch.lastDrag = cur;
          out.push({ t: 'cmd', action: 'drag', phase: 'move', x: r4(cur.x), y: r4(cur.y) });
        }
      }
    } else {
      cur = raw;
      this.cursorHist.push({ t: nowMs, x: raw.x, y: raw.y });
      while (this.cursorHist.length && nowMs - this.cursorHist[0].t > c.historyMs) this.cursorHist.shift();
    }
    this.cursor = cur;

    // ---- cursor send (throttled) ----
    const pose = this.pinch ? 'pinch' : (prim.pose || 'neutral');
    const s = this.sent;
    const moved = s ? dist(cur, s) : Infinity;
    if (!s || moved > c.cursorMinMove || (nowMs - s.t >= c.cursorMaxMs && (moved > c.cursorEps || s.pose !== pose))) {
      this.sent = { x: cur.x, y: cur.y, t: nowMs, pose };
      this.hidden = false; this.stats.cursor++;
      out.push({ t: 'cmd', action: 'cursor', x: r4(cur.x), y: r4(cur.y), pose });
    }

    // ---- swipe (any hand that is not pinching) ----
    if (!this.pinch && !this.zoom) {
      for (const h of live) {
        const dir = this._swipe(h, nowMs);
        if (dir) { out.push({ t: 'cmd', action: 'swipe', dir }); break; }
      }
    }
    return out;
  }

  // switch the primary: end a zoom with its last scale (R3-1), end a pinch, restart the cursor history
  _newPrimary(prim, nowMs, out) {
    if (this.pinch) out.push(...this._endPinch(nowMs, false));
    const hadZoom = !!this.zoom;
    if (hadZoom) { this.zoomTail = this.zoom.otherId; out.push(this._endZoom()); }
    this.primaryId = prim.id;
    // after a zoom the new primary needs a fresh pinch; so does the zoom partner that took over still pinching (R3-13)
    this.pinchFrames = (hadZoom || (prim.pinch && prim.id === this.zoomTail)) ? -1e9 : 0;
    this.cursorHist.length = 0; this.cursor = null;
  }

  _cursorAt(t) {
    const h = this.cursorHist;
    if (!h.length) return null;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) return h[i];
    return h[0];
  }

  _endPinch(nowMs, allowTap, silent = false, cur = null) {
    const p = this.pinch, out = [];
    this.pinch = null;
    if (!p || silent) return out;
    const c = this.cfg;
    if (p.dragging) {
      const e = cur || p.lastDrag || p.start;
      out.push({ t: 'cmd', action: 'drag', phase: 'end', x: r4(e.x), y: r4(e.y) });
    } else if (allowTap && nowMs - p.t0 < c.tapMaxMs) {
      this.stats.tap++;
      out.push({ t: 'cmd', action: 'tap', x: r4(p.start.x), y: r4(p.start.y) });
    }
    // after a pinch the cursor resumes from the tap point; restart history
    this.cursorHist.length = 0;
    return out;
  }

  _endZoom() {
    const z = this.zoom; this.zoom = null;
    return { t: 'cmd', action: 'zoom', phase: 'end', scale: +(z ? z.lastSent : 1).toFixed(4) };
  }

  _swipe(h, nowMs) {
    const c = this.cfg, hist = this.palmHist.get(h.id);
    if (!hist || hist.length < c.swipeMinSamples) return null;
    if (hist.some(s => s.pinch)) return null;
    const openN = hist.filter(s => s.open).length;
    if (openN < Math.ceil(hist.length * 0.6)) return null;
    const a = hist[0], b = hist[hist.length - 1];
    if (b.t - a.t > c.swipeWindowMs) return null;
    const dx = b.x - a.x, dy = b.y - a.y;
    const need = c.swipeDistPalm * palmPxOf(h);
    if (Math.hypot(dx, dy) < need) return null;
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    const since = nowMs - this.lastSwipe.t;
    if (since < c.swipeCooldownMs) return null;
    if (since < c.swipeOppositeMs && OPPOSITE[dir] === this.lastSwipe.dir) return null;
    this.lastSwipe = { t: nowMs, dir };
    this.stats.swipe++;
    hist.length = 0; // one swipe per stroke
    return dir;
  }
}

const OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up' };
function r4(v) { return Math.round(v * 10000) / 10000; }
