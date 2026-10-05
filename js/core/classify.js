// PURE: per-frame, rotation-invariant hand pose from WORLD landmarks (SPEC §5.2 + §13.2 + §13.4).
// Dead bands keep the previous state (pass ctx.prev); debounce lives in handtrack.js.
import {
  fingerRatio, fingerBend, thumbBend, thumbAway, pinchRatio, indexReach, palmSize,
  thumbIndexAngle, palmNormal,
} from './handmath.js';
import { CORE } from '../config/core.js';

export const POSES = ['pinch', 'fist', 'thumbup', 'spread', 'point', 'victory', 'pinky', 'open', 'neutral'];
/** Poses that trigger actions → longer debounce. */
export const ACTION_POSES = new Set(['pinky', 'victory', 'thumbup', 'spread']);

const DEG = Math.PI / 180;

/**
 * @param {Array<{x,y,z}>} wl world landmarks (meters)
 * @param {{name:string, score:number}|null} canned GestureRecognizer category (optional)
 * @param {object} [ctx]
 * @param {Array<{x,y}>} [ctx.screen] screen px landmarks (needed for thumbup direction)
 * @param {number} [ctx.palmPx] hand scale in px (thumbup margin)
 * @param {object} [ctx.prev] previous result of this function for the same track (dead bands)
 * @param {object} [ctx.cfg] CORE.classify override
 * @returns {{pose, ext:boolean[5], curled:boolean[5], R:number[5], bend:number[5], pinchRatio, indexReach,
 *            thumbStraight, thumbExt, thumbUp, tiAngle, nz, palmSize, conf}}
 */
export function classifyFrame(wl, canned = null, ctx = {}) {
  const c = ctx.cfg || CORE.classify;
  const prev = ctx.prev || null;
  const ps = palmSize(wl);
  const R = [0, 0, 0, 0, 0], bend = [0, 0, 0, 0, 0];
  const ext = [false, false, false, false, false], curled = [false, false, false, false, false];

  for (let f = 1; f <= 4; f++) {
    const r = fingerRatio(wl, f), b = fingerBend(wl, f);
    R[f] = r; bend[f] = b;
    let e;
    if (r > c.extR && b < c.curlBend) e = true;                       // clearly extended
    else if (r < c.curlR || (b > c.curlBend && r < c.extR)) e = false; // clearly curled
    else e = prev ? prev.ext[f] : r >= c.newTrackR;                   // dead band
    ext[f] = e;
    curled[f] = !e;
  }

  // Thumb
  const tb = thumbBend(wl);
  const tAway = thumbAway(wl, ps);
  const thumbStraight = tb < c.thumbStraight;
  const thumbExt = tb < c.thumbExtBend && tAway > c.thumbExtAway;
  ext[0] = thumbExt; curled[0] = !thumbExt;
  R[0] = tAway; bend[0] = tb;

  const pr = pinchRatio(wl, ps);
  const reach = indexReach(wl, ps);
  const tiAngle = thumbIndexAngle(wl);
  const n = palmNormal(wl);

  // Thumb up: needs screen landmarks (direction on screen); world y is camera-aligned so it is a fallback.
  const fourCurled = curled[1] && curled[2] && curled[3] && curled[4];
  let thumbUp = false;
  if (fourCurled && thumbStraight) {
    const s = ctx.screen;
    if (s) {
      const ppx = ctx.palmPx || 1;
      let minY = Infinity;
      for (let i = 5; i <= 20; i++) if (s[i].y < minY) minY = s[i].y;
      const dx = s[4].x - s[2].x, dy = s[4].y - s[2].y;
      const ang = Math.atan2(Math.abs(dx), -dy);   // 0 = straight up on screen
      thumbUp = s[4].y < minY - c.thumbUpMargin * ppx && dy < 0 && ang < c.thumbUpConeDeg * DEG;
    } else {
      let minY = Infinity;
      for (let i = 5; i <= 20; i++) if (wl[i].y < minY) minY = wl[i].y;
      const dx = wl[4].x - wl[2].x, dy = wl[4].y - wl[2].y;
      thumbUp = wl[4].y < minY - c.thumbUpMargin * ps && dy < 0 && Math.atan2(Math.abs(dx), -dy) < c.thumbUpConeDeg * DEG;
    }
  }
  if (!thumbUp && fourCurled && canned && canned.name === 'Thumb_Up' && canned.score >= c.cannedThumbMin) thumbUp = true;

  // Pose decision. Priority: pinch > (thumbup|fist) > spread > point > victory > pinky > open > neutral.
  // 'pinch' here is the raw per-frame reading; hysteresis + frame counts live in handtrack.js.
  let pose;
  const nExt = (ext[1] ? 1 : 0) + (ext[2] ? 1 : 0) + (ext[3] ? 1 : 0) + (ext[4] ? 1 : 0);
  const pointShape = ext[1] && curled[2] && curled[3] && curled[4];
  if (pr < (ctx.pinchEnter ?? CORE.pinch.enter) && reach > CORE.pinch.indexReachMin) pose = 'pinch';
  else if (fourCurled && thumbUp) pose = 'thumbup';
  else if (fourCurled) pose = 'fist';
  else if (pointShape) {
    // spread (L-shape, thumb out) vs point; between the two angles keep the previous reading
    const spreadNow = thumbExt && tiAngle > c.spreadDeg * DEG;
    const pointNow = !thumbExt || tiAngle < c.pointDeg * DEG;
    if (spreadNow) pose = 'spread';
    else if (pointNow) pose = 'point';
    else pose = prev && (prev.pose === 'spread' || prev.pose === 'point') ? prev.pose : 'point';
  }
  else if (ext[1] && ext[2] && curled[3] && curled[4]) pose = 'victory';
  else if (ext[4] && curled[1] && curled[2] && curled[3]) pose = 'pinky';
  else if (nExt >= 3) pose = 'open';
  else pose = 'neutral';

  // Canned gesture fusion (never overrides pinch): only resolves fist↔thumbup and open↔neutral.
  let conf = 1;
  if (canned && canned.score > c.cannedMin && pose !== 'pinch') {
    const nm = canned.name;
    if (nm === 'Closed_Fist' && (pose === 'thumbup' || (pose === 'neutral' && nExt <= 1))) pose = 'fist';
    else if (nm === 'Open_Palm' && pose === 'neutral' && nExt >= 2) pose = 'open';
    else if (nm === 'Pointing_Up' && pose === 'neutral' && ext[1]) pose = 'point';
    else if (nm === 'Victory' && pose === 'neutral' && ext[1] && ext[2]) pose = 'victory';
    conf = canned.score;
  }

  return { pose, ext, curled, R, bend, pinchRatio: pr, indexReach: reach, thumbStraight, thumbExt, thumbUp,
    tiAngle, nz: n.z, normal: n, palmSize: ps, nExt, conf };
}
