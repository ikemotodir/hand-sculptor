import { addStrings, t } from '../i18n.js';
import { UI } from '../config/ui.js';
import { stageFrame } from './frame.js';

// Inline SVG line icons for the HUD (hairline style, stroke = currentColor).
// Pure geometric icons only — never characters (brand rule).
const svg = (vb, body, extra = '') =>
  `<svg viewBox="0 0 ${vb} ${vb}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

function starPath(cx, cy, r1, r2, n = 5) {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1, a = -Math.PI / 2 + (i * Math.PI) / n;
    d += (i ? 'L' : 'M') + (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2) + ' ';
  }
  return d + 'Z';
}

export const SHAPE_ICONS = {
  random: svg(32, '<rect x="6" y="6" width="20" height="20" rx="4.5"/><circle cx="11.5" cy="11.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.7" fill="currentColor" stroke="none"/><circle cx="20.5" cy="20.5" r="1.7" fill="currentColor" stroke="none"/>'),
  box: svg(32, '<path d="M16 4 27 10v12L16 28 5 22V10Z"/><path d="M5 10l11 6 11-6M16 16v12"/>'),
  sphere: svg(32, '<circle cx="16" cy="16" r="11"/><ellipse cx="16" cy="16" rx="11" ry="4"/><ellipse cx="16" cy="16" rx="4.2" ry="11"/>'),
  cylinder: svg(32, '<ellipse cx="16" cy="8" rx="9" ry="3.2"/><path d="M7 8v16a9 3.2 0 0 0 18 0V8"/>'),
  cone: svg(32, '<path d="M16 4 7 23.5M16 4l9 19.5"/><ellipse cx="16" cy="23.5" rx="9" ry="3.2"/>'),
  torus: svg(32, '<ellipse cx="16" cy="16" rx="12.5" ry="9"/><path d="M9.5 15c3.8 3.6 9.2 3.6 13 0M11.3 16.6c3-2.4 6.4-2.4 9.4 0"/>'),
  octa: svg(32, '<path d="M16 3 27 16 16 29 5 16Z"/><path d="M5 16q11 4.5 22 0M16 3l-3 15.6L16 29"/>'),
  pyramid: svg(32, '<path d="M16 4 28 23l-12 5L4 23Z"/><path d="M16 4v24"/>'),
  icosa: svg(32, '<path d="M16 3 27 9.5v13L16 29 5 22.5v-13Z"/><path d="M10.5 12h11L16 21.5Z"/><path d="M5 9.5l5.5 2.5M27 9.5 21.5 12M16 29v-7.5M5 22.5l5.5-10.5M27 22.5l-5.5-10.5M16 3l-5.5 9M16 3l5.5 9"/>'),
  star: svg(32, `<path d="${starPath(16, 16.8, 12, 5.2)}"/>`),
  heart: svg(32, '<path d="M16 27C6.5 20.5 3.5 14.5 6.2 9.6 8.8 5 14 5.6 16 10c2-4.4 7.2-5 9.8-.4 2.7 4.9-.3 10.9-9.8 17.4Z"/>'),
};

export const ICONS = {
  shape: svg(24, '<path d="M12 2.8 20.2 7.4v9.2L12 21.2 3.8 16.6V7.4Z"/><path d="M3.8 7.4 12 12l8.2-4.6M12 12v9.2"/>'),
  color: svg(24, '<path d="M12 3s-6.5 7.4-6.5 11.5a6.5 6.5 0 0 0 13 0C18.5 10.4 12 3 12 3Z"/>'),
  undo: svg(24, '<path d="M8.5 5.5 4 10l4.5 4.5"/><path d="M4 10h10a5.5 5.5 0 0 1 0 11h-3.5"/>'),
  photo: svg(24, '<rect x="3" y="7" width="18" height="13" rx="2.6"/><circle cx="12" cy="13.5" r="3.6"/><path d="M8.2 7 9.6 4.4h4.8L15.8 7"/>'),
  rec: svg(24, '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.6" fill="currentColor" stroke="none"/>'),
  stop: svg(24, '<circle cx="12" cy="12" r="8.4"/><rect x="8.6" y="8.6" width="6.8" height="6.8" rx="1.2" fill="currentColor" stroke="none"/>'),
  menu: svg(24, '<path d="M4 7.5h16M4 16.5h16"/><circle cx="9" cy="7.5" r="2.3" fill="var(--glass-solid)"/><circle cx="15" cy="16.5" r="2.3" fill="var(--glass-solid)"/>'),
  close: svg(24, '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  share: svg(24, '<path d="M12 3.5v11M7.5 8 12 3.5 16.5 8"/><path d="M5 12.5v6.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-6.5"/>'),
  save: svg(24, '<path d="M12 3.5v11M7.5 10 12 14.5 16.5 10"/><path d="M4.5 19.5h15"/>'),
  trash: svg(24, '<path d="M5 7h14M10 7V4.8h4V7M7 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h5.2a1.5 1.5 0 0 0 1.5-1.3L17 7"/>'),
  prev: svg(24, '<path d="M14.5 5.5 8 12l6.5 6.5"/>'),
  next: svg(24, '<path d="M9.5 5.5 16 12l-6.5 6.5"/>'),
  play: svg(24, '<path d="M8 5.5v13l10.5-6.5Z" fill="currentColor"/>'),
  copy: svg(24, '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  lock: svg(24, '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7"/>'),
  sun: svg(24, '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>'),
  cam: svg(24, '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.3-2h6.4l1.3 2h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="12.8" r="3.3"/>'),
};

// ─────────────────────────────────────────────────────────────────────────────
// HUD (DOM). SPEC §7, §12, §13.6–13.7. Short Japanese copy, tiny English captions.
// Every control has a stable id and `data-dwell` so finger-dwell (hitTest/activate) reaches it.
// Controls marked data-real (tray 保存/共有, 部屋に置く) are excluded from dwell: they need a REAL tap.
// ─────────────────────────────────────────────────────────────────────────────

addStrings({ ja: {
  'tb.shape': 'かたち', 'tb.color': 'いろ', 'tb.undo': 'もどす', 'tb.photo': 'しゃしん', 'tb.rec': 'ろくが', 'tb.stop': 'とめる', 'tb.menu': 'せってい',
  'shape.random': 'おまかせ', 'shape.box': 'キューブ', 'shape.sphere': 'ボール', 'shape.cylinder': 'つつ', 'shape.cone': 'コーン',
  'shape.torus': 'ドーナツ', 'shape.octa': 'ダイヤ', 'shape.pyramid': 'ピラミッド', 'shape.icosa': 'ジェム', 'shape.star': 'ほし', 'shape.heart': 'ハート',
  'panel.shape': 'かたち', 'panel.color': 'いろ', 'panel.colorSel': 'えらんだ形に ぬる', 'panel.menu': 'せってい', 'panel.link': 'スマホ連携',
  'op.0': '薄', 'op.1': '中', 'op.2': '濃',
  'set.dup': 'コピー', 'set.clear': 'ぜんぶ けす', 'set.export': '3Dで 保存', 'set.ar': '部屋に置く', 'set.bones': 'ボーン', 'set.depth': 'おくゆき',
  'set.mirror': 'かがみ', 'set.quality': 'がしつ', 'set.clarity': 'くっきり', 'set.sound': 'おと', 'set.orient': 'たて/よこ', 'set.camera': 'カメラ', 'set.side': 'ボタン位置',
  'set.rec': 'ろくが', 'set.tutorial': 'あそびかた', 'set.link': 'スマホ連携', 'set.license': 'ライセンス',
  'v.on': 'ON', 'v.off': 'OFF', 'v.auto': 'オート', 'v.high': '高', 'v.low': '低', 'v.portrait': 'たて', 'v.landscape': 'よこ',
  'v.user': 'まえ', 'v.environment': 'うしろ', 'v.left': '左', 'v.right': '右', 'v.sec': '{n}秒',
  'st.loading': 'じゅんび中', 'st.scanning': 'てを かざしてね', 'st.tracking': '✋ ×{n}', 'st.lost': 'てが 見えない',
  'pose.pinch': 'つまむ', 'pose.point': 'ゆび', 'pose.fist': 'グー', 'pose.open': 'パー', 'pose.thumbup': 'グッド',
  'pose.pinky': '小指', 'pose.victory': 'ピース', 'pose.spread': 'ひろげる',
  'guide.title': 'あそびかた', 'guide.open': 'ガイド',
  'g.make': 'てを あわせて ひらく', 'g.makeR': 'つくる', 'g.pick': 'ゆびで さす', 'g.pickR': 'えらぶ',
  'g.move': 'つまむ', 'g.moveR': 'うごかす', 'g.rot': 'グー', 'g.rotR': 'まわす', 'g.spin': 'はらう', 'g.spinR': 'クルクル',
  'g.free': 'グッド', 'g.freeR': 'はなす', 'g.size': '親指と人差し指', 'g.sizeR': '大きさ', 'g.del': '小指だけ立てて長押し', 'g.delR': 'けす',
  'g.tutorial': 'もう一度 れんしゅう',
  'tray.save': '保存', 'tray.share': '共有', 'tray.del': 'けす', 'tray.close': 'とじる', 'tray.tap': 'タップで 保存',
  'link.ar': 'AR', 'link.phone': 'スマホ操作', 'link.on': 'つながった', 'link.wait': 'まってる…', 'link.off': 'オフ',
  'lic.title': 'ライセンス', 'lic.none': 'よみこめませんでした',
  'attract.go': 'てを かざしてね', 'attract.sub': 'さわって つくる 3D',
  'hint.closer': 'もっと ちかくに', 'hint.bright': 'あかるい ばしょで', 'hint.pickFirst': '☝️で えらんでね',
  'hint.short': 'ひくい まど→よこで とるよ',
  // tracker health (R4): one extra line on the status card. 'ok' shows nothing. The short code is for Claude.
  'st.retrying': '手の認識を 切りかえ中', 'st.fatal': '手の認識が うごきません',
  // 診断 panel (せってい → 診断): plain text the owner can read out or copy
  'set.diag': '診断', 'diag.title': '診断', 'diag.copy': 'コピー', 'diag.copied': 'コピーしました', 'diag.none': 'まだ データなし',
  'diag.engine': 'ブラウザ', 'diag.path': '経路', 'diag.rate': '結果/秒', 'diag.cam': 'カメラ', 'diag.screen': '画面',
  'diag.errors': 'エラー', 'diag.state': '状態', 'diag.ver': '版',
}});

const SHAPES = ['random', 'box', 'sphere', 'cylinder', 'cone', 'torus', 'octa', 'pyramid', 'icosa', 'star', 'heart'];
const COLORS = ['#00f0ff', '#3d8bff', '#00ffa3', '#8b5cff', '#ff4fd8', '#ffe14d', '#ff8a3d', '#ffffff', '#ff3b5c'];
const LEVELS = UI.opacityLevels || [0.10, 0.20, 0.40];
const QUALITIES = ['auto', 'high', 'low'];
const REC_SECS = [15, 30, 60];

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isIOS = () => typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
function fmtTime(s) { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

// ── pure helpers (unit-tested in tools/tests/ui.test.mjs) ─────────────────
/** Capture tray: thumbnails that fit (`fit`, or 2 on phones / 4 elsewhere when a boolean) and the '+N' for the rest. */
export function trayView(len, fit) {
  if (typeof fit !== 'number') fit = fit ? 2 : 4;
  return { show: Math.min(len, fit), more: Math.max(0, len - fit) };
}
/**
 * PC tray thumbnails that fit between the left edge and the OBJECTS count of THIS HUD (the 縦 frame is narrow,
 * R2-9), keeping room for the +N badge. Phones (count at the top) keep 2.
 */
export function trayFit({ hudW, countW = 0, mobile = false, tgt = 64, gap = 8, pad = 16, badge = 48 } = {}) {
  if (mobile) return 2;
  if (!(hudW > 0)) return 4;
  const room = hudW - 2 * pad - countW - 16 - badge;
  return clamp(Math.floor((room + gap) / (tgt + gap)), 1, 4);
}
/** The sheet follows the capture it SHOWS (by id), not an index that shifts when the tray changes (R2-10). */
export function sheetIndexFor(tray, id) { return id == null ? -1 : tray.findIndex(x => x.id === id); }
/** スマホ連携 header: connected → つながった, listening → まってる…, link off → オフ. */
export function linkStateKey(s = {}) { return s.connected ? 'link.on' : s.lanOn ? 'link.wait' : 'link.off'; }
/**
 * Toolbar inset from the hand size (1.5·palmPx). It never moves while the user is reaching for it:
 * no change while busy (dwell/panel/modal), only after the wanted value has been steady for `stableMs`,
 * and it only grows (further from the edge), so a hand coming closer cannot pull the target away twice.
 */
export function createInsetTracker({ min = 72, max = 140, k = 1.5, step = 24, stableMs = 1500 } = {}) {
  let cur = min, cand = null, since = 0;
  return {
    get value() { return cur; },
    /** → new inset (px) when the toolbar should move now, else null. */
    update(palmPx, now, busy = false) {
      if (!(palmPx > 0)) return null;
      const want = clamp(Math.round(k * palmPx), min, max);
      if (busy || want - cur < step) { cand = null; return null; }
      if (cand == null || Math.abs(want - cand) >= step / 2) { cand = want; since = now; return null; }
      if (now - since < stableMs) return null;
      cur = cand; cand = null;
      return cur;
    },
  };
}

/**
 * 縦 on a PC: the HUD sits inside a narrow 9:16 frame, and the inset (tuned for a full screen) would push the
 * toolbar to the middle of it, over the subject. In a frame narrower than 600 px it is capped at 12 % of it.
 */
export function frameInset(inset, frameW, winW) {
  if (!(frameW > 0) || frameW >= winW - 1 || frameW >= 600) return inset;
  return Math.min(inset, Math.max(24, Math.round(0.12 * frameW)));
}
/**
 * Where a toolbar pop-up may go inside a narrow frame, best first: beside the whole toolbar, beside the button
 * that opened it (over the rest of the toolbar), then full width below / above that button. Rects are
 * {left, top, right, bottom}; an obstacle (status card, guide button) in a region moves its top below it,
 * a floor rect (tray, OBJECTS count) moves its bottom above it.
 * → [{x0, x1, y0, y1}]
 */
export function popRegions({ frame, tb, btn, side = 'right', obstacles = [], floor = [], pad = 8, gap = 12 }) {
  const L = frame.left + pad, R = frame.right - pad, T = frame.top + pad, B = frame.bottom - pad;
  const raw = side === 'left'
    ? [[tb.right + gap, R, T, B], [btn.right + gap, R, T, B], [L, R, btn.bottom + pad, B], [L, R, T, btn.top - pad]]
    : [[L, tb.left - gap, T, B], [L, btn.left - gap, T, B], [L, R, btn.bottom + pad, B], [L, R, T, btn.top - pad]];
  return raw.map(([x0, x1, y0, y1]) => {
    for (const o of obstacles) {
      if (o && o.bottom > o.top && o.left < x1 && o.right > x0 && o.top < y1 && o.bottom > y0) y0 = Math.max(y0, o.bottom + pad);
    }
    for (const o of floor) {   // the tray / count row at the bottom: the region ends above it
      if (o && o.bottom > o.top && o.left < x1 && o.right > x0 && o.top < y1 && o.bottom > y0) y1 = Math.min(y1, o.top - pad);
    }
    return { x0, x1, y0, y1 };
  }).filter(r => r.x1 - r.x0 > 0 && r.y1 - r.y0 > 0);
}
/** A w×h pop-up in region r: hugs the toolbar side, top as close to anchorTop as fits. → {x, y} | null */
export function fitPop(w, h, r, anchorTop, side = 'right') {
  if (w > r.x1 - r.x0 + 0.5 || h > r.y1 - r.y0 + 0.5) return null;
  return { x: side === 'left' ? r.x0 : r.x1 - w, y: clamp(anchorTop, r.y0, r.y1 - h) };
}
/**
 * Tracker health line on the status card (R4). state = 'ok' | 'retrying' | 'fatal' (tracker.on('status') {state, code}).
 * 'ok' shows nothing; 'retrying' one line; 'fatal' the line + the short code (e.g. W-BM-black) in mono so the
 * owner can read it to Claude. Anything unknown is treated as 'ok' (never a stale warning). → {show, key, code}
 */
export function healthView(state = 'ok', code = '') {
  if (state === 'retrying') return { show: true, key: 'st.retrying', code: '' };
  if (state === 'fatal') return { show: true, key: 'st.fatal', code: String(code || '').slice(0, 24) };
  return { show: false, key: '', code: '' };
}
const IN_APP_UA = /Instagram|FBAN|FBAV|Line\/|BytedanceWebview|musical_ly/i;
/**
 * Browser + major version + device from a UA string, for the 診断 panel: 'Safari 18 / iPhone', 'Chrome 140 / Windows',
 * 'Chrome iOS 140 / iPhone'. iPadOS sends a Mac UA: touch > 1 on a Mac → iPad. In-app browsers get ' app'.
 */
export function engineName(ua = '', touch = 0) {
  const major = re => { const r = re.exec(ua); return r ? r[1].split('.')[0] : null; };
  let name = null, ver = null;
  if ((ver = major(/Edg(?:e|iOS|A)?\/([\d.]+)/))) name = 'Edge';
  else if ((ver = major(/CriOS\/([\d.]+)/))) name = 'Chrome iOS';
  else if ((ver = major(/FxiOS\/([\d.]+)/))) name = 'Firefox iOS';
  else if ((ver = major(/Firefox\/([\d.]+)/))) name = 'Firefox';
  else if ((ver = major(/(?:Chrome|Chromium)\/([\d.]+)/))) name = 'Chrome';
  else if (/Safari\//.test(ua) && (ver = major(/Version\/([\d.]+)/))) name = 'Safari';
  else if (/AppleWebKit/.test(ua)) { name = 'WebKit'; ver = major(/OS (\d+)_/) || '?'; }
  else return ua ? 'unknown' : '-';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${name} ${ver}${os ? ' / ' + os : ''}${IN_APP_UA.test(ua) ? ' app' : ''}`;
}
/**
 * 診断 rows from the raw numbers (main.js provider + the HUD's own environment). Every value is a short string;
 * missing → '-'. path = the tracker's strategy code (metrics().strategyCode, e.g. W-BM) + worker|main / frame source / GPU|CPU.
 * → [[labelKey, value]]
 */
