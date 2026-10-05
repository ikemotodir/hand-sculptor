// HAND SCULPTOR v2 — bootstrap, wiring and main loop (SPEC §12 + §13).
//
//   detection (per new video frame, tracker.start):
//     tracker.detect → stage.setFrame(frame) → mapping → HandTracker → Alchemy → Interaction
//     → intents/events → audio / HUD / tutorial / preview / sigil / link
//   render (rAF):
//     objects.update → fx.update → stage.render (capture hooks run inside) → overlay.draw
//
// Screen coordinates: every hand point is in PAGE css px (mapping with left/top). The 3D stage may be a
// pillarboxed 9:16 frame (縦 mode on a landscape screen), so the SceneAPI given to Interaction is wrapped
// to convert page px ↔ stage px.
import { CONFIG, VERSION, applyUrlOverrides } from './config.js';
import { addStrings, t, setLang } from './i18n.js';
import { makeMapping } from './core/mapping.js';
import { palmCenter, toPoints } from './core/handmath.js';
import { HandTracker } from './core/handtrack.js';
import { Alchemy } from './core/alchemy.js';
import { Interaction } from './core/interaction.js';
import { createStage } from './scene/stage.js';
import { createFx } from './scene/fx.js';
import { createObjects } from './scene/objects.js';
import { createHud } from './ui/hud.js';
import { createOverlay, drawSkeletons } from './ui/overlay.js';
import { showStart } from './ui/start.js';
import { createTutorial } from './ui/tutorial.js';
import { createAudio } from './audio.js';
import { createCapture, captureFileName, downloadBlob } from './capture.js';
import { stageFrame } from './ui/frame.js';
import { createStorage, registerSW, isARQuickLookSupported } from './storage.js';
import { createTracker, isMobileDevice } from './tracker.js';
import { createLink } from './link.js';
import { DEV_HOSTS, devOverrides } from './devcfg.js';

// Support check (index.html, classic script): without importmap + WebGL2 the start screen already says
// 「ブラウザを 最新にしてね」 — stop here quietly (no errors).
if (window.__hsSupported === false) await new Promise(() => {});

const Q = new URLSearchParams(location.search);
// ?cfg.* overrides are a dev/test tool: only on this PC (localhost) or with ?dev=1, never the watermark/share
// text, and only paths that already exist as own CONFIG keys (no __proto__ tricks) — R1-18
const DEV = DEV_HOSTS.has(location.hostname) || Q.get('dev') === '1';
const CFG_SEARCH = DEV ? devOverrides(Q) : '';
if (CFG_SEARCH) applyUrlOverrides(CFG_SEARCH);
setLang('ja');

// Service worker as early as possible: its install precaches the app, so the next visit starts offline
// (R1-36/R1-41). Not in automated tests unless ?sw=1.
if (!navigator.webdriver || Q.get('sw') === '1') registerSW({ version: VERSION });

addStrings({ ja: {
  'st.touch': 'タッチで あそぶ',
  'm.restored': '前回の作品を 復元', 'm.rare': '✨レア!', 'm.undo': 'もどした', 'm.noUndo': 'もどせない',
  'm.pickFirst': '☝️で えらんでね', 'm.copied': 'コピーした', 'm.cleared': 'ぜんぶ けした', 'm.empty': 'まだ なにも ないよ',
  'm.saved': '保存した', 'm.export': '3Dデータを 保存', 'm.quality': 'がしつを 下げたよ', 'm.camErr': 'カメラが 止まった', 'm.rotate': 'スマホを たてに してね',
  'm.camSwitch': 'カメラを 切りかえ中', 'm.arPrep': 'じゅんび中… もう一度', 'm.tray': '📷 左下に 保存したよ',
}});

const KIOSK = Q.get('kiosk') === '1';
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => performance.now();

// ───────────────────────────────────────────────────────────── settings
const storage = createStorage();
const settings = storage.loadSettings();
if (!settings.style || typeof settings.style !== 'object') settings.style = { type: 'random', colorIdx: -1, opacity: CONFIG.ui.defaultOpacity };
if (/(^|&)cfg\.render\.quality=/.test(CFG_SEARCH)) settings.quality = CONFIG.render.quality;   // test/dev override
CONFIG.core.depth.enabled = !!settings.depth;
CONFIG.ui.showBones = !!settings.bones;
const saveSettings = () => { if (!KIOSK) storage.saveSettings(settings); };

// ───────────────────────────────────────────────────────────── DOM + stage
const video = $('cam');
const glCanvas = $('gl');
const ovCanvas = $('overlay');
const hudRoot = $('hud');
const startRoot = $('start');

const view = { W: innerWidth, H: innerHeight, left: 0, top: 0, sw: innerWidth, sh: innerHeight, dpr: devicePixelRatio || 1 };
let stage;
try { stage = createStage({ canvas: glCanvas, video, config: CONFIG }); }
catch (e) {
  console.warn('[stage] WebGL unavailable', e?.message || e);
  showStart({ root: startRoot, onLaunch: async () => false, onNoCamera: () => location.reload() }).showError('unsupported');
  await new Promise(() => {});
}
const fx = createFx({ stage, config: CONFIG });
const metrics = { spawns: 0, alchemySpawns: 0, rare: 0, results: 0, handFrames: 0, maxHands: 0, renders: 0, launchedAt: 0, firstHandsAt: 0, dropped: 0 };
const objects = createObjects({
  stage, fx, config: CONFIG,
  onEvent: (name, data) => onSceneEvent(name, data),
});
const overlay = createOverlay(ovCanvas);
// bones-only layer for photos/videos (cursors and dwell rings are NOT captured, SPEC §13.6)
const bonesCanvas = document.createElement('canvas');
const bonesCtx = bonesCanvas.getContext('2d');
const audio = createAudio();
let hud = null;   // assigned below (the pointer guard reads it at event time)

// Pointer guard — registered BEFORE the HUD so it sees whether a panel was open when this tap began
// (the HUD closes panels on the same capture-phase pointerdown).
let panelOpenAtDown = false;
// Sound needs one real gesture. After an auto-launch (camera already allowed, no tap) the AudioContext starts
// suspended, so the first tap / click / key anywhere turns it on (R1-19/R1-35). Nothing extra is shown.
const unlockOnGesture = e => { if (e.isTrusted && mode !== 'idle' && audio.state !== 'running') audio.unlock(); };
document.addEventListener('pointerdown', e => {
  panelOpenAtDown = !!(hud && hud.openPanel);
  unlockOnGesture(e);
}, true);
document.addEventListener('keydown', unlockOnGesture, true);
document.addEventListener('click', unlockOnGesture, true);

