// スマホ連携 client (browser). Active only when the app is served by server.mjs (localhost, app at "/").
//
//   const link = createLink();
//   link.info.then(info => info && hud.showLink(info));      // null when not served by server.mjs
//   link.mountPanel(hudPanelEl);  link.mountPhone(hudPhoneEl);
//   per frame:  link.update(trackedHands, sw, sh, nowMs, left, top);  // stage rect in page px; phone mode only
//   link.mode  'ar' | 'iphone' ;  link.setMode(m) ; link.onStatus(fn)
//   capture tray: link.uploadClip(blob, name) → Promise<{id,url}|null> (null unless LAN on or phone mode) ;  link.deleteClip(id | {id} | that Promise)
//
// The WebSocket (role 'pc') is opened automatically once /api/info answers — it also keeps the
// local server alive (server --auto-exit ends 20 s after the last PC socket closes).
import { PhoneMode } from './core/phonemode.js';
import qrcode from '../vendor/qrcode/qrcode.mjs';
import { addStrings, t } from './i18n.js';

addStrings({
  ja: {
    'lnk.title': 'スマホ連携',
    'lnk.on': 'iPhone つながった',
    'lnk.wait': 'iPhone まってる',
    'lnk.off': 'オフ',
    'lnk.start': 'iPhoneと つなぐ',
    'lnk.stop': 'おわる',
    'lnk.scan': 'iPhoneのカメラで よんでね',
    'lnk.fail': 'つなげなかった',
    'lnk.fw': 'iPhoneが繋がらない→PCの『アクセスを許可』',
    'lnk.nonet': 'Wi-Fiに つないでね',
    'lnk.ar': 'AR',
    'lnk.phone': 'スマホ',
    'lnk.label': 'iPhoneの中の操作パネル（ほかのアプリは動かせません）',
  },
});

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const STYLE_ID = 'hs-link-style';

function shouldProbe(force) {
  if (force) return true;
  try {
    if (new URLSearchParams(location.search).get('link') === '1') return true;
    const base = new URL('../', import.meta.url);
    return LOOPBACK.has(location.hostname) && base.pathname === '/' && base.origin === location.origin;
  } catch { return false; }
}

/** QR code as an SVG string (dark modules on white, 4-module quiet zone). */
export function qrSvg(text, { size = 168, ecc = 'M' } = {}) {
  const q = qrcode(0, ecc);
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), m = 4, tot = n + 2 * m;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${tot} ${tot}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR">` +
    `<rect width="${tot}" height="${tot}" fill="#fff"/><path d="${d}" fill="#000814"/></svg>`;
}

/** Label text → HTML: a break before the （…） part so it fits the ~200 px phone (text unchanged). */
export function labelHtml(s) {
  const esc = String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return esc.replace('（', '<br>（');
}

