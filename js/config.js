// Single entry point for every tunable. Each area lives in its own file under ./config/
// so different modules can be tuned independently. Values can be overridden at runtime
// with ?cfg.<path>=<value> in the URL (dev only), e.g. ?cfg.core.pinch.enter=0.3
import { CORE } from './config/core.js';
import { RENDER } from './config/render.js';
import { UI } from './config/ui.js';
import { MEDIA } from './config/media.js';

export const VERSION = '2.0.0';

export const CONFIG = { core: CORE, render: RENDER, ui: UI, media: MEDIA };

export function applyUrlOverrides(search = (typeof location !== 'undefined' ? location.search : '')) {
  const params = new URLSearchParams(search);
  for (const [k, v] of params) {
    if (!k.startsWith('cfg.')) continue;
    const path = k.slice(4).split('.');
    let o = CONFIG;
    for (let i = 0; i < path.length - 1; i++) o = o?.[path[i]];
    const last = path[path.length - 1];
    if (!o || !(last in o)) continue;
    const cur = o[last];
    o[last] = typeof cur === 'number' ? Number(v) : typeof cur === 'boolean' ? v === 'true' || v === '1' : v;
  }
  return CONFIG;
}