hud = createHud({
  root: hudRoot,
  onAction: (name, payload) => onAction(name, payload),
  assetBase: './',
  colors: CONFIG.render.colors,
  shapes: CONFIG.render.shapes,
});
const tutorial = createTutorial({
  root: hudRoot, hud,
  onStart: () => {
    if (objects.count() === 0) objects.spawn({ type: 'box', color: CONFIG.render.colors[0], sx: view.sw / 2, sy: view.sh / 2, sizePx: Math.min(view.sw, view.sh) * 0.3, rare: false });
  },
});

// ───────────────────────────────────────────────────────────── layout
function layoutStage() {
  const W = innerWidth, H = innerHeight, dpr = devicePixelRatio || 1;
  // 縦 → the stage is a centered 9:16 frame, SPEC §13.6 (ui/frame.js). A phone held sideways is not framed
  // (a ~219 px strip cannot hold the HUD): full screen as 横, and a short toast asks to turn the phone (PC: no toast,
  // a taller window may not exist; the HUD chip says 横 is used).
  const fr = stageFrame(W, H, settings.orientation);
  const { sw, sh, left, top } = fr;
  if (fr.rotate && !view.rotate && isMobileDevice()) hud?.toast(t('m.rotate'), 2500);   // PC: hud.js says it once (hint.short)
  Object.assign(view, { W, H, sw, sh, left, top, dpr, rotate: fr.rotate, orientation: fr.orientation });
  glCanvas.style.left = left + 'px'; glCanvas.style.top = top + 'px';
  glCanvas.style.width = sw + 'px'; glCanvas.style.height = sh + 'px';
  stage.resize(sw, sh, dpr);
  overlay.resize(W, H, dpr);
  const od = overlay.dpr || dpr;
  bonesCanvas.width = Math.round(sw * od); bonesCanvas.height = Math.round(sh * od);
  inter?.setViewport(sw, sh);
  const framed = fr.framed;
  document.body.classList.toggle('hs-pillar', framed);
  // hands outside the 9:16 frame are cropped away in the video too — don't draw them on the black bars
  ovCanvas.style.clipPath = framed ? `inset(${top}px ${W - left - sw}px ${H - top - sh}px ${left}px)` : '';
  // The HUD lives inside the frame too, so the toolbar is where a fingertip (clipped to the frame) can reach
  // and see its cursor (R1-5). Safe-area padding is dropped on a side whose black bar is already wider.
  // (transform: the phone layout's position:fixed pop-ups then also anchor to the frame)
  Object.assign(hudRoot.style, framed
    ? { left: left + 'px', right: (W - left - sw) + 'px', top: top + 'px', bottom: (H - top - sh) + 'px', transform: 'translateZ(0)' }
    : { left: '', right: '', top: '', bottom: '', transform: '' });
  for (const [v, on] of [['--sat', top > 0], ['--sab', top > 0], ['--sal', left > 0], ['--sar', left > 0]]) {
    if (on) hudRoot.style.setProperty(v, '0px'); else hudRoot.style.removeProperty(v);
  }
  hud?.layout?.();
  mapping = null;
}
// (the PC HUD inside the narrow 縦 frame: .hs-pillar rules in css/app.css)
addEventListener('resize', layoutStage);
addEventListener('orientationchange', () => setTimeout(layoutStage, 150));

// ───────────────────────────────────────────────────────────── SceneAPI adapter (page px ↔ stage px)
const sceneApi = {
  pick: (sx, sy, slop) => objects.pick(sx - view.left, sy - view.top, slop),
  getScreenInfo: id => {
    const i = objects.getScreenInfo(id); if (!i) return null;
    const g = objects.get(id);
    return { x: i.x + view.left, y: i.y + view.top, r: i.r, z: g ? g.position[2] : 0 };
  },
  getSelected: () => objects.getSelected(),
  select: id => objects.select(id),
  setHover: id => objects.setHover(id),
  beginTransform: id => objects.beginTransform(id),
  endTransform: id => { objects.endTransform(id); markDirty(); },
  setGrabPose: (id, sx, sy, z) => objects.setGrabPose(id, sx - view.left, sy - view.top, z),
  rotateBy: (id, ax, ay, az) => objects.rotateBy(id, ax, ay, az),
  setSpin: (id, wx, wy) => { objects.setSpin(id, wx, wy); markDirty(); },
  scaleBy: (id, f) => objects.scaleBy(id, f),
  remove: id => { const r = objects.remove(id); markDirty(); return r; },
  duplicate: id => objects.duplicate(id),
  setStyle: (a, b) => objects.setStyle(a, b),
  spawn: o => {
    const p = { ...o };
    // stage px, kept inside the visible stage (縦: never on the black bars, R2-17)
    if (p.sx != null) p.sx = clamp(p.sx - view.left, 0, view.sw);
    if (p.sy != null) p.sy = clamp(p.sy - view.top, 0, view.sh);
    // Alchemy spawn continues the materializing preview: the preview already picked shape/colour/rare from the
    // same style (a fixed shape/colour is honoured by objects.setStyle), so hand those decisions to it.
    const fromPreview = alchSpawning && objects.hasPreview();
    if (fromPreview) { delete p.type; delete p.color; delete p.colorIdx; delete p.rare; }
    const id = objects.spawn(p);
    // 🎲 'never the same shape twice' must remember the shape that was really made (R2-21)
    const g = fromPreview && id != null ? objects.get(id) : null;
    if (g && inter?.styler) inter.styler.lastType = g.type;
    return id;
  },
};

// ───────────────────────────────────────────────────────────── hand pipeline
const handTracker = new HandTracker(CONFIG.core);
const alchemy = new Alchemy(CONFIG.core);
var inter = new Interaction({
  scene: sceneApi, cfg: CONFIG.core, W: view.sw, H: view.sh,
  uiHit: (x, y) => hud.hitTest(x, y), shapes: CONFIG.render.shapes, colors: CONFIG.render.colors,
});
let mapping = null;
let alchSpawning = false;
const latest = { hands: [], out: null, alch: null, at: 0 };
let prevPhase = 'idle', hadPreview = false, lastDwellId = null;
let lastHandsAt = 0, everHands = false, attract = false;
let mode = 'idle';      // 'idle' (start screen) | 'camera' | 'touch'
let linkMode = 'ar';
let cam = null;         // camera tracker (createTracker)
let mirror = true;
let frozenTimeout = null;

function effectiveMirror() { return (cam ? cam.facing : settings.facing) === 'user' ? !!settings.mirror : false; }

function getMapping(vw, vh) {
  const m = mapping;
  if (m && m.vw === vw && m.vh === vh && m.mirror === mirror && m.W === view.sw && m.H === view.sh && m.left === view.left && m.top === view.top) return m;
  mapping = makeMapping({ vw, vh, W: view.sw, H: view.sh, mirror, left: view.left, top: view.top });
  return mapping;
}

