// Start screen + camera permission flow + error guidance. SPEC §7, §12, §13.6, §13.7.
// showStart({ root, onLaunch, onNoCamera, kiosk }) -> { showError(code, detail), hide(), setProgress(0..1), launch() }
//  - onLaunch(): Promise — called from the REAL tap on はじめる (getUserMedia needs it). Resolve → screen hides
//    (resolve exactly `false` to keep it). Reject with a DOMException → its .name picks the guidance.
//  - Error codes: NotAllowedError, NotFoundError, OverconstrainedError, NotReadableError, AbortError, SecurityError,
//    insecure, file, inapp, unsupported, model, unknown.
import { addStrings, t } from '../i18n.js';
import { ICONS } from './hud.js';

addStrings({ ja: {
  'start.tag': '手で 3Dを つくろう',
  'start.go': 'はじめる', 'start.busy': 'カメラ 起動中…',
  'start.note1': '映像は ネットに送りません', 'start.note2': '明るい場所で',
  'start.nocam': 'カメラなしで 試す',
  'start.retry': 'もう一度', 'start.copy': 'URLを コピー', 'start.copied': 'コピーしました',
  'err.NotAllowedError': 'カメラが ブロックされています',
  'err.NotAllowedError.d': 'アドレスバー左の アイコン → カメラを 許可',
  // R2-2: only controls that are really on screen. Which line is picked: camBlockedKey() below.
  'err.cam.ios': '設定 → {app} → カメラ を 許可',
  'err.cam.mac': 'Safari → 設定 → Webサイト → カメラ',
  'err.cam.app': 'Chromeで 開いて 許可してね',
  'err.cam.os': 'パソコンの 設定で カメラを オンに',
  'err.cam.ask': 'もう一度 押して 許可してね',
  'err.NotFoundError': 'カメラが 見つかりません', 'err.NotFoundError.d': 'カメラを つないで もう一度',
  'err.NotReadableError': 'カメラが 使用中です', 'err.NotReadableError.d': 'Zoom などを 閉じて もう一度',
  'err.insecure': 'この開き方では 使えません', 'err.insecure.d': 'https で 開いてね',
  'err.file': 'ファイルを 直接 開いています', 'err.file.d': 'アイコンから 開いてね',
  'err.inapp': 'ここでは カメラが 使えません', 'err.inapp.d': 'Safari か Chrome で 開いてね',
  // R4: accurate — importmap / WebGL2 / getUserMedia missing means THIS browser (in-app view, old engine) cannot run it.
  // Never 「最新にしてね」: an up-to-date phone can land here (LINE/Instagram view), and the advice would be wrong.
  'err.unsupported': 'このブラウザでは 動きません', 'err.unsupported.d': 'Safari か Chrome で ひらいてね',
  'err.model': 'よみこみに 失敗しました', 'err.model.d': '通信を 確認して もう一度',
  'err.unknown': 'カメラを 開けませんでした', 'err.unknown.d': 'もう一度 試してね',
}});

const ALIAS = { OverconstrainedError: 'NotFoundError', AbortError: 'NotReadableError', SecurityError: 'NotAllowedError',
  PermissionDeniedError: 'NotAllowedError', DevicesNotFoundError: 'NotFoundError', TrackStartError: 'NotReadableError' };
const NO_RETRY = new Set(['insecure', 'file', 'inapp', 'unsupported']);
const IN_APP = /Instagram|FBAN|FBAV|Line\/|BytedanceWebview|musical_ly/i;

// Our own circle + hexagon sigil (decorative, behind the title).
const hex = (r, a0 = -90) => Array.from({ length: 6 }, (_, i) => {
  const a = (a0 + i * 60) * Math.PI / 180; return (200 + r * Math.cos(a)).toFixed(1) + ',' + (200 + r * Math.sin(a)).toFixed(1);
}).join(' ');
const SIGIL = `<svg class="st-sigil" viewBox="0 0 400 400" fill="none" stroke="currentColor">
  <circle cx="200" cy="200" r="190" stroke-width="0.8" opacity=".35"/>
  <g class="spin-a"><circle cx="200" cy="200" r="172" stroke-width="1" stroke-dasharray="2 9" opacity=".7"/></g>
  <g class="spin-b"><circle cx="200" cy="200" r="150" stroke-width="1.2" stroke-dasharray="90 28 8 28" opacity=".55"/>
    <polygon points="${hex(150)}" stroke-width="0.8" opacity=".4"/></g>
  <g class="spin-a"><polygon points="${hex(118, 0)}" stroke-width="1" opacity=".5"/></g>
  <circle cx="200" cy="200" r="96" stroke-width="0.8" opacity=".3"/>
</svg>`;

