// Dev/test URL overrides (?cfg.path.to.key=value) — filtered before config.applyUrlOverrides (R1-18).
// main.js applies them only on this PC (localhost) or with ?dev=1.
import { CONFIG } from './config.js';

export const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const BAD_SEG = new Set(['__proto__', 'prototype', 'constructor', '']);
const own = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/** Allowed ?cfg.* params as a search string ('' when none). Only existing own scalar CONFIG keys; never the
 *  watermark or share text that is stamped on every capture. */
export function devOverrides(params, config = CONFIG) {
  const out = new URLSearchParams();
  for (const [k, v] of params) {
    if (!k.startsWith('cfg.')) continue;
    const path = k.slice(4).split('.');
    if (path.some(s => BAD_SEG.has(s)) || path.includes('watermark') || path[path.length - 1] === 'shareUrl') continue;
    let o = config, ok = true;
    for (let i = 0; i < path.length - 1 && ok; i++) { ok = own(o, path[i]); if (ok) o = o[path[i]]; }
    const last = path[path.length - 1];
    if (!ok || !own(o, last)) continue;
    const t = typeof o[last];
    if (t !== 'number' && t !== 'boolean' && t !== 'string') continue;
    out.append(k, v);
  }
  return out.toString();
}