/** One detection result through the whole pipeline. raw = RawHand[] (tracker or injected). */
function processHands(raw, vw, vh, tNow) {
  const map = getMapping(vw || view.sw, vh || view.sh);
  // a hand whose palm centre is outside the visible stage (縦 9:16 crop, cover crop) is not tracked: no cursor
  // or UI hit in the black pillars, not counted in the HUD
  raw = (raw || []).filter(h => {
    const lm = toPoints(h.lm);
    if (!lm || lm.length < 21) return true;
    const pc = palmCenter(lm), p = map.toScreen(pc.x, pc.y);
    return p.x >= view.left && p.x <= view.left + view.sw && p.y >= view.top && p.y <= view.top + view.sh;
  });
  const hands = handTracker.update(raw, map, tNow);
  const live = hands.filter(h => !h.lost);
  metrics.results++;
  if (live.length) { metrics.handFrames++; metrics.maxHands = Math.max(metrics.maxHands, live.length); }

  let alch = null, out;
  if (linkMode === 'iphone') {
    out = inter.update(hands, null, tNow);
    link?.update(hands, view.sw, view.sh, tNow, view.left, view.top);   // stage rect (縦 frame), R1-21
  } else {
    alch = alchemy.update(hands, tNow, inter.alchemyCtx());
    alchSpawning = !!(alch.event && alch.event.type === 'spawn');
    out = inter.update(hands, alch, tNow);
    alchSpawning = false;
    // an alchemy spawn takes the preview's shape/colour/rare: report what was really made (R2-21)
    for (const it of out.intents) {
      if (it.type !== 'spawn' || it.id == null) continue;
      const g = objects.get(it.id); if (!g) continue;
      it.shape = g.type; it.color = g.color;
      if (!!it.rare !== !!g.rare) {
        it.rare = !!g.rare;
        out.events = g.rare ? [...out.events, 'rare'] : out.events.filter(e => e !== 'rare');
      }
    }
  }
  latest.hands = hands; latest.out = out; latest.alch = alch; latest.at = now();   // wall time of processing (tNow = frame time)
  applyOutput(out, alch, live, tNow);
  return out;
}

function applyOutput(out, alch, live, tNow) {
  // --- intents → audio / HUD
  let dwell = null;
  for (const it of out.intents) {
    switch (it.type) {
      case 'select': audio.play('select'); break;
      case 'deselect': audio.play('deselect'); break;
      case 'grab': audio.play('grab'); break;
      case 'release': audio.play('release'); markDirty(); break;
      case 'rotateEnd': case 'squeezeEnd': markDirty(); break;
      case 'delete': markDirty(); break;
      case 'uiDwell': if (!dwell || it.progress > dwell.progress) dwell = it; break;
      case 'uiClick': if (hud.activate(it.id)) audio.play('confirm'); break;
      default: break;
    }
  }
  if (dwell && dwell.id !== lastDwellId) audio.play('dwell');
  lastDwellId = dwell ? dwell.id : null;
  hud.setDwell(dwell ? dwell.id : null, dwell ? dwell.progress : 0);

  // --- tutorial
  for (const ev of out.events) tutorial.onEvent(ev);
  if (out.events.includes('alchemySpawn')) metrics.alchemySpawns++;

  // --- alchemy visuals + sound
  const phase = alch ? alch.phase : 'idle';
  if (alch) {
    const loc = p => p ? { x: p.x - view.left, y: p.y - view.top } : undefined;
    fx.setAlchemy(alch.mid ? { phase, mid: loc(alch.mid), dist: alch.dist, progress: alch.progress, pa: loc(alch.posA), pb: loc(alch.posB), event: alch.event } : null);
    if (phase === 'growing' && alch.mid) {
      objects.setPreview({ sx: alch.mid.x - view.left, sy: alch.mid.y - view.top, sizePx: alch.dist * CONFIG.core.alchemy.sizeFactor, progress: alch.progress });
      hadPreview = true;
    } else if (hadPreview) { objects.setPreview(null); hadPreview = false; }
    if (phase === 'armed' && prevPhase !== 'armed' && prevPhase !== 'growing') audio.play('arm');
    if (phase === 'growing') audio.hum(alch.progress); else if (prevPhase === 'growing' || prevPhase === 'armed') audio.hum(null);
    if (alch.event && alch.event.type === 'cancel' && prevPhase === 'growing') audio.play('cancel');
  } else if (prevPhase !== 'idle' || hadPreview) {
    fx.setAlchemy(null); objects.setPreview(null); hadPreview = false; audio.hum(null);
  }
  prevPhase = phase;

  // --- HUD status
  if (live.length) {
    if (!everHands) { everHands = true; metrics.firstHandsAt = tNow; stage.startAutoQuality(); }
    lastHandsAt = tNow;
    hud.setTracking('tracking', live.length);
    hud.setPose(live[0].pose);
    hud.setHandScale(live[0].palmPx);
    if (attract) leaveAttract();
  } else if (mode === 'camera' && !latest.hands.length) {   // (hands in their 300 ms grace keep the last status)
    hud.setTracking(everHands && tNow - lastHandsAt < 3000 ? 'lost' : 'scanning', 0);
    hud.setPose(null);
  }
  hud.setHint(out.hint ? (out.hintKey ? t('hint.' + out.hintKey) : out.hint) : null);
  hud.setSelected(objects.getSelected() != null);
}

// ───────────────────────────────────────────────────────────── scene events
let lastCount = 0;
const spawnLog = [];
function onSceneEvent(name, data) {
  if (name === 'spawn') {
    metrics.spawns++;
    spawnLog.push({ t: Math.round(now()), type: data?.type, color: data?.color, rare: !!data?.rare, dup: !!data?.duplicate });
    if (spawnLog.length > 30) spawnLog.shift();
    if (!data?.rare) audio.play('spawn');
    markDirty();
  } else if (name === 'rare') {
    metrics.rare++;
    audio.play('rare');
    hud.toast(t('m.rare'), 1000);
  } else if (name === 'remove') {
    audio.play('delete');
    markDirty();
  } else if (name === 'clear' || name === 'undo') markDirty();
}

let dirty = false;
function markDirty() { dirty = true; invalidateUSDZ(); }
function autosave() {
  if (!dirty) return;
  dirty = false;
  if (!KIOSK) storage.saveSceneSoon(() => objects.serialize());
}

// ───────────────────────────────────────────────────────────── link (スマホ連携)
let link = null;
try {
  link = createLink();
  link.info.then(info => {
    if (!info || KIOSK) return;
    hud.showLink(info);
    link.mountPanel(hud.getLinkSlot());
    link.mountPhone(phoneSlot());
    link.onStatus(s => hud.setLinkState({ connected: s.phone, lanOn: s.lanOn, mode: s.mode }));   // オフ / まってる… / つながった
  }).catch(() => {});
} catch (e) { console.warn('[link]', e?.message || e); link = null; }