export function createLink(opts = {}) {
  const api = (p) => new URL('../' + p, import.meta.url);
  const pm = new PhoneMode(opts.phone || {});
  const listeners = new Set();
  const st = { available: false, connected: false, phone: false, phones: 0, mode: 'ar', lanOn: false, lanUrls: [], phoneApp: null, error: null, fwHint: false };
  let ws = null, wsDelay = 500, wsTimer = 0, wanted = false, fwTimer = 0, urlIdx = 0;
  let panelEl = null, phoneEl = null, iframe = null, ownPhoneEl = false;

  const emit = () => { const s = status(); for (const fn of listeners) { try { fn(s); } catch (e) { console.warn('[link] listener', e); } } render(); };
  const status = () => ({ ...st, lanUrls: [...st.lanUrls] });

  const info = (async () => {
    if (!shouldProbe(opts.force)) return null;
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 1500);
      const r = await fetch(api('api/info'), { cache: 'no-store', signal: ac.signal });
      clearTimeout(to);
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || j.app !== 'hand-sculptor' || !j.link) return null;
      st.available = true; st.lanOn = !!j.lanOn; st.lanUrls = j.lanUrls || []; st.phones = j.phones | 0; st.phone = st.phones > 0;
      if (opts.autoConnect !== false) connect();
      emit();
      return j;
    } catch { return null; }
  })();

  // ---------------- WebSocket (role pc) with backoff 0.5 → 8 s
  function connect() {
    wanted = true;
    clearTimeout(wsTimer);
    if (ws && ws.readyState <= 1) return;
    const u = api('ws'); u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(u); } catch { return retry(); }
    ws.onopen = () => { wsDelay = 500; ws.send(JSON.stringify({ t: 'hello', role: 'pc' })); st.connected = true; emit(); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!m) return;
      if (m.t === 'peer') {
        st.phones = m.phones | 0; st.phone = !!m.phone;
        if (st.phone) { clearTimeout(fwTimer); st.fwHint = false; }
        emit();
      } else if (m.t === 'status') { st.phoneApp = m.app || null; emit(); }
      else if (m.t === 'clips') refreshPhone();
    };
    ws.onclose = () => { ws = null; const was = st.connected; st.connected = false; st.phone = false; if (was) emit(); retry(); };
    ws.onerror = () => { try { ws && ws.close(); } catch {} };
  }
  function retry() {
    if (!wanted) return;
    clearTimeout(wsTimer);
    wsTimer = setTimeout(connect, wsDelay);
    wsDelay = Math.min(8000, wsDelay * 2);
  }
  function disconnect() { wanted = false; clearTimeout(wsTimer); try { ws && ws.close(); } catch {} ws = null; }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden && wanted && !ws) { wsDelay = 500; connect(); } });
  }

  // ---------------- commands
  function send(cmd) {
    if (!cmd) return;
    const m = cmd.t === 'cmd' ? cmd : { t: 'cmd', ...cmd };
    if (iframe && iframe.contentWindow && st.mode === 'iphone') {
      try { iframe.contentWindow.postMessage(m, location.origin); } catch {}
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  }
  /** W, H, left, top = the stage rect in page px (縦 pillarbox: the stage is offset, R1-21). */
  function update(hands, W, H, nowMs, left = 0, top = 0) {
    if (st.mode !== 'iphone') return [];
    const cmds = pm.update(hands, { W, H, left, top }, nowMs);
    for (const c of cmds) send(c);
    return cmds;
  }
  function setMode(m) {
    const mode = m === 'iphone' || m === 'phone' ? 'iphone' : 'ar';
    if (mode === st.mode) return;
    if (st.mode === 'iphone') send({ t: 'cmd', action: 'hide' });
    st.mode = mode;
    pm.reset();
    showPhone();
    if (mode === 'iphone') refreshPhone(); // captures taken while it was hidden
    emit();
  }
  // the virtual phone has no socket: tell it to reload its gallery (debounced; it loads by itself when created)
  let refreshTimer = 0;
  function refreshPhone() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (iframe && iframe.contentWindow) { try { iframe.contentWindow.postMessage({ t: 'clips' }, location.origin); } catch {} }
    }, 60);
  }

  // ---------------- LAN listener
  async function post(p) {
    const r = await fetch(api(p), { method: 'POST', headers: { 'X-HS': '1' }, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || ('http ' + r.status));
    return j;
  }
  async function startLan() {
    try {
      const j = await post('api/link/start');
      st.lanOn = !!j.lanOn; st.lanUrls = j.lanUrls || []; st.error = null; urlIdx = 0;
      clearTimeout(fwTimer); st.fwHint = false;
      if (!st.phone && st.lanUrls.length) fwTimer = setTimeout(() => { if (!st.phone && st.lanOn && st.lanUrls.length) { st.fwHint = true; emit(); } }, 30000);
    } catch (e) { st.error = e && e.message === 'nonet' ? 'nonet' : 'fail'; }
    emit();
    return status();
  }
  async function stopLan() {
    try { const j = await post('api/link/stop'); st.lanOn = !!j.lanOn; } catch {}
    clearTimeout(fwTimer); st.fwHint = false; st.lanUrls = [];
    emit();
    return status();
  }

  /** A capture goes to the server only while スマホ連携 is in use: LAN listener on, or the virtual phone shown (R3-8). */
  const shareOn = () => st.available && (st.lanOn || st.mode === 'iphone');
  async function uploadClip(blob, name = '') {
    if (!shareOn() || !blob) return null;
    try {
      const r = await fetch(api('api/clip'), {
        method: 'POST', body: blob, cache: 'no-store',
        headers: { 'X-HS': '1', 'Content-Type': blob.type || 'application/octet-stream', 'X-Name': encodeURIComponent(name) },
      });
      const j = r.ok ? await r.json() : null;
      if (j && j.ok) refreshPhone();
      return j;
    } catch { return null; }
  }
  /** Removes a capture from the server (tray delete). Accepts the id, the upload result, or uploadClip's Promise. */
  async function deleteClip(ref) {
    if (!st.available || !ref) return false;
    try {
      const r0 = await ref;
      const id = typeof r0 === 'string' ? r0 : r0 && r0.id;
      if (!id || !/^[0-9a-f]{1,32}$/.test(id)) return false;
      const r = await fetch(api('api/clip/' + id), { method: 'DELETE', headers: { 'X-HS': '1' }, cache: 'no-store' });
      refreshPhone();
      return r.ok;
    } catch { return false; }
  }

  // ---------------- UI
  function injectStyle() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  /**
   * Renders the panel into `el`. Inside the HUD's link panel (#link-slot / .hs-link) the HUD already
   * shows the title, state and AR⇄スマホ toggle, so those are left out unless forced with opts.
   */
  function mountPanel(el, { header, modeToggle } = {}) {
    injectStyle();
    panelEl = el;
    if (!el) return;
    const inHud = !!(el.closest && el.closest('.hs-link, #link-slot'));
    if (header === undefined) header = !inHud;
    if (modeToggle === undefined) modeToggle = !inHud;
    el.classList.add('hsl');
    // ids: hud.collect() only dwell-targets elements with an id (finger use, R1-15)
    el.innerHTML = `
      ${header ? `<div class="hsl-head"><i class="hsl-dot"></i><b>${t('lnk.title')}</b><span class="hsl-state"></span></div>` : ''}
      ${modeToggle ? `<div class="hsl-mode" role="group">
        <button type="button" id="lnk-mode-ar" data-dwell data-hsl="mode-ar">${t('lnk.ar')}</button>
        <button type="button" id="lnk-mode-iphone" data-dwell data-hsl="mode-iphone">${t('lnk.phone')}</button>
      </div>` : ''}
      <button type="button" id="lnk-start" class="hsl-btn hsl-start" data-dwell data-hsl="start">📱 ${t('lnk.start')}</button>
      <div class="hsl-qrbox">
        <div class="hsl-qr"></div>
        <div class="hsl-cap">${t('lnk.scan')}</div>
        <div class="hsl-url" data-hsl="url"></div>
        <div class="hsl-fw"></div>
        <button type="button" id="lnk-stop" class="hsl-btn hsl-stop" data-dwell data-hsl="stop">${t('lnk.stop')}</button>
      </div>
      <div class="hsl-err"></div>`;
    el.addEventListener('click', onPanelClick);
    render();
  }
  function onPanelClick(e) {
    const b = e.target.closest('[data-hsl]');
    if (!b) return;
    const a = b.dataset.hsl;
    if (a === 'mode-ar') setMode('ar');
    else if (a === 'mode-iphone') setMode('iphone');
    else if (a === 'start') startLan();
    else if (a === 'stop') stopLan();
    else if (a === 'url' && st.lanUrls.length > 1) { urlIdx = (urlIdx + 1) % st.lanUrls.length; render(true); }
  }
  let lastQr = '';
  function render(forceQr) {
    if (!panelEl) return;
    const q = (s) => panelEl.querySelector(s);
    if (!q('.hsl-start')) return;
    const dot = q('.hsl-dot'), state = q('.hsl-state');
    const kind = !st.available ? 'off' : st.phone ? 'on' : st.lanOn ? 'wait' : 'off';
    if (dot) dot.className = 'hsl-dot ' + kind;
    if (state) state.textContent = kind === 'on' ? t('lnk.on') : kind === 'wait' ? t('lnk.wait') : t('lnk.off');
    for (const b of panelEl.querySelectorAll('[data-hsl^="mode-"]')) b.classList.toggle('on', b.dataset.hsl === 'mode-' + st.mode);
    const url = st.lanUrls[urlIdx % Math.max(1, st.lanUrls.length)] || '';
    const nonet = st.lanOn && !url; // listener on but the PC lost its network
    q('.hsl-start').hidden = st.lanOn;
    q('.hsl-qrbox').hidden = !st.lanOn;
    q('.hsl-qr').hidden = nonet;
    q('.hsl-cap').hidden = nonet;
    if (nonet) { q('.hsl-qr').innerHTML = ''; lastQr = ''; }
    if (st.lanOn && url && (url !== lastQr || forceQr)) {
      q('.hsl-qr').innerHTML = qrSvg(url);
      lastQr = url;
    }
    const u = q('.hsl-url');
    u.textContent = url.replace(/\?k=.*$/, '') + (st.lanUrls.length > 1 ? '  ⇄' : '');
    q('.hsl-fw').textContent = nonet ? t('lnk.nonet') : st.fwHint ? t('lnk.fw') : '';
    q('.hsl-err').textContent = st.error === 'nonet' ? t('lnk.nonet') : st.error ? t('lnk.fail') : '';
  }

  /** Virtual phone container. Without `el` a floating container (right side, 60vh) is created. */
  function mountPhone(el) {
    injectStyle();
    if (!el) {
      el = document.createElement('div');
      el.className = 'hsl-phone-float';
      document.body.appendChild(el);
      ownPhoneEl = true;
    }
    phoneEl = el;
    showPhone();
  }
  function showPhone() {
    if (!phoneEl) return;
    if (st.mode !== 'iphone') { phoneEl.hidden = true; dockPanel(); return; }
    phoneEl.hidden = false;
    if (!iframe) {
      phoneEl.classList.add('hsl-phone');
      phoneEl.innerHTML = `<div class="hsl-phone-label">${labelHtml(t('lnk.label'))}</div><div class="hsl-phone-frame"><iframe title="${t('lnk.title')}"></iframe></div>`;
      iframe = phoneEl.querySelector('iframe');
      iframe.src = api('iphone/?embed=1').href;
      // Integration fix: the phone page is laid out for a ~390 px wide screen; the 60vh frame is only ~200 px
      // wide, which cut off its app grid. Render it at 390 px and scale it down to the frame.
      fitPhone();
      if (!fitBound) { fitBound = true; window.addEventListener('resize', () => { fitPhone(); dockPanel(); }); }
    }
    requestAnimationFrame(() => { fitPhone(); dockPanel(); });
  }
  let fitBound = false;
  /**
   * The HUD's centred スマホ連携 panel overlapped the virtual phone at 1280×720 / 1366×768.
   * In phone mode slide the panel sideways (away from the phone) just enough; AR mode restores it.
   */
  let dockObs = null, dockSaved = null; // dockSaved: the panel's inline `left` before we moved it
  function dockPanel() {
    const host = panelEl && panelEl.closest && panelEl.closest('.hs-link');
    if (!host) return;
    if (!dockObs && typeof MutationObserver !== 'undefined') { // the HUD opens the panel later (hidden → shown)
      dockObs = new MutationObserver(() => requestAnimationFrame(dockPanel));
      dockObs.observe(host, { attributes: true, attributeFilter: ['hidden'] });
    }
    if (dockSaved !== null) { host.style.left = dockSaved; dockSaved = null; } // undo only our own move
    if (host.hidden) return;
    if (st.mode !== 'iphone' || !phoneEl || phoneEl.hidden) return;
    const f = phoneEl.querySelector('.hsl-phone-frame') || phoneEl;
    const pr = f.getBoundingClientRect(), hr = host.getBoundingClientRect();
    if (!pr.width || !hr.width || hr.right <= pr.left - 12 || hr.left >= pr.right + 12) return;
    const vw = document.documentElement.clientWidth || innerWidth;
    const toLeft = pr.left + pr.width / 2 >= vw / 2;
    let dx = toLeft ? (pr.left - 12) - hr.right : (pr.right + 12) - hr.left;
    dx = Math.max(16 - hr.left, Math.min(vw - 16 - hr.right, dx)); // stay on screen
    const base = parseFloat(getComputedStyle(host).left);
    if (Math.abs(dx) >= 1 && Number.isFinite(base)) { dockSaved = host.style.left; host.style.left = Math.round(base + dx) + 'px'; }
  }
  function fitPhone() {
    const f = phoneEl && phoneEl.querySelector('.hsl-phone-frame');
    if (!f || !iframe || !f.clientWidth) return;
    const cs = getComputedStyle(f);
    const w = f.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = f.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const k = w / 390;
    f.style.overflow = 'hidden';
    Object.assign(iframe.style, { width: '390px', height: Math.round(h / k) + 'px', transform: `scale(${k.toFixed(4)})`, transformOrigin: '0 0', borderRadius: Math.round(34 / k) + 'px' });
  }
  function unmountPhone() {
    if (phoneEl) {
      if (ownPhoneEl) phoneEl.remove();
      else { phoneEl.innerHTML = ''; phoneEl.hidden = true; phoneEl.classList.remove('hsl-phone'); }
    }
    iframe = null; phoneEl = null; ownPhoneEl = false;
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('message', (e) => {
      if (!iframe || e.source !== iframe.contentWindow || e.origin !== location.origin) return;
      if (e.data && e.data.t === 'status') { st.phoneApp = e.data.app || null; emit(); }
    });
  }

  return {
    info,
    get available() { return st.available; },
    get mode() { return st.mode; },
    setMode, connect, disconnect, send, update,
    onStatus(fn) { listeners.add(fn); try { fn(status()); } catch {} return () => listeners.delete(fn); },
    status, startLan, stopLan, uploadClip, deleteClip, dockPanel,
    mountPanel, mountPhone, unmountPhone,
    phoneMode: pm,
  };
}