export function diagLines(d = {}) {
  const s = x => (x == null || x === '' ? '-' : String(x));
  const path = [d.strategy, [d.worker == null ? null : d.worker ? 'worker' : 'main', d.frameSource, d.delegate].filter(Boolean).join('/')].filter(Boolean).join(' ') || '-';
  const cam = d.vw > 0 && d.vh > 0 ? `${d.vw}x${d.vh}` + (d.camFps > 0 ? `@${Math.round(d.camFps)}` : '') : '-';
  const screen = d.screenW > 0 ? `${d.screenW}x${d.screenH}` + (d.dpr > 0 ? ` x${(+d.dpr).toFixed(2).replace(/\.?0+$/, '')}` : '') : '-';
  const state = d.health ? d.health + (d.code ? ' ' + d.code : '') : '-';
  return [
    ['diag.engine', s(d.engine)], ['diag.path', path],
    ['diag.rate', d.resultRate != null && isFinite(d.resultRate) ? (+d.resultRate).toFixed(1) : '-'],
    ['diag.cam', cam], ['diag.screen', screen], ['diag.errors', s(d.errors ?? 0)], ['diag.state', state], ['diag.ver', s(d.version)],
  ];
}
/** The 診断 rows as plain text for the clipboard: 'HAND SCULPTOR' + one 'label: value' per line. */
export function diagText(lines, tr = k => k) {
  return ['HAND SCULPTOR', ...lines.map(([k, v]) => `${tr(k)}: ${v}`)].join('\n');
}