// The virtual phone sits beside the toolbar (link.js' own float would cover the right-hand toolbar).
let phoneEl = null;
function phoneSlot() {
  if (!phoneEl) {
    phoneEl = document.createElement('div');
    phoneEl.id = 'phone-slot';
    phoneEl.style.cssText = 'position:fixed;top:50%;transform:translateY(-50%);z-index:9;';   // under the HUD (10): panels stay clickable
    document.body.appendChild(phoneEl);
    addEventListener('resize', placePhone);
  }
  placePhone();
  return phoneEl;
}
let phoneTbX = null, phoneCheckAt = 0;
/** The toolbar can still move after the phone was placed (hand-size inset, 0.3 s transition): follow it. */
function followToolbar(tNow) {
  if (!phoneEl || phoneEl.hidden || linkMode !== 'iphone' || tNow < phoneCheckAt) return;
  phoneCheckAt = tNow + 250;
  const r = $('hud-toolbar')?.querySelector('.tb-items')?.getBoundingClientRect();
  if (r && phoneTbX !== Math.round(r.left)) placePhone();
}
function placePhone() {
  if (!phoneEl) return;
  const tb = $('hud-toolbar')?.querySelector('.tb-items')?.getBoundingClientRect();
  if (tb) phoneTbX = Math.round(tb.left);
  const left = settings.toolbarSide === 'left';
  phoneEl.style.left = left && tb ? Math.round(tb.right + 12) + 'px' : '';
  phoneEl.style.right = !left && tb ? Math.round(innerWidth - tb.left + 12) + 'px' : (left ? '' : '24px');
  link?.dockPanel?.();   // keep the スマホ連携 panel off the phone after a side switch (R1-11)
}

function setLinkMode(m) {
  placePhone();
  linkMode = m === 'iphone' ? 'iphone' : 'ar';
  link?.setMode(linkMode);
  inter.setEnabled(linkMode !== 'iphone');
  alchemy.reset();
  fx.setAlchemy(null); objects.setPreview(null); audio.hum(null); hadPreview = false; prevPhase = 'idle';
}

// one camErr toast even when a failed switch also reports a lost camera (R2-12-note)
let camErrAt = -1e9;
function camErrToast() { const n = performance.now(); if (n - camErrAt > 3000) { camErrAt = n; hud.toast(t('m.camErr'), 2500); } }

// ───────────────────────────────────────────────────────────── capture
const capture = createCapture({
  stage, audio, hud,
  overlay: { captureCanvas: bonesCanvas, canvas: bonesCanvas },
  showBones: () => !!settings.bones,
  // skeletons drawn straight into the output at its resolution (縦: not a stretched 405×720 layer, R2-11)
  drawBones: (ctx, s, off) => { if (latest.hands.length) drawSkeletons(ctx, latest.hands, s, off); },
  getOrientation: () => view.orientation || settings.orientation,   // 横 while a phone is held sideways
  persist: !KIOSK,
});
const trayHud = it => ({ id: it.id, kind: it.kind, url: it.url, thumb: it.thumbUrl, sec: it.durationMs ? it.durationMs / 1000 : 0 });
capture.tray.onChange(ev => {
  if (ev.type === 'add' && ev.item) {
    hud.addTrayItem(trayHud(ev.item));
    // the upload Promise stays on the item: a tray delete also removes the server copy (R1-14)
    if (link?.available) { ev.item.serverClip = link.uploadClip(ev.item.blob, ev.item.name); ev.item.serverClip.catch?.(() => {}); }
  } else if (ev.type === 'remove' && ev.item) hud.removeTrayItem(ev.item.id);
  else if (ev.type === 'clear') hud.clearTray();
  else if (ev.type === 'load') { hud.clearTray(); ev.items.slice().reverse().forEach(it => hud.addTrayItem(trayHud(it))); }
});
capture.tray.load();
function drawBonesLayer() {
  const od = overlay.dpr || view.dpr;
  bonesCtx.setTransform(1, 0, 0, 1, 0, 0);
  bonesCtx.clearRect(0, 0, bonesCanvas.width, bonesCanvas.height);
  if (settings.bones && latest.hands.length) drawSkeletons(bonesCtx, latest.hands, od, { x: -view.left * od, y: -view.top * od });
}

// ───────────────────────────────────────────────────────────── iOS AR Quick Look (「部屋に置く」)
// The USDZ is rebuilt whenever the scene changes (markDirty), so 部屋に置く never opens an older scene or
// deleted objects; while the export runs it says じゅんび中 (R1-25).
var usdzUrl = null, usdzPreparing = null, usdzGen = 0, usdzTimer = 0;
function invalidateUSDZ() {
  if (!settings_ios()) return;
  usdzGen++;
  if (usdzUrl) { URL.revokeObjectURL(usdzUrl); usdzUrl = null; }
  if (hud?.openPanel === 'menu') { clearTimeout(usdzTimer); usdzTimer = setTimeout(prepareUSDZ, 300); }
}
function prepareUSDZ() {
  if (!settings_ios() || usdzPreparing || usdzUrl || !objects.count()) return;
  const gen = usdzGen;
  usdzPreparing = objects.exportUSDZ().then(blob => {
    if (gen === usdzGen && blob) usdzUrl = URL.createObjectURL(blob);   // stale (scene changed meanwhile) → drop
  }).catch(e => console.warn('[ar]', e?.message || e)).finally(() => {
    usdzPreparing = null;
    if (gen !== usdzGen && hud.openPanel === 'menu') prepareUSDZ();
  });
}
var IOS_AR = null;
function settings_ios() { if (IOS_AR == null) IOS_AR = !!isARQuickLookSupported(); return IOS_AR; }
function openAR() {   // synchronous, inside the real tap
  if (!usdzUrl) { hud.toast(t('m.arPrep')); prepareUSDZ(); return; }
  const a = document.createElement('a');
  a.rel = 'ar'; a.href = usdzUrl; a.appendChild(document.createElement('img')); a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
}

// ───────────────────────────────────────────────────────────── HUD actions
function applyStyleToAll() {
  const s = settings.style;
  inter.setStyle({ type: s.type || 'random', colorIdx: s.colorIdx ?? -1, opacity: s.opacity });
}
function spawnAtCenter(type) {
  const ph = latest.alch?.phase;
  if (ph === 'armed' || ph === 'growing') return null;   // "nothing pending"
  return inter.spawnShape({ type: type && type !== 'random' ? type : undefined, sx: view.left + view.sw / 2, sy: view.top + view.sh / 2, sizePx: Math.min(view.sw, view.sh) * 0.3 });
}

