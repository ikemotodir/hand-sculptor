// 2D overlay canvas above WebGL: hand skeletons, fingertip reticles, pinch line, dwell/hover rings,
// delete ring, ⇔ squeeze ring, hand lock-on effect, alchemy energy lines (the sigil itself is 3D in fx.js).
// SPEC §7, §12, §13.5 (draw the light-filtered `screenDisplay` of the SAME detected frame), §13.7 lock-on.
//
// draw({ hands, cursors, alchemy, showBones, nowMs })
//   hands:   TrackedHand[] — uses id, lost, screenDisplay|screen [{x,y}]×21, palmPx, pinch, pinchRatio, pinchPoint
//   cursors: [{id (hand id), x, y, pose, kind, progress, target?:{x,y,r}}]
//            kind: 'point' | 'hover' | 'dwell' | 'pinch' | 'grab' | 'rotate' | 'fist' | 'delete' | 'spread' | 'scale' | 'squeeze' | other
//   alchemy: AlchemyState | null — phase 'armed'|'growing' draws energy lines from both palms (ids a,b) to mid
// All coordinates are CSS px from core/mapping.js. Crisp at any dpr.

const CONN = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const TIPS = [4, 8, 12, 16, 20];
const PALM = [0, 5, 9, 13, 17];
/** hand 1 cyan, hand 2 orange (v1), extra hands other hues */
export const HAND_COLORS = ['#00f0ff', '#ff8a3d', '#00ffa3', '#b18cff', '#ff4fd8', '#ffe14d'];
const YELLOW = '#ffe14d', RED = '#ff3b5c', WHITE = '#ffffff';
const MONO = 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, Menlo, monospace';
const LOCK_MS = 600, TAG_MS = 1400;

// Stable color slots shared by the overlay and capture (so photos match the screen).
const slots = new Map();   // hand id → slot index
function slotOf(id) {
  if (slots.has(id)) return slots.get(id);
  const used = new Set(slots.values());
  let s = 0; while (used.has(s)) s++;
  slots.set(id, s);
  return s;
}
function releaseMissing(ids) { for (const id of [...slots.keys()]) if (!ids.has(id)) slots.delete(id); }
export function handColor(id) { return HAND_COLORS[slotOf(id) % HAND_COLORS.length]; }

const ptsOf = h => h.screenDisplay || h.screen;
function palmCenterOf(p) {
  let x = 0, y = 0; for (const i of PALM) { x += p[i].x; y += p[i].y; } return { x: x / 5, y: y / 5 };
}
function palmPxOf(h, p) {
  if (h.palmPx > 0) return h.palmPx;
  return (Math.hypot(p[0].x - p[5].x, p[0].y - p[5].y) + Math.hypot(p[0].x - p[17].x, p[0].y - p[17].y) + Math.hypot(p[5].x - p[17].x, p[5].y - p[17].y)) / 3;
}
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Bones + joints only (no cursors/rings). Used by the overlay and by capture.js. scale: CSS px → target px. */
export function drawSkeletons(ctx, hands, scale = 1, offset = null) {
  const ox = offset?.x || 0, oy = offset?.y || 0;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const h of hands || []) {
    if (!h || h.lost) continue;
    const p = ptsOf(h); if (!p || p.length < 21) continue;
    const col = handColor(h.id);
    const X = i => p[i].x * scale + ox, Y = i => p[i].y * scale + oy;
    const path = () => { ctx.beginPath(); for (const [a, b] of CONN) { ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); } };
    // soft glow pass, then the crisp core line
    path(); ctx.strokeStyle = rgba(col, 0.16); ctx.lineWidth = 7 * scale; ctx.stroke();
    path(); ctx.strokeStyle = rgba(col, 0.92); ctx.lineWidth = 1.6 * scale; ctx.stroke();
    // joints
    for (let i = 0; i < 21; i++) {
      const tip = TIPS.includes(i);
      ctx.beginPath(); ctx.arc(X(i), Y(i), (tip ? 3.6 : 2.3) * scale, 0, Math.PI * 2);
      ctx.fillStyle = tip ? 'rgba(0,10,24,0.85)' : col; ctx.fill();
      if (tip) { ctx.strokeStyle = col; ctx.lineWidth = 1.4 * scale; ctx.stroke(); }
    }
  }
  ctx.restore();
}