/**
 * Camera blocked (NotAllowedError): which line to show. Never a button that is not on screen (R2-2):
 *  - only dismissed (the browser will ask again) → もう一度
 *  - iPhone/iPad: the Settings app (iOS 18+ moved Safari under アプリ; Chrome etc. on iOS have their own page)
 *  - the browser allows the camera but it still fails → the computer's own privacy switch is off
 *  - no address bar (the launcher's --app window, an installed app, fullscreen) → open it in Chrome
 *  - Safari on a Mac: its Settings window. Everything else: the icon left of the address (Chrome, Edge, Firefox).
 * env = { ua, platform, touch, bar (address bar visible), perm ('granted'|'denied'|'prompt'|null) } → {key, vars}
 */
export function camBlockedKey({ ua = '', platform = '', touch = 0, bar = true, perm = null } = {}) {
  if (perm === 'prompt') return { key: 'err.cam.ask' };   // only dismissed: もう一度 asks again
  if (/iP(hone|ad|od)/.test(ua) || (platform === 'MacIntel' && touch > 1)) {
    const m = /OS (\d+)_\d/.exec(ua), v = m ? +m[1] : 18;   // iPadOS sends a Mac UA: assume current
    const app = /CriOS/.test(ua) ? 'Chrome' : /EdgiOS/.test(ua) ? 'Edge' : /FxiOS/.test(ua) ? 'Firefox' : 'Safari';
    return { key: 'err.cam.ios', vars: { app: (v >= 18 ? 'アプリ → ' : '') + app } };
  }
  if (perm === 'granted') return { key: 'err.cam.os' };
  if (!bar) return { key: 'err.cam.app' };
  if (/Macintosh/.test(ua) && /Version\/[\d.]+ .*Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|Firefox/.test(ua)) return { key: 'err.cam.mac' };
  return { key: 'err.NotAllowedError.d' };
}
/** Does this window have an address bar? Only an app window (--app / installed: 'standalone' or 'minimal-ui') has
 *  none. A normal tab put in fullscreen (kiosk, F11) reports 'fullscreen' but its bar comes back on exit (R2-2). */
export function hasAddressBar(mm = q => window.matchMedia?.(q)?.matches === true) {
  return !mm('(display-mode: standalone)') && !mm('(display-mode: minimal-ui)');
}
const camEnv = (perm = null) => ({
  ua: navigator.userAgent || '', platform: navigator.platform || '', touch: navigator.maxTouchPoints || 0, perm,
  bar: hasAddressBar(),
});

/** Environment problems that make the camera impossible (checked before LAUNCH). */
export function detectBlocker() {
  if (window.__hsSupported === false) return 'unsupported';
  if (IN_APP.test(navigator.userAgent || '')) return 'inapp';
  if (location.protocol === 'file:') return 'file';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return null;
}