function onAction(name, p) {
  switch (name) {
    case 'shape':
      settings.style.type = p; applyStyleToAll(); objects.setStyle({ type: p });
      spawnAtCenter(p); saveSettings(); break;
    case 'color':
      settings.style.colorIdx = p; applyStyleToAll(); objects.setStyle({ colorIdx: p }); markDirty(); saveSettings(); break;
    case 'opacity':
      settings.style.opacity = p; applyStyleToAll(); objects.setStyle({ opacity: p }); markDirty(); saveSettings(); break;
    case 'undo':
      endWheel();   // a wheel resize still open becomes its own step first
      if (objects.undo()) { audio.play('deselect'); hud.toast(t('m.undo'), 900); markDirty(); }
      else hud.toast(t('m.noUndo'), 900);
      break;
    case 'photo':   // 📷 again during its own 3-2-1 cancels it (R1-37)
      if (capture.recording) break;
      if (capture.countdownKind === 'photo') { capture.cancel('photo'); break; }
      if (capture.busy) break;
      capture.photo({ countdown: true }).catch(e => console.warn('[photo]', e));
      break;
    case 'record':
      capture.toggleRecord({ countdown: true, seconds: settings.recordSec }).catch?.(e => console.warn('[rec]', e));
      break;
    case 'settings':
      if (p) prepareUSDZ();
      break;
    case 'duplicate': {
      const sel = objects.getSelected();
      if (sel == null) { hud.toast(t('m.pickFirst')); break; }
      const id = objects.duplicate(sel); if (id != null) { objects.select(id); markDirty(); }
      break;
    }
    case 'clear':
      if (!objects.count()) { hud.toast(t('m.empty')); break; }
      inter.setEnabled(false); inter.setEnabled(linkMode !== 'iphone');
      objects.clear(); hud.toast(t('m.cleared')); markDirty();
      break;
    case 'export':
      if (!objects.count()) { hud.toast(t('m.empty')); break; }
      objects.exportGLB().then(blob => { downloadBlob(blob, captureFileName('glb')); hud.toast(t('m.export')); })
        .catch(e => console.warn('[export]', e));
      break;
    case 'arQuickLook': openAR(); break;
    case 'bones': settings.bones = !!p; CONFIG.ui.showBones = settings.bones; saveSettings(); break;
    case 'depth': settings.depth = !!p; CONFIG.core.depth.enabled = settings.depth; saveSettings(); break;
    case 'mirror': settings.mirror = !!p; applyMirror(); saveSettings(); break;
    case 'quality': settings.quality = p; stage.setQuality(p); saveSettings(); break;
    case 'clarity': settings.clarity = !!p; stage.setClarity?.(settings.clarity); saveSettings(); break;   // くっきり (camera image)
    case 'sound': settings.sound = !!p; audio.setMuted(!settings.sound); saveSettings(); break;
    case 'orientation':
      settings.orientation = p; layoutStage(); saveSettings();
      cam?.setPortrait(p === 'portrait').then(() => applyMirror()).catch(e => console.warn('[cam]', e));
      break;
    case 'recordSec': settings.recordSec = p; saveSettings(); break;
    case 'camera':
      settings.facing = p; saveSettings();
      // touch mode: only remember the side — never turn a camera on without hand tracking (R2-34)
      if (cam && mode === 'camera') { hud.toast(t('m.camSwitch'), 900); cam.switchCamera(p).then(() => applyMirror()).catch(e => { console.warn('[cam]', e); camErrToast(); }); }
      else cam?.switchCamera(p).catch(() => {});
      break;
    case 'side': settings.toolbarSide = p; saveSettings(); requestAnimationFrame(placePhone); break;
    case 'tutorial': startTutorial(); break;
    case 'linkMode': setLinkMode(p); break;
    case 'trayOpen': break;
    case 'traySave': capture.save(p); break;          // synchronous inside the real click
    case 'trayShare': capture.share(p); break;
    case 'trayDelete': {   // the user deleted it → the phone gallery drops it too (R1-14)
      const it = capture.tray.get(p);
      capture.tray.remove(p);
      if (it?.serverClip) link?.deleteClip(it.serverClip);
      break;
    }
    case 'trayEvict': capture.tray.remove(p); break;   // only pushed out of the tray: the server keeps it (max 20)
    default: break;
  }
}

function applyMirror() {
  const m = effectiveMirror();
  if (m === mirror) return;
  mirror = m;
  stage.setMirror(mirror);
  mapping = null;
  handTracker.reset(); alchemy.reset();
  inter.setEnabled(false); inter.setEnabled(linkMode !== 'iphone');
}

// ───────────────────────────────────────────────────────────── touch / mouse fallback (SPEC §7, §13.4)
const ptrs = new Map();
let drag = null;      // {id, offX, offY, moved, pid, t0, sx, sy}
let pinch2 = null;    // {id, d0, a0, dApplied, aApplied}
const TAP_PX = 10, LONG_MS = 650;
function ptrTargetOk(e) {
  const tg = e.target;
  if (!(tg === glCanvas || tg === document.body || tg === document.documentElement || tg === ovCanvas)) return false;
  // 縦: the black bars around the 9:16 frame are bare body — a tap there must not spawn off-frame (R2-17/R2-25)
  return insideStage(e.clientX, e.clientY);
}
const insideStage = (x, y) => x >= view.left && x <= view.left + view.sw && y >= view.top && y <= view.top + view.sh;
function startPinch() {
  const sel = objects.getSelected();
  const ps = [...ptrs.values()];
  if (sel == null || ps.length < 2) return;
  endDrag(false);
  const [a, b] = ps;
  const d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
  objects.beginTransform(sel);
  pinch2 = { id: sel, dApplied: Math.max(10, d), aApplied: ang };
}
function endDrag(asTap) {
  if (!drag) return;
  if (drag.id != null) { objects.endTransform(drag.id); audio.play('release'); markDirty(); }
  else if (asTap && !drag.moved && now() - drag.t0 < 600 && !panelOpenAtDown) {
    if (objects.getSelected() != null) { objects.select(null); audio.play('deselect'); }
    else {
      const ph = latest.alch?.phase;
      if (ph !== 'armed' && ph !== 'growing') inter.spawnShape({ sx: drag.sx, sy: drag.sy, sizePx: Math.min(view.sw, view.sh) * 0.28 });
    }
  }
  drag = null;
}
glCanvas.style.touchAction = 'none';
document.addEventListener('pointerdown', e => {
  if (mode === 'idle' || !ptrTargetOk(e)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size >= 2) { startPinch(); return; }
  const slop = e.pointerType === 'touch' ? 28 : 12;
  const id = sceneApi.pick(e.clientX, e.clientY, slop);
  drag = { id, pid: e.pointerId, t0: now(), sx: e.clientX, sy: e.clientY, moved: false, offX: 0, offY: 0, touch: e.pointerType !== 'mouse' };
  if (id != null) {
    const info = sceneApi.getScreenInfo(id);
    drag.offX = info.x - e.clientX; drag.offY = info.y - e.clientY;
    if (objects.getSelected() !== id) { objects.select(id); audio.play('select'); if (mode === 'camera') tutorial.onEvent('select'); }
    objects.beginTransform(id);
  }
});
/** Long-press = delete (touch fallback). Checked in the render loop (after rAF-aligned pointermoves were
 *  dispatched), not with a timer: on a busy main thread a timer could fire before queued moves arrive. */
