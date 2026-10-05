// First-run tutorial (5 steps, SPEC §13.7) + one-time hint chips (localStorage hs.hints.seen).
// createTutorial({ root, hud, onStart, onDone }) -> { start(), stop(), active, step, onEvent(name, data), shouldAutoStart() }
// Events: 'hands' | 'select' | 'grab' | 'alchemySpawn' | 'rotate' | 'deselect' | 'delete' | 'count' (data = object count)
// onStart(): called on start() — main places the starter cube at the center if the scene is empty.
import { addStrings, t } from '../i18n.js';
import { UI } from '../config/ui.js';

addStrings({ ja: {
  'tut.1': 'てを かざしてね', 'tut.2': 'ゆびで さしてね', 'tut.3': 'つまんで うごかす', 'tut.4': 'てを あわせて ひらく', 'tut.5': 'グーで まわす',
  'tut.done': 'できた！', 'tut.skip': 'スキップ',
  'tut.h.free': '👍で はなす', 'tut.h.size': '親指と人差し指で 大きさ', 'tut.h.del': '小指だけ立てて長押しで けす',
}});

const STEPS = [
  { icon: '✋', key: 'tut.1', ev: 'hands', cap: 'SHOW HAND' },
  { icon: '☝️', key: 'tut.2', ev: 'select', cap: 'POINT' },
  { icon: '🤏', key: 'tut.3', ev: 'grab', cap: 'PINCH & MOVE' },
  { icon: '🙏', key: 'tut.4', ev: 'alchemySpawn', cap: 'JOIN & OPEN' },
  { icon: '✊', key: 'tut.5', ev: 'rotate', cap: 'FIST ROTATE' },
];
const HINTS = { select: 'tut.h.free', grab: 'tut.h.size', count3: 'tut.h.del' };

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

export function createTutorial({ root, hud, onStart = () => {}, onDone = () => {}, stepMs = UI.tutorialStepMs } = {}) {
  const el = document.createElement('div');
  el.className = 'hs-tut glass'; el.hidden = true;
  el.innerHTML = `
    <div class="tut-top"><span class="cap tut-n"></span><span class="tut-dots">${STEPS.map(() => '<i></i>').join('')}</span></div>
    <div class="tut-main"><span class="tut-ic"></span><span class="tut-tx"></span></div>
    <div class="tut-bar"><i></i></div>
    <button class="tut-skip" id="tut-skip" data-dwell></button>`;
  root.appendChild(el);
  const q = s => el.querySelector(s);
  q('#tut-skip').textContent = t('tut.skip');

  let active = false, idx = -1, timer = 0, doneTimer = 0, advancing = false;
  const seen = new Set(lsGet(UI.storageKeys.hintsSeen, []));

  function render() {
    const s = STEPS[idx];
    q('.tut-n').textContent = `STEP ${idx + 1}/${STEPS.length} · ${s.cap}`;
    q('.tut-ic').textContent = s.icon;
    q('.tut-tx').textContent = t(s.key);
    el.querySelectorAll('.tut-dots i').forEach((d, i) => { d.className = i < idx ? 'done' : i === idx ? 'cur' : ''; });
    el.classList.remove('ok', 'fin');
    const bar = q('.tut-bar i');
    bar.style.animation = 'none'; void bar.offsetWidth;
    bar.style.animation = `hs-tutbar ${stepMs}ms linear forwards`;
  }
  function go(i) {
    clearTimeout(timer); advancing = false;
    if (i >= STEPS.length) return finish();
    idx = i; render();
    timer = setTimeout(() => go(idx + 1), stepMs);   // auto-advance after 15 s
  }
  function finish() {
    clearTimeout(timer);
    el.classList.add('ok', 'fin');
    q('.tut-ic').textContent = '✨'; q('.tut-tx').textContent = t('tut.done'); q('.tut-n').textContent = 'COMPLETE';
    el.querySelectorAll('.tut-dots i').forEach(d => { d.className = 'done'; });
    q('.tut-bar i').style.animation = 'none';
    lsSet(UI.storageKeys.tutorialDone, true);
    doneTimer = setTimeout(() => close(true), 1300);
  }
  function close(completed) {
    clearTimeout(timer); clearTimeout(doneTimer);
    if (!active) return;
    active = false; idx = -1;
    el.classList.add('out');
    setTimeout(() => { if (!active) { el.hidden = true; el.classList.remove('out'); hud?.layout?.(); } }, 260);
    lsSet(UI.storageKeys.tutorialDone, true);
    try { onDone(!!completed); } catch (e) { console.error(e); }
  }
  function start() {
    clearTimeout(doneTimer);
    active = true; el.hidden = false; el.classList.remove('out');
    hud?.setGuide?.(false);   // the card covers the open guide (its ✕ and first row) on phones
    hud?.layout?.();          // 縦 frame: a 2-column toolbar moves below the card
    try { onStart(); } catch (e) { console.error(e); }
    go(0);
  }
  function stop() { close(false); }
  q('#tut-skip').addEventListener('click', stop);

  function oneHint(key) {
    if (seen.has(key)) return;
    seen.add(key); lsSet(UI.storageKeys.hintsSeen, [...seen]);
    hud?.hint?.(t(HINTS[key]), 4000);
  }

  function onEvent(name, data) {
    if (active && idx >= 0 && !advancing && STEPS[idx].ev === name) {
      advancing = true; clearTimeout(timer);
      el.classList.add('ok');
      q('.tut-bar i').style.animation = 'none';
      timer = setTimeout(() => go(idx + 1), 700);
      return;
    }
    if (active) return;   // one-time hints only after the tutorial
    if (name === 'select') oneHint('select');
    else if (name === 'grab') oneHint('grab');
    else if (name === 'count' && data >= 3) oneHint('count3');
  }

  return {
    start, stop, onEvent,
    get active() { return active; }, get step() { return idx; },
    shouldAutoStart: () => !lsGet(UI.storageKeys.tutorialDone, false),
    applyLang() { q('#tut-skip').textContent = t('tut.skip'); if (active && idx >= 0) render(); },
  };
}