/**
 * @param {{root: HTMLElement, onAction: (name:string, payload?:any)=>void, assetBase?: string, colors?: string[], shapes?: string[]}} o
 */
export function createHud({ root, onAction = () => {}, assetBase = './', colors = COLORS, shapes } = {}) {
  const shapeList = shapes ? ['random', ...shapes.filter(s => s !== 'random')] : SHAPES;
  const act = (name, payload) => { try { onAction(name, payload); } catch (e) { console.error('[hud] action', name, e); } };
  const settings = {
    bones: UI.showBones, depth: UI.depth, mirror: UI.mirror, quality: UI.quality, sound: UI.sound,
    orientation: UI.orientation, facing: 'user', side: UI.toolbarSide, recordSec: UI.recordSec,
    ios: isIOS(), kiosk: false, canExport: true,
  };
  const style = { type: 'random', colorIdx: -1, opacity: UI.defaultOpacity };
  let selected = false, linkInfo = null, recording = false, guideOpen = lsGet(UI.storageKeys.guideOpen, null);
  let openPanel = null;          // 'shape' | 'color' | 'menu' | 'link' | null
  const tray = [];               // {id, kind, url, thumb, sec}
  let sheetIdx = -1, sheetId = null;   // the capture the sheet shows: always looked up by id (R2-10)

  root.classList.add('hs-hud');
  root.innerHTML = `
  <div class="hs-status glass" id="hud-status">
    <div class="hs-brand">HAND SCULPTOR</div>
    <div class="hs-st"><i class="dot"></i><span class="st-text"></span><span class="hs-health" id="hud-health" hidden><span class="ht"></span><code class="hc" hidden></code></span><em class="cap st-cap"></em></div>
    <div class="hs-pose" id="hud-pose" hidden></div>
  </div>
  <div class="hs-toast" id="hud-toast" role="status" aria-live="polite"></div>
  <div class="hs-hints" id="hud-hints"></div>
  <div class="hs-rec glass" id="hud-rec" hidden><i></i><b>REC</b><span class="t">0:00</span><span class="tm"></span></div>
  <div class="hs-count glass" id="hud-count"><b>00</b><em class="cap">OBJECTS</em></div>
  <div class="hs-countdown" id="hud-countdown" hidden></div>
  <div class="hs-flash" id="hud-flash"></div>

  <div class="hs-guide" id="hud-guide">
    <button class="hs-guide-btn glass" id="guide-toggle" data-dwell aria-label="guide"><b>?</b><i class="gx">${ICONS.close}</i><span data-i18n="guide.open"></span></button>
    <div class="hs-guide-panel glass" id="guide-panel">
      <div class="ph"><span data-i18n="guide.title"></span><em class="cap">GESTURES</em>
        <button class="x" id="guide-close" data-dwell aria-label="close">${ICONS.close}</button></div>
      <ul class="g-list">
        ${[['🙏', 'g.make', 'g.makeR'], ['☝️', 'g.pick', 'g.pickR'], ['🤏', 'g.move', 'g.moveR'], ['✊', 'g.rot', 'g.rotR'],
           ['✋', 'g.spin', 'g.spinR'], ['👍', 'g.free', 'g.freeR'], ['<i class="gi-pair">⇔</i>', 'g.size', 'g.sizeR'], ['<i class="gi-pinky">小指</i>', 'g.del', 'g.delR']]
          .map(([i, a, b]) => `<li><span class="gi">${i}</span><span class="ga" data-i18n="${a}"></span><span class="gb" data-i18n="${b}"></span></li>`).join('')}
      </ul>
      <button class="hs-btn wide" id="guide-tutorial" data-dwell data-i18n="g.tutorial"></button>
    </div>
  </div>

  <div class="hs-tray" id="hud-tray"></div>

  <nav class="hs-tb" id="hud-toolbar">
    <div class="tb-items">
      <button class="tb glass" id="tb-shape" data-dwell><span class="ic">${SHAPE_ICONS.random}</span><span class="lb" data-i18n="tb.shape"></span></button>
      <button class="tb glass" id="tb-color" data-dwell><span class="ic sw"><i></i></span><span class="lb" data-i18n="tb.color"></span><b class="selmark" hidden></b></button>
      <button class="tb glass" id="tb-undo" data-dwell><span class="ic">${ICONS.undo}</span><span class="lb" data-i18n="tb.undo"></span></button>
      <button class="tb glass" id="tb-photo" data-dwell><span class="ic">${ICONS.photo}</span><span class="lb" data-i18n="tb.photo"></span></button>
      <button class="tb glass rec" id="tb-rec" data-dwell><span class="ic">${ICONS.rec}</span><span class="lb" data-i18n="tb.rec"></span></button>
      <button class="tb glass" id="tb-menu" data-dwell><span class="ic">${ICONS.menu}</span><span class="lb" data-i18n="tb.menu"></span></button>
    </div>
    <div class="hs-pop glass" id="pop-shape" hidden>
      <div class="ph"><span data-i18n="panel.shape"></span><em class="cap">SHAPE</em>
        <button class="x" id="pop-shape-x" data-dwell aria-label="close">${ICONS.close}</button></div>
      <div class="grid g-shape">
        ${shapeList.map(s => `<button class="cell" id="shape-${s}" data-dwell data-shape="${s}">${SHAPE_ICONS[s] || SHAPE_ICONS.box}<span data-i18n="shape.${s}"></span></button>`).join('')}
      </div>
    </div>
    <div class="hs-pop glass" id="pop-color" hidden>
      <div class="ph"><span class="ph-t" data-i18n="panel.color"></span><em class="cap">COLOR</em>
        <button class="x" id="pop-color-x" data-dwell aria-label="close">${ICONS.close}</button></div>
      <div class="grid g-color">
        <button class="cell sw-cell" id="color-rand" data-dwell data-color="-1" aria-label="random"><i class="sw rnd"></i></button>
        ${colors.map((c, i) => `<button class="cell sw-cell" id="color-${i}" data-dwell data-color="${i}" aria-label="${c}"><i class="sw" style="--c:${c}"></i></button>`).join('')}
      </div>
      <div class="grid g-op">
        ${LEVELS.map((v, i) => `<button class="cell op-cell" id="op-${i}" data-dwell data-op="${v}"><i class="opsw" style="--a:${Math.min(1, v * 2.2)}"></i><span data-i18n="op.${i}"></span></button>`).join('')}
      </div>
    </div>
    <div class="hs-pop glass" id="pop-menu" hidden>
      <div class="ph"><span data-i18n="panel.menu"></span><em class="cap">SETTINGS</em>
        <button class="x" id="pop-menu-x" data-dwell aria-label="close">${ICONS.close}</button></div>
      <div class="grid g-menu" id="menu-grid"></div>
    </div>
  </nav>

  <div class="hs-link glass" id="hud-link" hidden>
    <div class="ph"><i class="ldot"></i><span data-i18n="panel.link"></span><em class="cap lstate"></em>
      <button class="x" id="link-close" data-dwell aria-label="close">${ICONS.close}</button></div>
    <div class="link-slot" id="link-slot"></div>
    <div class="seg">
      <button class="hs-btn" id="link-ar" data-dwell data-i18n="link.ar"></button>
      <button class="hs-btn" id="link-phone" data-dwell data-i18n="link.phone"></button>
    </div>
  </div>

  <div class="hs-modal" id="hud-sheet" hidden>
    <div class="sheet glass">
      <div class="media" id="sheet-media"></div>
      <div class="sheet-nav">
        <button class="hs-btn ico" id="sheet-prev" data-dwell aria-label="prev">${ICONS.prev}</button>
        <span class="cap" id="sheet-idx"></span>
        <button class="hs-btn ico" id="sheet-next" data-dwell aria-label="next">${ICONS.next}</button>
      </div>
      <div class="sheet-actions">
        <button class="hs-btn pri" id="sheet-save" data-real>${ICONS.save}<span data-i18n="tray.save"></span></button>
        <button class="hs-btn pri" id="sheet-share" data-real>${ICONS.share}<span data-i18n="tray.share"></span></button>
        <button class="hs-btn" id="sheet-del" data-dwell>${ICONS.trash}<span data-i18n="tray.del"></span></button>
        <button class="hs-btn" id="sheet-close" data-dwell>${ICONS.close}<span data-i18n="tray.close"></span></button>
      </div>
      <div class="cap sheet-note" data-i18n="tray.tap"></div>
    </div>
  </div>

  <div class="hs-modal" id="hud-license" hidden>
    <div class="sheet glass lic">
      <div class="ph"><span data-i18n="lic.title"></span><em class="cap">OPEN SOURCE</em>
        <button class="x" id="lic-close" data-dwell aria-label="close">${ICONS.close}</button></div>
      <div class="lic-body" id="lic-body"></div>
    </div>
  </div>

  <div class="hs-modal" id="hud-diag" hidden>
    <div class="sheet glass diag">
      <div class="ph"><span data-i18n="diag.title"></span><em class="cap">DIAGNOSTICS</em>
        <button class="x" id="diag-close" data-dwell aria-label="close">${ICONS.close}</button></div>
      <div class="diag-body" id="diag-body"></div>
      <div class="diag-actions">
        <button class="hs-btn pri" id="diag-copy" data-real>${ICONS.copy}<span data-i18n="diag.copy"></span></button>
        <button class="hs-btn" id="diag-x" data-dwell>${ICONS.close}<span data-i18n="tray.close"></span></button>
      </div>
    </div>
  </div>

  <div class="hs-attract" id="hud-attract" hidden>
    <div class="cube3d"><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <div class="at-t" data-i18n="attract.go"></div>
    <div class="at-s" data-i18n="attract.sub"></div>
    <div class="cap">HAND SCULPTOR · STUDIO PATTI</div>
  </div>`;

  const $ = id => root.querySelector('#' + id);
  const els = {
    status: $('hud-status'), stText: root.querySelector('.st-text'), stCap: root.querySelector('.st-cap'), pose: $('hud-pose'),
    toast: $('hud-toast'), hints: $('hud-hints'), rec: $('hud-rec'), count: $('hud-count'), countdown: $('hud-countdown'), flash: $('hud-flash'),
    guide: $('hud-guide'), tray: $('hud-tray'), tb: $('hud-toolbar'), tbItems: root.querySelector('.tb-items'),
    pops: { shape: $('pop-shape'), color: $('pop-color'), menu: $('pop-menu') }, menuGrid: $('menu-grid'),
    link: $('hud-link'), sheet: $('hud-sheet'), license: $('hud-license'), diag: $('hud-diag'), attract: $('hud-attract'),
    health: $('hud-health'),
  };

  // ── i18n ───────────────────────────────────────────────────────────────
  function applyLang() {
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    renderMenu(); renderStatus(); renderLinkState();
  }

  // ── layout ─────────────────────────────────────────────────────────────
  const insetTracker = createInsetTracker({ min: UI.insetMin, max: UI.insetMax, k: UI.insetPalm });
  let inset = UI.insetMin, mobile = false;
  function layout() {
    const W = innerWidth, H = innerHeight;
    const wasMobile = mobile;
    mobile = W <= UI.mobileBreakpoint || H > W;
    root.classList.toggle('hs-mobile', mobile);
    if (mobile !== wasMobile) { renderMenu(); renderTray(); }   // ボタン位置 tile + tray size depend on it (also on the first layout)
    root.classList.toggle('side-left', settings.side === 'left');
    root.classList.toggle('side-right', settings.side !== 'left');
    root.style.setProperty('--inset', (mobile ? inset : frameInset(inset, root.getBoundingClientRect().width, W)) + 'px');
    // desktop: one column if 6 targets fit into the 15–70 % band, else 2 columns
    const tgt = UI.fingerTarget, band = (UI.bandBottom - UI.bandTop) * H;
    const oneCol = band >= 6 * tgt + 5 * 8 + 16;
    root.classList.toggle('tb-2col', !mobile && !oneCol);
    const F = root.getBoundingClientRect();
    root.classList.toggle('narrow', !mobile && F.width < 420);   // 縦 frame on a common laptop (R3-3)
    if (!mobile) {
      const tbH = els.tbItems.offsetHeight || (oneCol ? 6 * (tgt + 8) : 3 * (tgt + 8));
      let top = UI.bandTop * H + Math.max(0, (band - tbH) / 2);
      // 縦 frame: the tutorial card spans the frame above a 2-column toolbar, so the toolbar starts below it
      // (kept clear of the tray / count row). tutorial.js calls layout() when the card shows or hides.
      const tut = root.querySelector('.hs-tut:not([hidden])');
      if (tut && !oneCol && framedNow()) top = Math.max(top, Math.min(tut.getBoundingClientRect().bottom - F.top + 8, F.height - 30 - tgt - tbH));
      els.tb.style.top = Math.round(top) + 'px';
      root.style.setProperty('--tbb', Math.round(top + tbH) + 'px');   // toolbar bottom (css: the toast goes below it)
    } else els.tb.style.top = '';
    placeGuide();
    if (openPanel && openPanel !== 'link') placePop(els.pops[openPanel]); else coverLink();
    if (curTrayFit() !== trayFitNow) renderTray(); else liftHints();
    // 縦 refused (window too low, phone sideways): the たて/よこ tile shows what capture really does (R3-3)
    const ref = orientRefused();
    if (ref !== lastRefused) {
      const was = lastRefused; lastRefused = ref; renderMenu();
      if (ref && was === false) explainRefused();
    }
    rectsDirty = true;
  }
  /**
   * 縦 frame on a PC: the open guide goes into the black bar beside the frame, so it never covers the toolbar
   * (R3-2). Its ? button stays in the frame and closes it. A bar narrower than guideMinW (windows ~770–940 px
   * wide) gets the slim guide (.guide-slim: 2-line rows); a PC window (> 760 px, wider than high) always has
   * ≥ 134 px. Below GUIDE_SLIM_W it opens in the frame as before, is not restored there from the last session
   * and closes when a toolbar pop-up opens.
   */
  const GUIDE_SLIM_W = 120;
  let guideOut = false, guideFromStorage = true;
  function placeGuide() {
    const F = root.getBoundingClientRect();
    const framed = !mobile && framedNow();
    const bar = settings.side === 'left' ? innerWidth - F.right : F.left;
    const w = Math.min(UI.guideW, Math.floor(bar - 32));
    guideOut = framed && w >= GUIDE_SLIM_W;
    root.classList.toggle('guide-out', guideOut);
    root.classList.toggle('guide-slim', guideOut && w < UI.guideMinW);
    if (guideOut) root.style.setProperty('--gw', w + 'px'); else root.style.removeProperty('--gw');
    if (framed && !guideOut && guideOpen && guideFromStorage) setGuide(false, false);
  }
  let lastRefused = null;
  const orientRefused = () => settings.orientation === 'portrait' && stageFrame(innerWidth, innerHeight, 'portrait').rotate;
  const phoneUA = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  /** One short line why 縦 is not used (a phone is asked to turn by main.js instead). */
  function explainRefused() {
    const st = document.getElementById('start');   // behind the start screen nobody reads it (せってい says it again)
    if (!phoneUA() && !(st && !st.hidden && !st.classList.contains('out'))) hint(t('hint.short'));
  }
  /**
   * たて/よこ tile. Picking たて in a window too low for the frame first asks for full screen (a real click only),
   * then lays out again; if it still does not fit, the tile keeps showing よこ and one line says why.
   */
  let fsForPortrait = false;
  async function setOrientation(o, e) {
    settings.orientation = o;
    const de = document.documentElement;
    const settle = () => new Promise(res => { const done = () => { removeEventListener('resize', done); res(); }; addEventListener('resize', done); setTimeout(done, 500); });
    if (o === 'portrait' && orientRefused() && e?.isTrusted && !phoneUA() && de.requestFullscreen && !document.fullscreenElement) {
      try { await de.requestFullscreen(); fsForPortrait = true; await settle(); } catch { /* refused: stays in the window */ }
    } else if (o === 'landscape' && fsForPortrait && document.fullscreenElement && document.exitFullscreen) {
      fsForPortrait = false;   // back to 横: leave the full screen that 縦 asked for
      try { await document.exitFullscreen(); await settle(); } catch { /* already left */ }
    }
    lastRefused = orientRefused();
    renderMenu();
    act('orientation', o);
    if (o === 'portrait' && lastRefused) explainRefused();
  }
  /** Keep the toolbar ≥ 1.5·palmPx from the edge (hand-reachable). Never moves mid-reach (see createInsetTracker). */
  function setHandScale(palmPx, now = performance.now()) {
    const busy = !!dwellEl || !!openPanel || !els.sheet.hidden || !els.license.hidden || !els.diag.hidden;
    const next = insetTracker.update(palmPx, now, busy);
    if (next == null) return;
    inset = next; layout();
  }
  /** 縦 frame on a PC: toolbar buttons a pop-up / the link panel only partly covers are hidden instead of
   *  peeking out as slices (they cannot be fired while covered anyway). r = covering rect or null; keep = its button. */
  function markUnder(r, keep = null) {
    for (const b of els.tbItems.querySelectorAll('[id^="tb-"]')) {
      let on = false;
      if (r && b !== keep && b.offsetWidth) {
        const q = b.getBoundingClientRect();
        on = Math.min(q.right, r.right) - Math.max(q.left, r.left) > 1 && Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top) > 1;
      }
      b.classList.toggle('tb-under', on);
    }
    // the OBJECTS count / tray a panel has to cover in a short frame are hidden with it, not drawn through it
    for (const e of [els.count, els.tray]) {
      let on = false;
      if (r && e.offsetWidth) {
        const q = e.getBoundingClientRect();
        on = q.height > 2 && Math.min(q.right, r.right) - Math.max(q.left, r.left) > 1 && Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top) > 1;
      }
      e.classList.toggle('pop-under', on);
    }
    // the ? button too (R4: 17 settings tiles = 5 rows at 1280x560 in the 縦 frame reach it; the pop-up's ✕ closes it).
    // Closed guide: the whole block goes; open beside the frame (guide-out): only the button, the guide stays readable.
    const gt = $('guide-toggle');
    let gon = false;
    if (r && gt.offsetWidth) {
      const q = gt.getBoundingClientRect();
      gon = Math.min(q.right, r.right) - Math.max(q.left, r.left) > 1 && Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top) > 1;
    }
    const openG = els.guide.classList.contains('open');
    els.guide.classList.toggle('pop-under', gon && !openG);
    gt.classList.toggle('pop-under', gon && openG);
    rectsDirty = true;
  }
  const framedNow = () => { const F = root.getBoundingClientRect(); return F.width < innerWidth - 1 || F.height < innerHeight - 1; };
  function placePop(pop) {
    if (!pop || pop.hidden) return;
    markUnder(null);
    pop.style.transform = ''; pop.style.maxWidth = ''; pop.style.width = '';
    const grid = pop.querySelector('.g-shape, .g-color, .g-menu');
    if (grid) grid.style.gridTemplateColumns = '';
    if (mobile) return;
    const F = root.getBoundingClientRect();
    if (F.width < innerWidth - 1 || F.height < innerHeight - 1) { placeFramed(pop, grid, F); rectsDirty = true; return; }
    const r = pop.getBoundingClientRect(), H = innerHeight, pad = 12;
    // stay below the status card when the panel reaches over it (short windows)
    const st = els.status.getBoundingClientRect();
    const minTop = st.height && r.left < st.right && r.right > st.left ? Math.max(pad, st.bottom + 8) : pad;
    let dy = 0;
    if (r.bottom > H - pad) dy = H - pad - r.bottom;
    if (r.top + dy < minTop) dy = minTop - r.top;
    if (dy) pop.style.transform = `translateY(${Math.round(dy)}px)`;
  }
  /** 縦 frame on a PC: every button of the pop-up stays inside the frame (a finger outside it is not tracked),
   *  the opening button and the status card / guide button stay uncovered; fewer columns when needed. */
  function placeFramed(pop, grid, F) {
    const side = settings.side === 'left' ? 'left' : 'right';
    const btn = root.querySelector('#tb-' + pop.id.replace('pop-', '')) || els.tbItems;
    const bR = btn.getBoundingClientRect();
    const obstacles = [els.status, els.guide].filter(e => e && !e.hidden && e.offsetWidth).map(e => e.getBoundingClientRect());
    const floor = [els.count, els.tray].filter(e => e.offsetWidth).map(e => e.getBoundingClientRect()).filter(o => o.height > 2);
    const regions = popRegions({ frame: F, tb: els.tbItems.getBoundingClientRect(), btn: bR, side, obstacles, floor });
    const n0 = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 1;
    const cw = grid?.firstElementChild?.offsetWidth || 88;
    const cells = [...pop.querySelectorAll('.cell, .tile')];
    pop.style.width = 'max-content';   // its natural width (an abs. box beside the toolbar would shrink to min-content)
    const minW = Math.min(cw, UI.fingerTarget) - 1;   // no target narrower than a finger
    const fits = () => pop.scrollWidth <= pop.clientWidth + 1 && cells.every(c => c.offsetWidth >= minW && c.scrollWidth <= c.clientWidth + 1);
    const moveTo = (x, y, keep = btn) => {   // pop offsets ignore transforms (and the opening animation)
      const tb = els.tb.getBoundingClientRect();
      pop.style.transform = `translate(${Math.round(x - tb.left - pop.offsetLeft)}px, ${Math.round(y - tb.top - pop.offsetTop)}px)`;
      markUnder({ left: x, top: y, right: x + pop.offsetWidth, bottom: y + pop.offsetHeight }, keep);
    };
    for (const rg of regions) {
      for (let c = n0 + 1; c >= Math.min(2, n0); c--) {   // one more column first: a wide region may take a shorter pop-up
        if (grid) grid.style.gridTemplateColumns = `repeat(${c}, minmax(0, ${cw}px))`;
        pop.style.maxWidth = Math.floor(rg.x1 - rg.x0) + 'px';
        if (!fits()) continue;
        const at = fitPop(pop.offsetWidth, pop.offsetHeight, rg, bR.top, side);
        if (at) { moveTo(at.x, at.y); return; }
      }
    }
    // nothing fits (short frame): full frame width with the most columns that keep finger-size cells
    pop.style.maxWidth = Math.floor(F.width - 16) + 'px';
    let ok = false;
    for (let c = n0 + 1; grid && c >= Math.min(2, n0); c--) {
      grid.style.gridTemplateColumns = `repeat(${c}, minmax(0, ${cw}px))`;
      if ((ok = fits())) break;
    }
    if (grid && !ok) grid.style.gridTemplateColumns = `repeat(${n0}, minmax(0, ${cw}px))`;
    const w = pop.offsetWidth, h = pop.offsetHeight, x = side === 'left' ? F.left + 8 : F.right - 8 - w;
    // below the opening button, else above it, clear of the status card / guide button above and the tray /
    // count row below. Taller than either side (R3-6): between those, over the toolbar (then over the count /
    // tray row) — the opening button is hidden with the rest (no sliver left to dwell on) and the ✕ in the
    // pop-up header closes it.
    const across = o => o.left < x + w && o.right > x;
    const minTop = obstacles.filter(across).reduce((m, o) => Math.max(m, o.bottom + 8), F.top + 8);
    const maxBot = floor.filter(across).reduce((m, o) => Math.min(m, o.top - 8), F.bottom - 8);
    const below = bR.bottom + 8, above = bR.top - 8 - h;
    if (below + h <= maxBot) moveTo(x, below);
    else if (above >= minTop) moveTo(x, above);
    else if (maxBot - minTop >= h) moveTo(x, clamp(below, minTop, maxBot - h), null);
    else if (F.bottom - 8 - minTop >= h) moveTo(x, clamp(below, minTop, F.bottom - 8 - h), null);   // over the count / tray (hidden)
    else moveTo(x, clamp(below, F.top + 8, Math.max(F.top + 8, F.bottom - 8 - h)), null);
  }
  // the toolbar slides (0.3 s) when the inset or the frame changes: the open pop-up follows it
  els.tb.addEventListener('transitionend', e => {
    if (e.target === els.tb && openPanel && openPanel !== 'link') placePop(els.pops[openPanel]);
    else if (e.target === els.tb) coverLink();
    rectsDirty = true;
  });
  addEventListener('resize', layout);
  addEventListener('orientationchange', () => setTimeout(layout, 120));

  // ── panels ─────────────────────────────────────────────────────────────
  function setPanel(name) {
    if (name === openPanel) name = null;
    openPanel = name;
    for (const [k, p] of Object.entries(els.pops)) {
      p.hidden = k !== name;
      root.querySelector('#tb-' + k)?.classList.toggle('on', k === name);
    }
    if (name && els.pops[name]) placePop(els.pops[name]);
    else coverLink();
    // R3-2: a pop-up is never drawn over the open guide (phone, short window, 縦 frame): the guide closes.
    // Beside the 縦 frame (guide-out) or on a wide screen they do not meet, and the guide stays.
    if (name && els.pops[name] && guideOpen && !guideOut) {
      const a = els.pops[name].getBoundingClientRect(), g = $('guide-panel').getBoundingClientRect();
      if (Math.min(a.right, g.right) - Math.max(a.left, g.left) > 1 && Math.min(a.bottom, g.bottom) - Math.max(a.top, g.top) > 1) {
        setGuide(false);
        placePop(els.pops[name]);   // the guide was an obstacle: place it again without it
      }
    }
    if (name === 'menu' && orientRefused()) explainRefused();
    rectsDirty = true;
    if (name === 'menu' || (name === null && lastMenuOpen)) act('settings', name === 'menu');
    lastMenuOpen = name === 'menu';
  }
  let lastMenuOpen = false;
  document.addEventListener('pointerdown', e => {
    if (!openPanel || !e.isTrusted) return;
    if (els.tb.contains(e.target)) return;
    setPanel(null);
  }, true);

  // ── toolbar & panel wiring ─────────────────────────────────────────────
  const on = (id, fn) => { const el = typeof id === 'string' ? $(id) : id; el?.addEventListener('click', e => fn(e, el)); };
  on('tb-shape', () => setPanel('shape'));
  on('tb-color', () => setPanel('color'));
  on('tb-menu', () => setPanel('menu'));
  for (const k of ['shape', 'color', 'menu']) on(`pop-${k}-x`, () => setPanel(null));   // R3-6: never depends on the opener
  on('tb-undo', () => { setPanel(null); act('undo'); });
  on('tb-photo', () => { setPanel(null); act('photo'); });
  on('tb-rec', () => { setPanel(null); act('record'); });
  root.querySelectorAll('[data-shape]').forEach(b => on(b, () => {
    style.type = b.dataset.shape; renderStyle(); setPanel(null); act('shape', style.type);
  }));
  root.querySelectorAll('[data-color]').forEach(b => on(b, () => {
    style.colorIdx = +b.dataset.color; renderStyle(); setPanel(null); act('color', style.colorIdx);
  }));
  root.querySelectorAll('[data-op]').forEach(b => on(b, () => {
    style.opacity = +b.dataset.op; renderStyle(); act('opacity', style.opacity);
  }));

  // guide
  function setGuide(open, persist = true) {
    guideOpen = !!open;
    if (persist) { lsSet(UI.storageKeys.guideOpen, guideOpen); guideFromStorage = false; }
    els.guide.classList.toggle('open', guideOpen); rectsDirty = true;
    $('guide-toggle').classList.toggle('on', guideOpen);
    coverLink();
  }
  on('guide-toggle', () => setGuide(!guideOpen));   // beside the 縦 frame the ? button stays and closes the guide
  on('guide-close', () => setGuide(false));
  on('guide-tutorial', () => { setGuide(false); act('tutorial'); });

  // settings tiles
  const MENU = [
    { id: 'dup', act: () => act('duplicate') },
    { id: 'clear', act: () => act('clear'), kiosk: false, danger: true },
    { id: 'export', act: () => act('export'), cap: 'GLB', kiosk: false, show: () => settings.canExport },
    { id: 'ar', act: () => act('arQuickLook'), cap: 'AR', kiosk: false, real: true, show: () => settings.ios },
    { id: 'bones', val: () => settings.bones, act: () => toggle('bones') },
    { id: 'depth', val: () => settings.depth, act: () => toggle('depth') },
    { id: 'mirror', val: () => settings.mirror, act: () => toggle('mirror') },
    { id: 'quality', val: () => t('v.' + settings.quality), act: () => cycle('quality', QUALITIES) },
    { id: 'clarity', val: () => settings.clarity !== false, act: () => { settings.clarity = settings.clarity === false; renderMenu(); act('clarity', settings.clarity); } },
    { id: 'sound', val: () => settings.sound, act: () => toggle('sound') },
    { id: 'orient', val: () => t('v.' + (orientRefused() ? 'landscape' : settings.orientation)),
      act: e => setOrientation(settings.orientation === 'portrait' && !orientRefused() ? 'landscape' : 'portrait', e) },
    { id: 'rec', val: () => t('v.sec', { n: settings.recordSec }), act: () => cycle('recordSec', REC_SECS) },
    { id: 'camera', val: () => t('v.' + settings.facing), act: () => cycle('facing', ['user', 'environment'], 'camera') },
    { id: 'side', val: () => t('v.' + settings.side), act: () => cycle('side', ['right', 'left']), show: () => !mobile },   // phones: bottom bar, nothing moves
    { id: 'tutorial', act: () => { setPanel(null); act('tutorial'); } },
    { id: 'link', act: () => { setPanel(null); openLink(true); }, show: () => !!linkInfo && !settings.kiosk },
    { id: 'diag', act: () => { setPanel(null); openDiag(); }, cap: 'INFO' },
    { id: 'license', act: () => { setPanel(null); openLicense(); } },
  ];
  function toggle(k) { settings[k] = !settings[k]; renderMenu(); act(k, settings[k]); }
  function cycle(k, list, actionName = k) {
    settings[k] = list[(list.indexOf(settings[k]) + 1) % list.length];
    renderMenu();
    if (k === 'side') layout();
    act(actionName, settings[k]);
  }
  function renderMenu() {
    const items = MENU.filter(m => (m.show ? m.show() : true) && !(settings.kiosk && m.kiosk === false));
    els.menuGrid.innerHTML = items.map(m => {
      const v = m.val ? m.val() : null;
      const vs = v === true ? t('v.on') : v === false ? t('v.off') : v == null ? (m.cap || '') : v;
      const cls = ['tile', v === true ? 'is-on' : '', v === false ? 'is-off' : '', m.danger ? 'danger' : ''].join(' ');
      return `<button class="${cls}" id="set-${m.id}" ${m.real ? 'data-real' : 'data-dwell'}><span class="tl">${esc(t('set.' + m.id))}</span><em class="cap tv">${esc(vs)}</em></button>`;
    }).join('');
    items.forEach(m => on('set-' + m.id, e => m.act(e)));
    rectsDirty = true;
    if (openPanel === 'menu') placePop(els.pops.menu);
  }

  // ── status / pose / count / toast / hints ──────────────────────────────
  let trackState = 'loading', handsCount = 0;
  function renderStatus() {
    els.status.dataset.state = trackState;
    els.stText.textContent = t('st.' + trackState, { n: handsCount });
    els.stCap.textContent = trackState.toUpperCase();
  }
  function setTracking(state, n = 0) {
    if (state === trackState && n === handsCount) return;
    trackState = state; handsCount = n; renderStatus();
  }
  /** Tracker health (R4): 'ok' | 'retrying' | 'fatal' (+ short code) from tracker.on('status'). Extra line on the card. */
  let health = { state: 'ok', code: '' };
  function setHealth(state = 'ok', code = '') {
    const v = healthView(state, code);
    health = { state: v.show ? state : 'ok', code: v.code };
    els.health.hidden = !v.show;
    els.status.classList.toggle('has-health', v.show);
    if (v.show) els.status.dataset.health = health.state; else delete els.status.dataset.health;
    els.health.querySelector('.ht').textContent = v.show ? t(v.key) : '';
    const c = els.health.querySelector('.hc'); c.hidden = !v.code; c.textContent = v.code;
    rectsDirty = true;
    if (!els.diag.hidden) renderDiag();
  }
  let lastPose = null;
  function setPose(pose) {
    if (pose === lastPose) return; lastPose = pose;
    const show = pose && pose !== 'neutral' && t('pose.' + pose) !== 'pose.' + pose;
    els.pose.hidden = !show;
    if (show) { els.pose.textContent = t('pose.' + pose); els.pose.dataset.pose = pose; }
  }
  let lastCount = -1;
  function setCount(n) {
    if (n === lastCount) return; lastCount = n;
    els.count.querySelector('b').textContent = String(n).padStart(2, '0');
    els.count.classList.toggle('zero', !n);
  }
  let toastTimer = 0;
  function toast(text, ms = UI.toastMs) {
    els.toast.textContent = text; els.toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
  }
  const hintEls = new Map();
  /** One-off hint chip. Same text again just refreshes its timer. */
  function hint(text, ms = UI.hintMs) {
    if (!text) return;
    let h = hintEls.get(text);
    if (!h) {
      const el = document.createElement('div'); el.className = 'chip glass'; el.textContent = text;
      els.hints.appendChild(el); h = { el, timer: 0 }; hintEls.set(text, h);
      requestAnimationFrame(() => el.classList.add('show'));
      while (hintEls.size > 2) { const [k, o] = hintEls.entries().next().value; removeHint(k, o); }
    }
    clearTimeout(h.timer);
    if (ms > 0) h.timer = setTimeout(() => removeHint(text, h), ms);
  }
  function removeHint(text, h = hintEls.get(text)) {
    if (!h) return; hintEls.delete(text); clearTimeout(h.timer);
    h.el.classList.remove('show'); setTimeout(() => h.el.remove(), 250);
  }
  /** Persistent hint from interaction output (string|null), e.g. 「☝️で えらんでね」. */
  let curHint = null;
  function setHint(text) {
    if (text === curHint) return;
    if (curHint) removeHint(curHint);
    curHint = text || null;
    if (curHint) hint(curHint, 0);
  }

  // ── style ──────────────────────────────────────────────────────────────
  function renderStyle() {
    const sb = $('tb-shape').querySelector('.ic');
    sb.innerHTML = SHAPE_ICONS[style.type] || SHAPE_ICONS.random;
    const sw = $('tb-color').querySelector('.sw');
    sw.classList.toggle('rnd', style.colorIdx < 0);
    sw.style.setProperty('--c', style.colorIdx >= 0 ? colors[style.colorIdx] : 'transparent');
    sw.style.setProperty('--a', Math.min(1, style.opacity * 2.2));
    root.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('on', b.dataset.shape === style.type));
    root.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('on', +b.dataset.color === style.colorIdx));
    root.querySelectorAll('[data-op]').forEach(b => b.classList.toggle('on', Math.abs(+b.dataset.op - style.opacity) < 1e-3));
  }
  function setStyle(s = {}) {
    if (s.type != null) style.type = s.type;
    if (s.colorIdx != null) style.colorIdx = s.colorIdx;
    if (s.opacity != null) {   // snap any value to the nearest level
      style.opacity = LEVELS.reduce((a, b) => Math.abs(b - s.opacity) < Math.abs(a - s.opacity) ? b : a, LEVELS[0]);
    }
    renderStyle();
  }
  function setSelected(b) {
    selected = !!b;
    $('tb-color').querySelector('.selmark').hidden = !selected;
    const ht = root.querySelector('#pop-color .ph-t');
    ht.textContent = t(selected ? 'panel.colorSel' : 'panel.color');
  }
  function setMode() { /* draw mode was cut in v2.0 (SPEC §13.1) — kept for interface compatibility */ }
  function setCanUndo(b) { $('tb-undo').classList.toggle('dim', !b); }

  // ── recording / countdown / flash ──────────────────────────────────────
  function setRecording(on, seconds = 0, maxSec = settings.recordSec) {
    recording = !!on;
    els.rec.hidden = !recording;
    if (recording) { els.rec.querySelector('.t').textContent = fmtTime(seconds); els.rec.querySelector('.tm').textContent = ` / ${fmtTime(maxSec)}`; }
    const b = $('tb-rec');
    b.classList.toggle('live', recording);
    b.querySelector('.ic').innerHTML = recording ? ICONS.stop : ICONS.rec;
    b.querySelector('.lb').textContent = t(recording ? 'tb.stop' : 'tb.rec');
  }
  let cdLast = null;
  function countdown(n) {
    if (n === cdLast) return; cdLast = n;
    if (!n) { els.countdown.hidden = true; return; }
    els.countdown.hidden = false;
    els.countdown.innerHTML = `<b>${esc(n)}</b>`;
  }
  function flash() {
    els.flash.classList.remove('go'); void els.flash.offsetWidth; els.flash.classList.add('go');
  }

  // ── tray (captures) ────────────────────────────────────────────────────
  let trayFitNow = -1;
  const curTrayFit = () => trayFit({ hudW: root.getBoundingClientRect().width, countW: els.count.offsetWidth, mobile,
    tgt: parseFloat(getComputedStyle(root).getPropertyValue('--tgt')) || UI.fingerTarget });
  /** Hint chips sit bottom-centre: lift them above the tray when it reaches under them (narrow 縦 frame, R2-9). */
  function liftHints() {
    let lift = false;
    if (!mobile && tray.length) {
      const F = root.getBoundingClientRect(), T = els.tray.getBoundingClientRect();
      lift = T.right - F.left + 12 > F.width / 2 - 170;   // a long chip is up to ~340 px wide
    }
    root.classList.toggle('tray-lift', lift);
  }
  function renderTray() {
    trayFitNow = curTrayFit();
    const v = trayView(tray.length, trayFitNow);
    const show = tray.slice(tray.length - v.show).reverse();
    els.tray.innerHTML = show.map((it, i) => `
      <button class="thumb glass" id="tray-${i}" data-dwell data-tid="${esc(it.id)}">
        ${it.thumb ? `<img src="${esc(it.thumb)}" alt="">` : it.kind === 'video' ? `<video src="${esc(it.url)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(it.url)}" alt="">`}
        ${it.kind === 'video' ? `<span class="vbadge">${ICONS.play}${it.sec ? fmtTime(it.sec) : ''}</span>` : ''}
      </button>`).join('') + (v.more ? `<span class="more cap">+${v.more}</span>` : '');
    els.tray.querySelectorAll('[data-tid]').forEach(b => on(b, () => openSheet(b.dataset.tid)));
    els.tray.classList.toggle('has', tray.length > 0);
    liftHints();
    rectsDirty = true;
  }
  /** item = {id, kind:'photo'|'video', url, thumb?, sec?}. Newest is shown first. Max UI.trayMax (8). */
  function addTrayItem(item) {
    const max = 8;
    tray.push(item);
    while (tray.length > max) { const old = tray.shift(); act('trayEvict', old.id); }
    renderTray();
    const el = els.tray.querySelector('.thumb'); el?.classList.add('pop');
    if (!els.sheet.hidden) syncSheet();   // indexes moved: keep showing (and acting on) the same capture
  }
  function removeTrayItem(id) {
    const i = tray.findIndex(x => x.id === id); if (i < 0) return;
    tray.splice(i, 1); renderTray();
    if (els.sheet.hidden) return;
    if (!tray.length) closeSheet();
    else if (id === sheetId) showSheetAt(Math.min(i, tray.length - 1));   // the shown one went: its neighbour
    else syncSheet();
  }
  function clearTray() { tray.length = 0; renderTray(); closeSheet(); }
  function openSheet(id) { const i = tray.findIndex(x => x.id === id); if (i >= 0) { showSheetAt(i); act('trayOpen', id); } }
  function showSheetAt(i) {
    const it = tray[i]; if (!it) return;
    sheetId = it.id;
    const m = $('sheet-media');
    m.innerHTML = it.kind === 'video'
      ? `<video src="${esc(it.url)}" controls muted playsinline loop autoplay></video>`
      : `<img src="${esc(it.url)}" alt="">`;
    $('sheet-share').hidden = !(navigator.share);
    els.sheet.hidden = false;
    syncSheet();
  }
  /** n / m and ‹ › for the shown capture (media untouched, so a playing video keeps playing). Gone → close. */
  function syncSheet() {
    const i = sheetIndexFor(tray, sheetId);
    if (i < 0) { closeSheet(); return; }
    sheetIdx = i;
    $('sheet-idx').textContent = `${tray.length - i} / ${tray.length}`;
    $('sheet-prev').disabled = i >= tray.length - 1; $('sheet-next').disabled = i <= 0;
    rectsDirty = true;
  }
  const shownItem = () => tray[sheetIndexFor(tray, sheetId)] || null;
  function closeSheet() {
    els.sheet.hidden = true; sheetIdx = -1; sheetId = null; $('sheet-media').innerHTML = ''; rectsDirty = true;
  }
  on('sheet-prev', () => { const i = sheetIndexFor(tray, sheetId); if (i >= 0) showSheetAt(Math.min(tray.length - 1, i + 1)); });
  on('sheet-next', () => { const i = sheetIndexFor(tray, sheetId); if (i >= 0) showSheetAt(Math.max(0, i - 1)); });
  on('sheet-close', closeSheet);
  on('sheet-del', () => { const it = shownItem(); if (it) { act('trayDelete', it.id); removeTrayItem(it.id); } });
  // REAL taps only (user activation is needed for share/download) — onAction runs synchronously inside the click.
  on('sheet-save', e => { const it = shownItem(); if (it && e.isTrusted) act('traySave', it.id); });
  on('sheet-share', e => { const it = shownItem(); if (it && e.isTrusted) act('trayShare', it.id); });
  els.sheet.addEventListener('click', e => { if (e.target === els.sheet) closeSheet(); });

  // ── license viewer ─────────────────────────────────────────────────────
  const LICENSES = [
    ['three.js', 'MIT', 'vendor/three/LICENSE'],
    ['fflate', 'MIT', 'vendor/three/addons/libs/LICENSE-fflate.txt'],
    ['MediaPipe Tasks Vision + hand models', 'Apache-2.0', 'vendor/mediapipe/LICENSE.txt'],   // notice (incl. our change)
    ['MediaPipe: Apache License 2.0 full text', 'Apache-2.0', 'vendor/mediapipe/LICENSE'],
    ['qrcode-generator', 'MIT', 'vendor/qrcode/LICENSE'],
  ];
  let licLoaded = false;
  async function openLicense() {
    els.license.hidden = false; rectsDirty = true;
    if (licLoaded) return;
    const body = $('lic-body');
    body.innerHTML = '<div class="cap">LOADING…</div>';
    const parts = await Promise.all(LICENSES.map(async ([name, kind, path]) => {
      try {
        const r = await fetch(assetBase + path);
        if (!r.ok) return null;
        const txt = await r.text();
        return `<details><summary><b>${esc(name)}</b><em class="cap">${esc(kind)}</em></summary><pre>${esc(txt)}</pre></details>`;
      } catch { return null; }
    }));
    const ok = parts.filter(Boolean);
    body.innerHTML = ok.length ? ok.join('') : `<div>${esc(t('lic.none'))}</div>`;
    licLoaded = ok.length > 0;
  }
  function closeLicense() { els.license.hidden = true; rectsDirty = true; }
  on('lic-close', closeLicense);
  els.license.addEventListener('click', e => { if (e.target === els.license) closeLicense(); });

  // ── 診断 panel (R4): engine / path / results per second / camera / screen / errors / state, + コピー ──────
  // main.js gives the tracker-side numbers through setDiagProvider(); the HUD adds the browser, screen and health.
  let diagProvider = null, diagTimer = 0, diagRows = [];
  function setDiagProvider(fn) { diagProvider = typeof fn === 'function' ? fn : null; if (!els.diag.hidden) renderDiag(); }
  function diagInfo() {
    let d = {};
    try { d = (diagProvider && diagProvider()) || {}; } catch (e) { console.warn('[hud] diag', e); }
    return {
      engine: engineName(typeof navigator !== 'undefined' ? navigator.userAgent || '' : '', typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0),
      screenW: innerWidth, screenH: innerHeight, dpr: devicePixelRatio || 1, health: health.state, code: health.code, ...d,
    };
  }
  function renderDiag() {
    diagRows = diagLines(diagInfo());
    $('diag-body').innerHTML = diagRows.map(([k, v]) => `<div class="dk">${esc(t(k))}</div><div class="dv">${esc(v)}</div>`).join('');
  }
  function openDiag() {
    renderDiag();
    els.diag.hidden = false; rectsDirty = true;
    clearInterval(diagTimer); diagTimer = setInterval(() => { if (els.diag.hidden) clearInterval(diagTimer); else renderDiag(); }, 1000);
  }
  function closeDiag() { els.diag.hidden = true; clearInterval(diagTimer); diagTimer = 0; rectsDirty = true; }
  /** Copy the rows as text. A REAL tap only (clipboard needs user activation); textarea fallback for old WebKit. */
  async function copyDiag(e) {
    if (!e?.isTrusted && !e?.__hsTest) return;
    const text = diagText(diagRows.length ? diagRows : diagLines(diagInfo()), t);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      try {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
      } catch { /* ignore */ }
    }
    const s = $('diag-copy').querySelector('span');
    s.textContent = t(ok ? 'diag.copied' : 'diag.copy');
    if (ok) setTimeout(() => { s.textContent = t('diag.copy'); }, 2000);
    return ok;
  }
  on('diag-close', closeDiag); on('diag-x', closeDiag);
  on('diag-copy', e => copyDiag(e));
  els.diag.addEventListener('click', e => { if (e.target === els.diag) closeDiag(); });

  // Esc closes an open license / 診断 / sheet first, and nothing else on that key press (R2-8)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!els.license.hidden) closeLicense(); else if (!els.diag.hidden) closeDiag(); else if (!els.sheet.hidden) closeSheet(); else return;
    e.stopPropagation();
  }, true);

  // ── スマホ連携 panel (link.js fills #link-slot) ─────────────────────────
  let linkState = { connected: false, lanOn: false, mode: 'ar' };
  function showLink(info) { linkInfo = info || null; renderMenu(); }
  function openLink(open) {
    els.link.hidden = !open; rectsDirty = true; act('link', !!open);
    coverLink();
  }
  /** 縦 frame on a PC: the link panel or the open guide panel (no pop-up open) hides the toolbar buttons under it */
  function coverLink() {
    let r = null;
    if (!mobile && !(openPanel && els.pops[openPanel]) && framedNow()) {
      if (!els.link.hidden) r = els.link.getBoundingClientRect();
      else if (guideOpen && !guideOut && els.guide.classList.contains('open')) r = $('guide-panel').getBoundingClientRect();
    }
    markUnder(r && r.width > 2 ? r : null);
  }
  function setLinkState(s = {}) { Object.assign(linkState, s); renderLinkState(); }
  function renderLinkState() {
    els.link.classList.toggle('connected', !!linkState.connected);
    els.link.classList.toggle('lan-off', !linkState.connected && !linkState.lanOn);
    els.link.querySelector('.lstate').textContent = t(linkStateKey(linkState));
    $('link-ar').classList.toggle('on', linkState.mode !== 'iphone');
    $('link-phone').classList.toggle('on', linkState.mode === 'iphone');
  }
  on('link-close', () => openLink(false));
  on('link-ar', () => { linkState.mode = 'ar'; renderLinkState(); act('linkMode', 'ar'); });
  on('link-phone', () => { linkState.mode = 'iphone'; renderLinkState(); act('linkMode', 'iphone'); });

  // ── settings / kiosk / attract ─────────────────────────────────────────
  function setSettings(s = {}) {
    const sideChanged = s.side && s.side !== settings.side;
    Object.assign(settings, s);
    if ('showBones' in s) settings.bones = s.showBones;
    root.classList.toggle('kiosk', !!settings.kiosk);
    renderMenu();
    if (sideChanged || 'kiosk' in s) layout();
  }
  function setAttract(on) { els.attract.hidden = !on; root.classList.toggle('attract', !!on); }

  // ── finger dwell ───────────────────────────────────────────────────────
  let rectsDirty = true, rectsAt = 0, rects = [];
  function visible(el) {
    if (el.disabled) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkVisibilityCSS: true });   // not opacity: panels fade in
    return el.getClientRects().length > 0;
  }
  function collect(now) {
    if (!rectsDirty && now - rectsAt < 250) return rects;
    rects = [];
    document.querySelectorAll('[data-dwell]').forEach(el => {
      if (!el.id || !visible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      rects.push({ id: el.id, r });
    });
    rectsDirty = false; rectsAt = now;
    return rects;
  }
  /** True when something else is drawn on top of `el` at (x, y) — a finger must not fire what it cannot see. */
  function covered(el, x, y) {
    const top = document.elementFromPoint?.(x, y);
    return !!top && top !== el && !el.contains(top);
  }
  /** Screen px (CSS) → {id} of the dwell-able control under it, or null. Modals capture everything. */
  function hitTest(sx, sy) {
    const list = collect(performance.now());
    const slop = UI.dwellSlopPx;
    const modal = [els.sheet, els.license, els.diag].find(m => !m.hidden);
    let best = null, bestD = Infinity;
    for (const { id, r } of list) {
      const el = document.getElementById(id);
      if (!el || (modal && !modal.contains(el))) continue;
      if (sx < r.left - slop || sx > r.right + slop || sy < r.top - slop || sy > r.bottom + slop) continue;
      if (covered(el, clamp(sx, r.left + 1, r.right - 1), clamp(sy, r.top + 1, r.bottom - 1))) continue;
      const d = Math.hypot(sx - (r.left + r.right) / 2, sy - (r.top + r.bottom) / 2);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best ? { id: best } : null;
  }
  let dwellEl = null;
  function setDwell(id, progress = 0) {
    const el = id ? document.getElementById(id) : null;
    if (dwellEl && dwellEl !== el) { dwellEl.classList.remove('dwelling'); dwellEl.style.removeProperty('--dwell'); }
    dwellEl = el;
    if (el) { el.classList.add('dwelling'); el.style.setProperty('--dwell', clamp(progress, 0, 1).toFixed(3)); }
  }
  /** Fire a control as if tapped (finger dwell). REAL-tap-only controls are refused. */
  function activate(id) {
    const el = document.getElementById(id);
    if (!el || el.hasAttribute('data-real') || el.disabled) return false;
    setDwell(null);
    el.classList.remove('fired'); void el.offsetWidth; el.classList.add('fired');
    el.click();
    return true;
  }

  // ── init ───────────────────────────────────────────────────────────────
  if (guideOpen == null) guideOpen = false;
  setGuide(guideOpen, false);
  applyLang(); renderStyle(); renderTray(); setRecording(false); setCount(0);
  // the link panel grows when link.js fills it (QR): re-check which toolbar buttons it covers
  if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(() => coverLink()); ro.observe(els.link); ro.observe($('guide-panel')); }
  layout(); requestAnimationFrame(layout);

  return {
    root, settings, style,
    setTracking, setHealth, setPose, toast, setCount, setStyle, setMode, setSelected, setCanUndo,
    hitTest, setDwell, activate, setRecording, countdown, flash,
    showLink, setLinkState, openLink, getLinkSlot: () => $('link-slot'),
    setSettings, applyLang, setHandScale, hint, setHint, setAttract, setGuide, setPanel,
    addTrayItem, removeTrayItem, clearTray, openSheet, closeSheet, openLicense,
    setDiagProvider, openDiag, closeDiag, copyDiag, get health() { return { ...health }; },
    get mobile() { return mobile; }, get openPanel() { return openPanel; }, layout,
  };
}