function checkLongPress(tNow) {
  if (!drag || !drag.touch || drag.id == null || drag.moved || ptrs.size !== 1 || tNow - drag.t0 < LONG_MS) return;
  const id = drag.id;
  objects.endTransform(id); objects.remove(id); drag.id = null; drag.moved = true;
}
document.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId); if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  if (pinch2 && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y)), ang = Math.atan2(b.y - a.y, b.x - a.x);
    const f = d / pinch2.dApplied;
    if (Math.abs(Math.log(f)) > 0.01) { objects.scaleBy(pinch2.id, f); pinch2.dApplied = d; }
    let da = ang - pinch2.aApplied; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    if (Math.abs(da) > 0.01) { objects.rotateBy(pinch2.id, 0, 0, -da); pinch2.aApplied = ang; }
    return;
  }
  if (!drag || drag.pid !== e.pointerId) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > TAP_PX) drag.moved = true;
  if (drag.id != null && drag.moved) sceneApi.setGrabPose(drag.id, e.clientX + drag.offX, e.clientY + drag.offY);
});
const ptrUp = e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (pinch2) { if (ptrs.size < 2) { objects.endTransform(pinch2.id); pinch2 = null; markDirty(); } return; }
  if (drag && drag.pid === e.pointerId) endDrag(e.type === 'pointerup');
};
document.addEventListener('pointerup', ptrUp);
document.addEventListener('pointercancel', ptrUp);
// One wheel / trackpad-pinch gesture = one undo step: the transform stays open until 300 ms without wheel
// events, a pointerdown or a selection change (R1-24).
let wheelTf = null;   // {id, timer}
function endWheel() {
  if (!wheelTf) return;
  clearTimeout(wheelTf.timer);
  objects.endTransform(wheelTf.id); wheelTf = null; markDirty();
}
glCanvas.addEventListener('wheel', e => {
  const sel = objects.getSelected();
  if (wheelTf && wheelTf.id !== sel) endWheel();
  if (sel == null) return;
  e.preventDefault();
  if (!wheelTf) { objects.beginTransform(sel); wheelTf = { id: sel, timer: 0 }; }
  objects.scaleBy(sel, Math.exp(-e.deltaY * 0.0015));
  clearTimeout(wheelTf.timer); wheelTf.timer = setTimeout(endWheel, 300);
}, { passive: false });
document.addEventListener('pointerdown', endWheel, true);

// keyboard (desktop): Delete/Backspace = けす, Ctrl/Cmd+Z = もどす, Esc = えらばない
addEventListener('keydown', e => {
  if (mode === 'idle' || e.target?.closest?.('input, textarea, [contenteditable]')) return;
  const sel = objects.getSelected();
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel != null && !KIOSK) { e.preventDefault(); sceneApi.remove(sel); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); onAction('undo'); }
  else if (e.key === 'Escape' && sel != null) { objects.select(null); audio.play('deselect'); }
});

// ───────────────────────────────────────────────────────────── kiosk attract
function enterAttract() {
  attract = true;
  tutorial.stop();
  resetScene();
  for (const it of capture.tray.items()) if (it.serverClip) link?.deleteClip(it.serverClip);
  capture.tray.clear(); hud.clearTray();
  hud.setAttract(true);
}
/** Kiosk reset for the next visitor: empty scene AND empty undo history, so もどす cannot bring back the
 *  previous visitor's work (R1-26). The objects API has no history reset, so the history is replayed to
 *  empty (no sound, nothing is rendered in between) and the result removed without an undo entry. */
function resetScene() {
  endWheel();
  for (let i = 0; i < 500 && objects.canUndo(); i++) objects.undo();
  objects.deserialize([], { undoable: false });
  objects.select(null);
}
function leaveAttract() {
  attract = false;
  hud.setAttract(false);
  startTutorial();
}
/** Start the tutorial; step 1 (てを かざしてね) is already done when a hand is in view. */
function startTutorial() {
  // step 2 「ゆびで さしてね」 waits for a 'select': start with nothing selected, or pointing at the cube does nothing (R2-19)
  if (objects.getSelected() != null) objects.select(null);
  tutorial.start();
  if (latest.hands.some(h => !h.lost) && now() - latest.at < 500) setTimeout(() => tutorial.onEvent('hands'), 400);
}

// ───────────────────────────────────────────────────────────── 「あかるい ばしょで」
const lumaCv = document.createElement('canvas'); lumaCv.width = 32; lumaCv.height = 18;
const lumaCtx = lumaCv.getContext('2d', { willReadFrequently: true });
let lumaCheckAt = 0;
function checkBrightness(tNow) {
  if (mode !== 'camera' || tNow < lumaCheckAt) return;
  lumaCheckAt = tNow + 1000;
  if (tNow - metrics.launchedAt < 5000 || tNow - Math.max(lastHandsAt, metrics.launchedAt) < 5000) return;
  if (!(video.readyState >= 2)) return;
  try {
    lumaCtx.drawImage(video, 0, 0, 32, 18);
    const d = lumaCtx.getImageData(0, 0, 32, 18).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    if (s / (d.length / 4) < 60) { hud.hint(t('hint.bright'), 4000); lumaCheckAt = tNow + 10000; }
  } catch { /* tainted / not ready */ }
}

