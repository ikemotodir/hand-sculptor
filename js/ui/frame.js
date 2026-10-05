// The 縦 (9:16) stage frame. main.js layoutStage() and tools/ui_preview.html use these same numbers.
// Pillarbox on a wider screen, letterbox on a taller phone (2 % slack), so the 1080×1920 photo holds what is
// on screen (R1-7). A frame narrower than MIN_FRAME_W cannot hold the HUD, so the stage stays full screen and
// acts as 横 (`rotate`). That is a phone held sideways (≤ ~242 px: ask to turn it) or a PC window lower than
// 560 px. Common laptop browser tabs (innerHeight 560–700 → 315–394 px frames) ARE framed (R3-3): the PC HUD
// fits a 315 px frame with 64 px targets (tb-2col, frameInset, trayFit; tools/shot_ui.mjs checks 1280x560).
export const PORTRAIT = 9 / 16;
export const MIN_FRAME_W = 315;

/** @returns {{sw:number, sh:number, left:number, top:number, framed:boolean, rotate:boolean, orientation:string}} */
export function stageFrame(W, H, orientation) {
  let sw = W, sh = H, left = 0, top = 0, rotate = false;
  if (orientation === 'portrait' && W / H > PORTRAIT * 1.02) {
    const w = Math.round(H * PORTRAIT);
    if (w < MIN_FRAME_W) rotate = true;
    else { sw = w; left = Math.round((W - sw) / 2); }
  } else if (orientation === 'portrait' && W / H < PORTRAIT / 1.02) {
    sh = Math.round(W / PORTRAIT); top = Math.round((H - sh) / 2);
  }
  return { sw, sh, left, top, framed: left > 0 || top > 0, rotate, orientation: rotate ? 'landscape' : orientation };
}