export function createOverlay(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  const seen = new Map();      // id → {t0, wasNew}
  let lastNow = 0;

  function resize(w, h, d = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1)) {
    W = w; H = h; dpr = Math.min(d || 1, 3);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  }

  function ring(x, y, r, col, lw = 1.5, a0 = 0, a1 = Math.PI * 2) {
    ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
  }
  function progressRing(x, y, r, p, col, track = 'rgba(255,255,255,0.18)', lw = 3) {
    ring(x, y, r, track, lw);
    if (p > 0) {
      ctx.save(); ctx.lineCap = 'round';
      ring(x, y, r, col, lw, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, p));
      ctx.restore();
    }
  }
  function reticle(x, y, col, r = 11) {
    ring(x, y, r, col, 1.5);
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + dx * (r + 3), y + dy * (r + 3)); ctx.lineTo(x + dx * (r + 9), y + dy * (r + 9)); }
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  }
  function arrowHead(x, y, ang, s, col) {
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(ang) * s, y + Math.sin(ang) * s);
    ctx.lineTo(x + Math.cos(ang + 2.4) * s, y + Math.sin(ang + 2.4) * s);
    ctx.lineTo(x + Math.cos(ang - 2.4) * s, y + Math.sin(ang - 2.4) * s);
    ctx.closePath(); ctx.fillStyle = col; ctx.fill();
  }

  function drawCursor(c, nowMs) {
    const col = c.id != null ? handColor(c.id) : HAND_COLORS[0];
    const p = c.progress || 0;
    const tx = c.target?.x ?? c.x, ty = c.target?.y ?? c.y;
    switch (c.kind || c.pose) {
      case 'point': reticle(c.x, c.y, col); break;
      case 'hover':
        reticle(c.x, c.y, col);
        if (c.target) progressRing(tx, ty, (c.target.r || 30) + 10, p, WHITE, 'rgba(255,255,255,0.14)', 2.5);
        else progressRing(c.x, c.y, 19, p, WHITE, 'rgba(255,255,255,0.14)', 2.5);
        break;
      case 'dwell':
        reticle(c.x, c.y, col, 9);
        progressRing(c.x, c.y, 20, p, HAND_COLORS[0], 'rgba(0,240,255,0.18)', 3.5);
        break;
      case 'pinch': case 'grab': {
        ctx.beginPath(); ctx.arc(c.x, c.y, 5.5, 0, Math.PI * 2); ctx.fillStyle = YELLOW; ctx.fill();
        ring(c.x, c.y, c.kind === 'grab' ? 14 : 11, rgba(YELLOW, 0.75), 1.5);
        break;
      }
      case 'rotate': case 'fist': {
        const r = 24, a = (nowMs / 1000) * 2.2;
        ctx.save(); ctx.lineCap = 'round';
        ring(c.x, c.y, r, rgba(col, 0.9), 2, a, a + 2.1);
        ring(c.x, c.y, r, rgba(col, 0.9), 2, a + Math.PI, a + Math.PI + 2.1);
        arrowHead(c.x + Math.cos(a + 2.1) * r, c.y + Math.sin(a + 2.1) * r, a + 2.1 + Math.PI / 2, 6, col);
        arrowHead(c.x + Math.cos(a + Math.PI + 2.1) * r, c.y + Math.sin(a + Math.PI + 2.1) * r, a + Math.PI + 2.1 + Math.PI / 2, 6, col);
        ctx.restore();
        break;
      }
      case 'delete': case 'pinky': {
        const r = c.target ? (c.target.r || 30) + 12 : 26;
        ctx.save();
        ctx.shadowColor = RED; ctx.shadowBlur = 10;
        progressRing(tx, ty, r, p, RED, 'rgba(255,59,92,0.22)', 4);
        ctx.restore();
        if (c.target) { ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fillStyle = RED; ctx.fill(); }
        break;
      }
      case 'spread': case 'scale': case 'squeeze': {   // squeeze = one-hand scaling engaged (interaction.js)
        const r = c.target ? (c.target.r || 30) + 12 : 24;
        ctx.save(); ctx.setLineDash([4, 5]); ctx.lineDashOffset = -nowMs / 60;
        ring(tx, ty, r, rgba(YELLOW, 0.85), 1.5);
        ctx.restore();
        if (p > 0 && p < 1) progressRing(tx, ty, r + 6, p, YELLOW, 'rgba(255,225,77,0.12)', 2);
        // ⇔ arrows
        ctx.beginPath(); ctx.moveTo(tx - r * 0.55, ty); ctx.lineTo(tx + r * 0.55, ty);
        ctx.strokeStyle = YELLOW; ctx.lineWidth = 1.6; ctx.stroke();
        arrowHead(tx - r * 0.55, ty, Math.PI, 5, YELLOW); arrowHead(tx + r * 0.55, ty, 0, 5, YELLOW);
        break;
      }
      default:
        ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fillStyle = rgba(col, 0.8); ctx.fill();
    }
  }

  function drawPinchLine(h, p, col) {
    const ratio = h.pinchRatio;
    if (!h.pinch && !(ratio < 0.6)) return;
    const a = p[4], b = p[8];
    const near = h.pinch ? 1 : Math.max(0, Math.min(1, (0.6 - ratio) / 0.3));
    const c = h.pinch ? YELLOW : col;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = rgba(c, 0.35 + 0.6 * near); ctx.lineWidth = h.pinch ? 2.4 : 1.4; ctx.stroke();
    if (h.pinch) {
      const m = h.pinchPoint && h.screenDisplay == null ? h.pinchPoint : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      ctx.beginPath(); ctx.arc(m.x, m.y, 4.5, 0, Math.PI * 2); ctx.fillStyle = YELLOW; ctx.fill();
    }
  }

  function drawLockOn(h, p, col, nowMs, info) {
    const age = nowMs - info.t0;
    if (age > TAG_MS) return;
    const pc = palmCenterOf(p), pp = palmPxOf(h, p);
    if (age < LOCK_MS) {
      const k = age / LOCK_MS, e = 1 - Math.pow(1 - k, 3);
      ctx.save(); ctx.globalAlpha = 1 - k * 0.85;
      ring(pc.x, pc.y, Math.max(1, e * 1.6 * pp), col, 2);
      ring(pc.x, pc.y, Math.max(1, e * 1.25 * pp), rgba(col, 0.4), 1);
      // fingertip brackets closing in
      const s = 7 + (1 - e) * 10;
      ctx.beginPath();
      for (const i of TIPS) {
        const { x, y } = p[i];
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.moveTo(x + sx * s, y + sy * s - sy * 4); ctx.lineTo(x + sx * s, y + sy * s); ctx.lineTo(x + sx * s - sx * 4, y + sy * s);
        }
      }
      ctx.strokeStyle = col; ctx.lineWidth = 1.3; ctx.stroke();
      ctx.restore();
    }
    // tag 「HAND 01」
    const fade = age < TAG_MS - 300 ? 1 : (TAG_MS - age) / 300;
    const w = p[0];
    const tx = w.x + 0.9 * pp, ty = w.y + 0.35 * pp;
    ctx.save(); ctx.globalAlpha = Math.max(0, fade) * Math.min(1, age / 120);
    ctx.beginPath(); ctx.moveTo(w.x + 4, w.y + 2); ctx.lineTo(tx - 4, ty - 6); ctx.lineTo(tx + 58, ty - 6);
    ctx.strokeStyle = rgba(col, 0.7); ctx.lineWidth = 1; ctx.stroke();
    ctx.font = `600 10px ${MONO}`; ctx.fillStyle = col; ctx.textBaseline = 'top';
    ctx.fillText(`HAND ${String(slotOf(h.id) + 1).padStart(2, '0')}`, tx, ty - 2);
    ctx.font = `9px ${MONO}`; ctx.fillStyle = rgba(col, 0.6);
    ctx.fillText('LOCKED', tx, ty + 10);
    ctx.restore();
  }

  function drawEnergy(alchemy, hands, nowMs) {
    if (!alchemy || !(alchemy.phase === 'armed' || alchemy.phase === 'growing') || !alchemy.mid) return;
    const pr = Math.max(0, Math.min(1, alchemy.progress || 0));
    const m = alchemy.mid;
    const ends = [alchemy.a, alchemy.b].map(id => hands.find(h => h && h.id === id && !h.lost)).filter(Boolean);
    ctx.save(); ctx.lineCap = 'round';
    for (const h of ends) {
      const p = ptsOf(h); if (!p) continue;
      const pc = palmCenterOf(p), col = handColor(h.id);
      const g = ctx.createLinearGradient(pc.x, pc.y, m.x, m.y);
      g.addColorStop(0, rgba(col, 0.9)); g.addColorStop(1, rgba(WHITE, 0.95));
      // glow
      ctx.beginPath(); ctx.moveTo(pc.x, pc.y); ctx.lineTo(m.x, m.y);
      ctx.strokeStyle = rgba(col, 0.12 + 0.18 * pr); ctx.lineWidth = 8 + 8 * pr; ctx.stroke();
      // flowing dashes toward the center
      ctx.setLineDash([10, 8]); ctx.lineDashOffset = -nowMs * (0.06 + 0.12 * pr);
      ctx.beginPath(); ctx.moveTo(pc.x, pc.y); ctx.lineTo(m.x, m.y);
      ctx.strokeStyle = g; ctx.lineWidth = 1.5 + 2 * pr; ctx.stroke();
      ctx.setLineDash([]);
      // energy motes
      const len = Math.hypot(m.x - pc.x, m.y - pc.y);
      for (let k = 0; k < 3; k++) {
        const f = ((nowMs / (700 - 300 * pr)) + k / 3) % 1;
        const x = pc.x + (m.x - pc.x) * f, y = pc.y + (m.y - pc.y) * f;
        ctx.beginPath(); ctx.arc(x, y, 2 + 1.5 * pr, 0, Math.PI * 2); ctx.fillStyle = rgba(WHITE, 0.9 * (1 - f * 0.5)); ctx.fill();
      }
      ring(pc.x, pc.y, Math.min(26, 10 + len * 0.04), rgba(col, 0.6), 1.2);
    }
    ctx.restore();
  }

  function draw({ hands = [], cursors = [], alchemy = null, showBones = true, nowMs = 0 } = {}) {
    if (nowMs < lastNow - 5000) seen.clear();   // clock reset (tests)
    lastNow = nowMs;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    const live = hands.filter(h => h && !h.lost && ptsOf(h)?.length >= 21);
    const ids = new Set(live.map(h => h.id));
    for (const h of hands) if (h && h.lost) ids.add(h.id);   // keep slots through the grace period
    releaseMissing(ids);
    for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
    for (const h of live) if (!seen.has(h.id)) seen.set(h.id, { t0: nowMs });

    drawEnergy(alchemy, live, nowMs);
    if (showBones) drawSkeletons(ctx, live);
    for (const h of live) {
      const p = ptsOf(h), col = handColor(h.id);
      if (showBones) drawPinchLine(h, p, col);
      drawLockOn(h, p, col, nowMs, seen.get(h.id));
    }
    for (const c of cursors || []) if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) drawCursor(c, nowMs);
  }

  return { resize, draw, canvas, get dpr() { return dpr; } };
}