// ───────────────────────────────────────────────────────────── render loop
// Rendering is capped (default 60 fps, ?maxfps=N, 0 = uncapped): on 120/144 Hz screens (and uncapped headless)
// an uncapped renderer starves the detection worker of GPU/CPU (measured 2–8 results/s → 12–18/s with the cap).
const MAX_FPS = Q.has('maxfps') ? Math.max(0, +Q.get('maxfps') || 0) : 60;
const MIN_FRAME_MS = MAX_FPS > 0 ? 1000 / MAX_FPS : 0;
let lastFrameT = now(), lastRafT = 0, rafIv = 16.7;
function frame() {
  requestAnimationFrame(frame);
  const tNow = now();
  if (lastRafT) rafIv = rafIv * 0.9 + Math.min(100, tNow - lastRafT) * 0.1;
  lastRafT = tNow;
  // skip this vsync when rendering it would exceed MAX_FPS (half a vsync of slack keeps 60 Hz screens at 60)
  if (MIN_FRAME_MS && tNow - lastFrameT < MIN_FRAME_MS - rafIv / 2) return;
  try {
    {
      const dt = Math.min(0.1, Math.max(0, (tNow - lastFrameT) / 1000));
      lastFrameT = tNow;
      objects.update(dt, tNow);
      fx.update(dt);
      if (capture.busy || capture.recording) drawBonesLayer();
      stage.render(dt);
      metrics.renders++;
      // overlay in lockstep with the GL frame (same detection) — stale hands (> 0.5 s) are not drawn
      const out = latest.out, fresh = tNow - latest.at < 500;
      overlay.draw({ hands: fresh ? latest.hands : [], cursors: fresh && out ? out.cursors : [], alchemy: fresh ? latest.alch : null, showBones: !!settings.bones, nowMs: tNow });
    }
    const n = objects.count();
    hud.setCount(n);
    if (n !== lastCount) { tutorial.onEvent('count', n); lastCount = n; }
    hud.setCanUndo(objects.canUndo());
    if (mode === 'touch') hud.setSelected(objects.getSelected() != null);
    autosave();
    checkLongPress(tNow);
    checkBrightness(tNow);
    followToolbar(tNow);
    if (KIOSK && mode === 'camera' && !attract && tNow - Math.max(lastHandsAt, metrics.launchedAt) > CONFIG.ui.kioskIdleMs) enterAttract();
  } catch (e) {
    console.error('[frame]', e);
  }
}

// ───────────────────────────────────────────────────────────── boot
layoutStage();
stage.setMirror(mirror);
stage.setQuality(settings.quality || 'auto');
stage.setClarity?.(settings.clarity !== false);   // くっきり: on unless turned off
stage.onQualityChange((eff, q, info) => { if (info?.dropped) { metrics.dropped++; hud.toast(t('m.quality'), 1500); } });
audio.setMuted(!settings.sound);
hud.setSettings({
  bones: !!settings.bones, depth: !!settings.depth, mirror: !!settings.mirror, quality: settings.quality || 'auto', sound: !!settings.sound,
  orientation: settings.orientation || 'landscape', facing: settings.facing || 'user', side: settings.toolbarSide || 'right',
  recordSec: settings.recordSec || 15, ios: isARQuickLookSupported(), kiosk: KIOSK, canExport: !KIOSK,
  clarity: settings.clarity !== false,
});
hud.setStyle(settings.style);
applyStyleToAll();
objects.setStyle({ type: settings.style.type, colorIdx: settings.style.colorIdx, opacity: settings.style.opacity });
hud.setTracking('loading', 0);
mirror = effectiveMirror(); stage.setMirror(mirror);

// restore the last scene (not in kiosk)
let restoredN = 0;
function toastRestored() {
  if (!restoredN) return;
  restoredN = 0;
  setTimeout(() => hud.toast(t('m.restored'), 1800), 500);   // after the 0.4 s start-screen fade
}
if (!KIOSK) {
  const data = storage.loadScene();
  if (data && Array.isArray(data.objects) && data.objects.length) {
    const n = objects.deserialize(data, { undoable: true });
    restoredN = n;   // toast once the start screen is gone (it covers the HUD), R1-30
  }
}
requestAnimationFrame(frame);

// tracker preload during the start screen (progress bar), SPEC §13.6.
// Restartable (R2-1): a failed download shows よみこみに 失敗しました at once, and もう一度 downloads again.
let startUi = null, trackerFailed = false, trackerGen = 0;
function loadTracker() {
  trackerFailed = false;
  const gen = ++trackerGen;
  const p = createTracker({
    video, mobile: isMobileDevice(), facing: settings.facing || 'user',
    worker: Q.get('worker') !== '0',      // ?worker=0 → main-thread detection (fallback path, tests)
    onProgress: (b, total) => { if (gen === trackerGen) startUi?.setProgress(total ? b / total : 0); },
  }).then(tr => {
    cam = tr; startUi?.setProgress(1);
    tr.on('error', ev => { if (ev?.fatal && mode === 'camera') camErrToast(); });   // lost camera (R2-12)
    return tr;
  });
  p.catch(e => {
    console.warn('[tracker] load failed', e?.message || e);
    if (gen !== trackerGen) return;
    trackerFailed = true;
    // no tap needed to see it; an error already on the card (e.g. in-app browser) is kept
    if (mode === 'idle' && !startRoot.hidden && startRoot.querySelector('#st-err')?.hidden !== false) startUi?.showError('model');
  });
  return p;
}
let trackerP = loadTracker();

async function launchCamera() {
  audio.unlock();                       // inside the real tap
  if (trackerFailed) { startUi?.setProgress(0); trackerP = loadTracker(); }   // もう一度 = a fresh download
  let tr;
  try { tr = await trackerP; }
  catch (e) { throw Object.assign(new Error('model'), { name: 'model' }); }
  await tr.startCamera({ facing: settings.facing || 'user', portrait: settings.orientation === 'portrait' });
  mirror = -1; applyMirror();
  tr.start(onResult);
  mode = 'camera';
  metrics.launchedAt = now();
  hud.setTracking('scanning', 0);
  if (KIOSK || tutorial.shouldAutoStart()) startTutorial();
  toastRestored();
  return true;
}
function onResult(r) {
  // 'sync': background = the detected frame (skeleton aligned); 'live': smooth live video (slow detection)
  if (r.frame) stage.setFrame(r.frame);
  else if (r.frameMode === 'live') stage.setFrame(null);
  processHands(r.hands, r.vw, r.vh, r.nowMs ?? now());
  if (freezePending && r.frame) { freezePending = false; cam?.stop(); }
}
let freezePending = false;
function launchTouch() {
  audio.unlock();
  mode = 'touch';
  metrics.launchedAt = now();
  hud.setTracking('touch', 0);
  hud.toast(t('st.touch'), 1500);
  if (restoredN) setTimeout(toastRestored, 1100);
}

startUi = showStart({ root: startRoot, onLaunch: launchCamera, onNoCamera: launchTouch, kiosk: KIOSK });
if (cam) startUi.setProgress(1);
// camera already allowed → skip the start screen (SPEC §13.8). The query also runs in kiosk mode (no
// auto-launch there): in headless Chrome a getUserMedia that was NOT preceded by a permission query made
// MediaPipe crawl (first detection ≈ 90 s); every tested-good path has the query first.
if (navigator.permissions?.query) {
  navigator.permissions.query({ name: 'camera' }).then(p => {
    if (!KIOSK && p.state === 'granted' && mode === 'idle' && !startRoot.hidden) startUi.launch();
  }).catch(() => {});
}

