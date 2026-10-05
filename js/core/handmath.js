// PURE: vector math on hand landmark arrays. No DOM / THREE / window.
// Landmarks are arrays of {x,y,z}. World landmarks (wl) are meters, camera-aligned axes
// (x right, y down, z away from camera), origin near the hand center (MediaPipe convention).
// Joint ids: wrist 0; thumb 1-4; index 5-8; middle 9-12; ring 13-16; pinky 17-20.

export const PALM_IDS = [0, 5, 9, 13, 17];
export const SCALE_IDS = [0, 1, 2, 5, 9, 13, 17];
/** [mcp, pip, dip, tip] per finger 1..4 (index..pinky); thumb is finger 0 = [cmc, mcp, ip, tip]. */
export const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
/** Nominal palm size in meters used to turn pxPerM into "palmPx" (SPEC §13.2). */
export const PALM_M = 0.075;

export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: (a.z || 0) + (b.z || 0) });
export const len = v => Math.hypot(v.x, v.y, v.z || 0);
export const len2 = v => Math.hypot(v.x, v.y);
export const dot = (a, b) => a.x * b.x + a.y * b.y + (a.z || 0) * (b.z || 0);
export const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
export const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Angle between two vectors (radians, 0..π). */
export function angle(u, v) {
  const l = len(u) * len(v);
  if (l < 1e-12) return 0;
  return Math.acos(clamp(dot(u, v) / l, -1, 1));
}

/** Mean of the given landmark ids → {x,y,z}. */
export function meanOf(pts, ids) {
  let x = 0, y = 0, z = 0;
  for (const i of ids) { x += pts[i].x; y += pts[i].y; z += pts[i].z || 0; }
  const n = ids.length;
  return { x: x / n, y: y / n, z: z / n };
}

/** Palm center (screen or world): mean of 0,5,9,13,17. */
export const palmCenter = pts => meanOf(pts, PALM_IDS);

/** SPEC §5.2 palm size (meters for wl): mean of the three palm-triangle edges. */
export function palmSize(wl) {
  return (dist(wl[0], wl[5]) + dist(wl[0], wl[17]) + dist(wl[5], wl[17])) / 3;
}

/**
 * SPEC §13.2 rotation-robust scale: px per meter from the spread of palm points on screen vs the
 * spread of the same points in world x,y. Works when the hand is tilted because both spreads
 * shrink together only along the foreshortened axis… mostly; it is far steadier than edge lengths.
 */
export function pxPerM(screen, wl) {
  let mx = 0, my = 0, wx = 0, wy = 0;
  const n = SCALE_IDS.length;
  for (const i of SCALE_IDS) { mx += screen[i].x; my += screen[i].y; wx += wl[i].x; wy += wl[i].y; }
  mx /= n; my /= n; wx /= n; wy /= n;
  let a = 0, b = 0;
  for (const i of SCALE_IDS) {
    a += (screen[i].x - mx) ** 2 + (screen[i].y - my) ** 2;
    b += (wl[i].x - wx) ** 2 + (wl[i].y - wy) ** 2;
  }
  return b > 1e-12 ? Math.sqrt(a / b) : 0;
}

/** Finger extension ratio R_f = |tip−wrist| / |mcp−wrist| for f = 1..4 (index..pinky). */
export function fingerRatio(wl, f) {
  const [m, , , t] = FINGERS[f];
  const d = dist(wl[m], wl[0]);
  return d > 1e-9 ? dist(wl[t], wl[0]) / d : 0;
}

/** PIP + DIP bend angle (radians) for f = 1..4. Straight ≈ 0.1–0.5, curled ≈ 2–3. */
export function fingerBend(wl, f) {
  const [m, p, d, t] = FINGERS[f];
  return angle(sub(wl[p], wl[m]), sub(wl[d], wl[p])) + angle(sub(wl[d], wl[p]), sub(wl[t], wl[d]));
}

/** SPEC §5.2 curl: MCP + PIP + DIP bend (radians) for f = 1..4. */
export function fingerCurl(wl, f) {
  const [m, p, d, t] = FINGERS[f];
  return angle(sub(wl[m], wl[0]), sub(wl[p], wl[m])) + fingerBend(wl, f);
}

/** Thumb bend: angle(1→2, 2→3) + angle(2→3, 3→4). Straight thumb < ~0.6 rad. */
export function thumbBend(wl) {
  return angle(sub(wl[2], wl[1]), sub(wl[3], wl[2])) + angle(sub(wl[3], wl[2]), sub(wl[4], wl[3]));
}

/** Thumb tip distance from the index knuckle in palm units (thumb "out" when large). */
export function thumbAway(wl, ps = palmSize(wl)) {
  return ps > 1e-9 ? dist(wl[4], wl[5]) / ps : 0;
}

/** SPEC §5.2 pinch ratio |wl4 − wl8| / palmSize (scale-invariant). */
export function pinchRatio(wl, ps = palmSize(wl)) {
  return ps > 1e-9 ? dist(wl[4], wl[8]) / ps : 9;
}

/** SPEC §13.4 index "not folded": |wl8 − wl5| / palmSize. */
export function indexReach(wl, ps = palmSize(wl)) {
  return ps > 1e-9 ? dist(wl[8], wl[5]) / ps : 0;
}

/** Angle between thumb (2→4) and index (5→8) directions — 'spread' vs 'point' (radians). */
export function thumbIndexAngle(wl) {
  return angle(sub(wl[4], wl[2]), sub(wl[8], wl[5]));
}

/** SPEC §13.2 palm normal n = normalize((wl5−wl0) × (wl17−wl0)). |n.z| ≈ 1 → palm/back faces camera. */
export function palmNormal(wl) {
  const n = cross(sub(wl[5], wl[0]), sub(wl[17], wl[0]));
  const l = len(n) || 1;
  return { x: n.x / l, y: n.y / l, z: n.z / l };
}

/** Mean 2D distance between corresponding landmarks of two hands (screen px). */
export function meanLandmarkDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += dist2(a[i], b[i]);
  return s / a.length;
}

/** Motion anchor for grabbing (SPEC §13.4): mean of thumb MCP (2), index MCP (5), index PIP (6). */
export const grabAnchor = pts => meanOf(pts, [2, 5, 6]);

/** Converts [[x,y,z],…] (JSON dumps) to [{x,y,z},…]. Passes through object arrays. */
export function toPoints(arr) {
  if (!arr || !arr.length || !Array.isArray(arr[0])) return arr;
  return arr.map(p => ({ x: p[0], y: p[1], z: p[2] || 0 }));
}