export function showStart({ root, onLaunch = async () => {}, onNoCamera = () => {}, kiosk = false } = {}) {
  root.classList.add('hs-start');
  root.hidden = false;
  root.innerHTML = `
  <div class="st-bg" aria-hidden="true">${SIGIL}</div>
  <div class="st-wrap">
    <div class="st-cap top">AR HOLOGRAM STUDIO</div>
    <h1 class="st-title">HAND SCULPTOR</h1>
    <p class="st-tag">${t('start.tag')}</p>
    <div class="st-actions" id="st-actions">
      <button class="st-go" id="st-launch" data-dwell><span class="lb">${t('start.go')}</span><em>LAUNCH</em></button>
      <div class="st-prog" id="st-prog"><i></i></div>
      <div class="st-cap" id="st-pct">LOADING</div>
    </div>
    <div class="st-err" id="st-err" hidden>
      <b id="st-err-t"></b><span id="st-err-d"></span>
      <div class="st-err-btns">
        <button class="st-btn pri" id="st-retry">${t('start.retry')}</button>
        <button class="st-btn pri" id="st-copy">${ICONS.copy}<span>${t('start.copy')}</span></button>
      </div>
    </div>
    <ul class="st-notes">
      <li>${ICONS.lock}<span>${t('start.note1')}</span></li>
      <li>${ICONS.sun}<span>${t('start.note2')}</span></li>
    </ul>
    <button class="st-link" id="st-nocam">${t('start.nocam')}</button>
  </div>
  <div class="st-foot">© STUDIO PATTI</div>`;

  const $ = id => root.querySelector('#' + id);
  const btn = $('st-launch'), errBox = $('st-err'), actions = $('st-actions'), notes = root.querySelector('.st-notes');
  let busy = false, hidden = false, progress = 0;

  function setProgress(p) {
    progress = Math.max(0, Math.min(1, +p || 0));
    root.style.setProperty('--prog', progress.toFixed(3));
    $('st-pct').textContent = progress >= 1 ? 'READY' : `LOADING ${Math.round(progress * 100)}%`;
    root.classList.toggle('ready', progress >= 1);
  }

  function showError(code = 'unknown', detail = '') {
    code = ALIAS[code] || code;
    if (!t('err.' + code).length || t('err.' + code) === 'err.' + code) code = 'unknown';
    busy = false; btn.disabled = false; btn.querySelector('.lb').textContent = t('start.go');
    hidden = false; root.hidden = false; root.classList.remove('out');
    $('st-err-t').textContent = t('err.' + code);
    const copy = code === 'inapp' || code === 'file' || code === 'insecure' || code === 'unsupported';   // URL → open it elsewhere
    errBox.hidden = false; errBox.dataset.code = code;
    $('st-retry').hidden = NO_RETRY.has(code);
    if (code === 'NotAllowedError') setBlocked(camBlockedKey(camEnv()));
    else { $('st-err-d').textContent = t('err.' + code + '.d'); $('st-copy').hidden = !copy; }
    actions.hidden = true;   // the error card has its own もう一度 button
    notes.hidden = true;     // its lock icon is not a button (R2-2)
    if (detail) console.warn('[start]', code, detail);
  }
  /** Blocked camera: show the best line now, then refine it once the browser says whether IT allows the camera. */
  function setBlocked(h) {
    $('st-err-d').textContent = t(h.key, h.vars);
    $('st-copy').hidden = h.key !== 'err.cam.app';   // no address bar: copy the URL for Chrome
    const seq = ++blockedSeq;
    navigator.permissions?.query?.({ name: 'camera' }).then(p => {
      if (seq !== blockedSeq || errBox.hidden || errBox.dataset.code !== 'NotAllowedError') return;
      const h2 = camBlockedKey(camEnv(p.state));
      $('st-err-d').textContent = t(h2.key, h2.vars);
      $('st-copy').hidden = h2.key !== 'err.cam.app';
    }).catch(() => {});
  }
  let blockedSeq = 0;

  async function launch() {
    if (busy) return;
    busy = true; errBox.hidden = true; actions.hidden = false; notes.hidden = false;
    btn.disabled = true; btn.querySelector('.lb').textContent = t('start.busy');
    if (kiosk && document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
    try {
      const r = await onLaunch();
      busy = false;
      if (r !== false) hide();
      else { btn.disabled = false; btn.querySelector('.lb').textContent = t('start.go'); }
    } catch (e) {
      showError(e?.name || e?.code || 'unknown', e?.message || String(e));
    }
  }

  function hide() {
    if (hidden) return; hidden = true;
    root.classList.add('out');
    setTimeout(() => { if (hidden) root.hidden = true; }, 420);
  }

  btn.addEventListener('click', launch);
  $('st-retry').addEventListener('click', launch);
  $('st-nocam').addEventListener('click', () => { hide(); onNoCamera(); });
  $('st-copy').addEventListener('click', async () => {
    const url = location.href.replace(/[?&]openExternalBrowser=1/, '');
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch {
      try {
        const ta = document.createElement('textarea'); ta.value = url; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
      } catch { /* ignore */ }
    }
    const s = $('st-copy').querySelector('span');
    s.textContent = ok ? t('start.copied') : url;
    setTimeout(() => { s.textContent = t('start.copy'); }, 2500);
  });

  setProgress(0);
  // Environment blockers. LINE: reopen in the external browser once [未確認: openExternalBrowser=1 is LINE's param].
  const blocker = detectBlocker();
  if (blocker === 'inapp' && /Line\//i.test(navigator.userAgent) && !/[?&]openExternalBrowser=1/.test(location.search)) {
    const u = new URL(location.href); u.searchParams.set('openExternalBrowser', '1');
    location.replace(u.toString());
  } else if (blocker) showError(blocker);

  return { showError, hide, setProgress, launch, get progress() { return progress; } };
}