// every [data-dwell] button here is a PC finger-dwell target: ≥ 64 px (SPEC §13.7, R2-24)
const CSS = `
.hsl{display:flex;flex-direction:column;gap:10px;color:#dff9ff;font:13px/1.4 system-ui,"Hiragino Sans","Yu Gothic UI",sans-serif}
.hsl [hidden]{display:none!important}
.hsl-head{display:flex;align-items:center;gap:8px}
.hsl-head b{font-weight:600;letter-spacing:.06em}
.hsl-state{margin-left:auto;font-size:12px;color:rgba(170,230,255,.7)}
.hsl-dot{width:8px;height:8px;border-radius:50%;background:#ff4d6a;box-shadow:0 0 8px #ff4d6a;flex:none}
.hsl-dot.wait{background:#ffe14d;box-shadow:0 0 8px #ffe14d}
.hsl-dot.on{background:#00ffa3;box-shadow:0 0 8px #00ffa3}
.hsl-mode{display:grid;grid-template-columns:1fr 1fr;border:1px solid rgba(0,240,255,.35);border-radius:10px;overflow:hidden}
.hsl-mode button{min-height:var(--tgt,64px);background:transparent;border:0;color:rgba(200,240,255,.75);font:600 13px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;cursor:pointer}
.hsl-mode button.on{background:rgba(0,240,255,.18);color:#00f0ff;text-shadow:0 0 8px rgba(0,240,255,.7)}
.hsl-btn{min-height:var(--tgt,64px);min-width:var(--tgt,64px);border-radius:10px;border:1px solid rgba(0,240,255,.4);background:rgba(0,240,255,.08);color:#00f0ff;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}
.hsl-stop{min-height:var(--tgt,64px);padding:0 22px;font-size:13px;color:rgba(200,240,255,.75);border-color:rgba(0,240,255,.2);background:transparent}
.hsl-qrbox{display:flex;flex-direction:column;align-items:center;gap:6px}
.hsl-qr{padding:8px;border-radius:12px;background:#fff;box-shadow:0 0 0 1px rgba(0,240,255,.5),0 0 22px rgba(0,240,255,.25);line-height:0}
.hsl-cap{font-size:12px;color:rgba(170,230,255,.8)}
.hsl-url{font:11px ui-monospace,Consolas,monospace;color:rgba(170,230,255,.55);background:none;border:0;cursor:pointer;word-break:break-all}
.hsl-fw,.hsl-err{font-size:12px;color:#ffe14d;text-align:center}
.hsl-fw:empty,.hsl-err:empty{display:none}
.hsl-phone-float{position:fixed;right:24px;top:50%;transform:translateY(-50%);z-index:30}
.hsl-phone{display:flex;flex-direction:column;align-items:center;gap:8px}
.hsl-phone-label{box-sizing:border-box;width:0;min-width:100%;font-size:12px;line-height:1.35;color:#d8f6ff;text-align:center;white-space:normal;overflow-wrap:anywhere;letter-spacing:.02em;padding:5px 8px;border-radius:8px;background:rgba(6,14,24,.72);border:1px solid rgba(0,240,255,.22);text-shadow:0 1px 2px #000;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.hsl-phone-frame{height:60vh;aspect-ratio:9/19.5;padding:10px;border-radius:44px;background:rgba(0,8,22,.72);
  border:1px solid rgba(0,240,255,.45);box-shadow:0 0 30px rgba(0,240,255,.22),inset 0 0 18px rgba(0,240,255,.12);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.hsl-phone-frame iframe{width:100%;height:100%;border:0;border-radius:34px;background:#000812;display:block}
`;