// ───────────────────────────────────────────────────────────── debug hook (dev + tests), SPEC §12
window.__hs = {
  version: VERSION,
  state() {
    const live = latest.hands.filter(h => !h.lost);
    return {
      mode, linkMode, kiosk: KIOSK, attract,
      view: { ...view }, mirror, pipeline: stage.pipeline, quality: stage.getQuality(), effectiveQuality: stage.getEffectiveQuality(),
      hands: live.map(h => ({ id: h.id, pose: h.pose, palmPx: +h.palmPx.toFixed(1), x: +h.palmCenter.x.toFixed(1), y: +h.palmCenter.y.toFixed(1), pinch: h.pinch })),
      alchemy: latest.alch ? latest.alch.phase : 'idle',
      selected: objects.getSelected(), count: objects.count(),
      objects: objects.list().map(id => { const g = objects.get(id); const s = sceneApi.getScreenInfo(id); return { id, type: g.type, color: g.color, scale: +g.scale.toFixed(3), x: s && +s.x.toFixed(1), y: s && +s.y.toFixed(1), r: s && +s.r.toFixed(1) }; }),
      cursors: latest.out ? latest.out.cursors.map(c => ({ id: c.id, kind: c.kind, x: Math.round(c.x), y: Math.round(c.y) })) : [],
      tray: capture.tray.items().map(i => ({ id: i.id, kind: i.kind, w: i.w, h: i.h, size: i.size })),
      tutorial: { active: tutorial.active, step: tutorial.step },
      settings: JSON.parse(JSON.stringify(settings)),
    };
  },
  metrics() {
    const tm = cam ? cam.metrics() : {};
    return {
      fps: +stage.fps().toFixed(1), detectMs: tm.detectMs ?? 0, detectFps: tm.detectFps ?? 0,
      hands: latest.hands.filter(h => !h.lost).length, spawns: metrics.spawns, objects: objects.count(),
      backend: tm.backend, delegate: tm.delegate, numHands: tm.numHands, frames: tm.frames ?? 0, handsPerFrame: tm.handsPerFrame ?? 0,
      results: metrics.results, handFrames: metrics.handFrames, maxHands: metrics.maxHands, alchemySpawns: metrics.alchemySpawns, rare: metrics.rare,
      renders: metrics.renders, qualityDrops: metrics.dropped, trackerErrors: tm.errors ?? 0, rebuilds: tm.rebuilds ?? 0, loadMs: tm.loadMs,
      vw: tm.vw, vh: tm.vh, camera: tm.camera ?? null, detectW: tm.detectW ?? 0, prepMs: tm.prepMs ?? 0, frameMode: tm.frameMode, spawnLog: spawnLog.slice(),
      worker: tm.worker, workerFallback: tm.workerFallback, frameSource: tm.frameSource, modeSwitches: tm.modeSwitches,
      resultRate: tm.resultRate, videoFps: tm.videoFps, latencyMs: tm.latencyMs, gpuCheck: tm.gpuCheck,
      presentRate: tm.presentRate, displayDelayMs: tm.displayDelayMs, heldPresentations: tm.heldPresentations, skeletonLagMs: tm.skeletonLagMs,
      lastMediaTime: tm.lastMediaTime, lastFrameHash: tm.lastFrameHash, framesSent: tm.framesSent, framesWorkerClosed: tm.framesWorkerClosed, framesInFlight: tm.framesInFlight,
      displayMade: tm.displayMade, displayOpen: tm.displayOpen, ringOpen: tm.ringOpen, ringMax: tm.ringMax, maxFps: MAX_FPS, rafHz: Math.round(1000 / rafIv),
      tracker: { ...handTracker.stats, dupEvents: undefined },
      alch: { ...alchemy.stats },
      interaction: { grabs: inter.stats.grabs, selects: inter.stats.selects, deselects: inter.stats.deselects, deletes: inter.stats.deletes, rotates: inter.stats.rotates, spins: inter.stats.spins, uiClicks: inter.stats.uiClicks },
    };
  },
  spawnTest(type = 'box', opts = {}) {
    return objects.spawn({ type, sx: opts.sx ?? view.sw / 2, sy: opts.sy ?? view.sh / 2, sizePx: opts.sizePx ?? Math.min(view.sw, view.sh) * 0.3, rare: opts.rare ?? false, color: opts.color });
  },
  /** Feed raw hands as if detected (tests). vw/vh default to the current video or the stage. */
  inject(rawHands, { vw, vh, t: tt } = {}) {
    const W = vw || video.videoWidth || view.sw, H = vh || video.videoHeight || view.sh;
    const o = processHands(rawHands || [], W, H, tt ?? now());
    return { intents: o.intents.map(i => i.type), events: o.events, cursors: o.cursors.length };
  },
  action: (name, payload) => onAction(name, payload),
  /** Tests: stop detection and keep the last detected frame on screen (overlay alignment check).
   *  mode 'sync' (default): frame-sync is forced first; the stop happens on the next result that carries its frame.
   *  mode 'delayed': the delayed (buffered + interpolated) mode is forced and kept — measures what users see. */
  freeze(fmode = 'sync') {
    if (frozenTimeout == null) { frozenTimeout = CONFIG.render.frameTimeoutMs; CONFIG.render.frameTimeoutMs = 1e9; }
    if (!cam) return;
    cam.setFrameSync?.(fmode);
    if (cam.worker && cam.running) freezePending = true; else cam.stop();
  },
  /** Tests: results carry an 8×8 grey thumbnail of the detected frame (metrics().lastFrameHash); thumb(frame). */
  frameHash(on) { cam?.setFrameHash?.(on); },
  /** Tests: 'auto' | 'sync' | 'delayed' | 'live' without freezing. */
  frameSync(p) { cam?.setFrameSync?.(p); },
  thumb: f => cam?.frameHash?.(f) ?? null,
  unfreeze() {
    freezePending = false;
    if (frozenTimeout != null) CONFIG.render.frameTimeoutMs = frozenTimeout; frozenTimeout = null;
    cam?.setFrameSync?.('auto');
    if (mode === 'camera') cam?.start(onResult);
  },
  /** Screen points (page px, display filter) of the live hands of the last detection. */
  handPoints() {
    const r = a => (a || []).map(p => [+p.x.toFixed(1), +p.y.toFixed(1)]);
    return latest.hands.filter(h => !h.lost).map(h => ({ id: h.id, pts: r(h.screenDisplay || h.screen), raw: r(h.screenRaw) }));
  },
  clear() { objects.clear(); },
  objects, stage, hud, capture, tutorial, audio,
};
