// PURE: video-normalized ↔ screen px ↔ NDC mapping (object-fit: cover + optional mirror). SPEC §2.
// Everything (overlay, cursors, UI hit-tests, picking, alchemy) uses screen px from this mapping.

/**
 * @param {{vw:number, vh:number, W:number, H:number, mirror?:boolean, left?:number, top?:number}} o
 *   vw×vh = video frame size, W×H = stage size in CSS px, left/top = stage offset in the page
 *   (non-zero only for the pillarboxed 縦 capture stage; screen coords then are page coords).
 */
export function makeMapping({ vw, vh, W, H, mirror = true, left = 0, top = 0 }) {
  vw = vw > 0 ? vw : W; vh = vh > 0 ? vh : H;
  const scale = Math.max(W / vw, H / vh);
  const dispW = vw * scale, dispH = vh * scale;
  const offX = (W - dispW) / 2, offY = (H - dispH) / 2;
  return {
    vw, vh, W, H, mirror, left, top, scale, dispW, dispH, offX, offY,
    /** normalized video coords → screen px */
    toScreen(nx, ny) {
      return { x: left + offX + (mirror ? 1 - nx : nx) * dispW, y: top + offY + ny * dispH };
    },
    /** screen px → normalized video coords (inverse of toScreen) */
    toNormalized(sx, sy) {
      const u = (sx - left - offX) / dispW;
      return { x: mirror ? 1 - u : u, y: (sy - top - offY) / dispH };
    },
    /** screen px → NDC (-1..1, y up) of the stage */
    toNdc(sx, sy) {
      return { x: ((sx - left) / W) * 2 - 1, y: -(((sy - top) / H) * 2 - 1) };
    },
    /** NDC → screen px */
    fromNdc(nx, ny) {
      return { x: left + (nx + 1) / 2 * W, y: top + (1 - ny) / 2 * H };
    },
    /** Maps a whole landmark array [{x,y,z}] → [{x,y}] screen px. */
    mapPoints(lm) {
      const out = new Array(lm.length);
      for (let i = 0; i < lm.length; i++) out[i] = this.toScreen(lm[i].x, lm[i].y);
      return out;
    },
  };
}
