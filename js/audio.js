// WebAudio synthesized SFX — no audio files. Short, soft, sci-fi; nothing harsh.
//
//   const audio = createAudio();
//   startButton.onclick = () => audio.unlock();     // must be called from a real tap/click once
//   audio.play('spawn'); audio.hum(0.4); audio.hum(null);
//   recorder gets audio.destinationStream()          // MediaStream with every SFX
//
// Names: spawn rare grab release select deselect delete dwell confirm shutter count go
//        recStart recStop arm cancel toast   (unknown names are ignored)
import { CONFIG } from './config.js';

export const SFX_NAMES = ['spawn', 'rare', 'grab', 'release', 'select', 'deselect', 'delete', 'dwell', 'confirm',
  'shutter', 'count', 'go', 'recStart', 'recStop', 'arm', 'cancel', 'toast'];

export function createAudio({ gain = CONFIG.media.masterGain } = {}) {
  let ctx = null, master = null, out = null, comp = null, delaySend = null, mediaDest = null, noiseBuf = null;
  let muted = false;
  let held = 0;            // recordings using destinationStream(): keep the context running even when muted
  let suspendTimer = 0;
  const lastPlayed = {};
  let humNodes = null;

  // iOS 17+: 'playback' plays even when the ring switch is on silent (§13.6), but it is not mixable: it stops
  // the user's music. So it is only taken while sound is ON; with sound OFF the session is 'ambient' and the
  // context is never created / resumed (R2-31).
  const setSession = type => { try { if (typeof navigator !== 'undefined' && navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* */ } };
  setSession('playback');

  function ensure() {
    if (ctx) return ctx;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (_) { return null; } }
    master = ctx.createGain(); master.gain.value = muted ? 0 : gain;
    comp = ctx.createDynamicsCompressor();         // soft limiter so stacked sounds never clip
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
    out = ctx.createGain(); out.gain.value = 1;
    master.connect(comp); comp.connect(out); out.connect(ctx.destination);
    // gentle echo send (the "hologram space" tail)
    delaySend = ctx.createGain(); delaySend.gain.value = 0.22;
    const dl = ctx.createDelay(1); dl.delayTime.value = 0.13;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
    delaySend.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(master);
    // white noise for shutter/zap texture
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  const resumeIfNeeded = () => { if (ctx && !muted && ctx.state !== 'running') ctx.resume().catch(() => {}); };
  /** sound OFF: let the context sleep (frees the iOS audio session) unless a recording still uses it */
  function suspendSoon() {
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => { if (muted && !held && ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 150);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', resumeIfNeeded, { capture: true, passive: true });
    window.addEventListener('touchend', resumeIfNeeded, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumeIfNeeded(); });
  }

  /** One enveloped oscillator voice. */
  function tone(t, { type = 'sine', f0, f1 = f0, dur = 0.12, a = 0.005, g = 0.5, send = 0, lp = 0, curve = 'exp' }) {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) {
      if (curve === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      else o.frequency.linearRampToValueAtTime(f1, t + dur);
    }
    const v = ctx.createGain();
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(g, t + a);
    v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); node = f; }
    node.connect(v); v.connect(master);
    if (send) { const s = ctx.createGain(); s.gain.value = send; v.connect(s); s.connect(delaySend); }
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(t, { dur = 0.05, g = 0.3, bp = 3000, q = 1.2, send = 0 }) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = q;
    const v = ctx.createGain();
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(g, t + 0.003);
    v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(v); v.connect(master);
    if (send) { const sg = ctx.createGain(); sg.gain.value = send; v.connect(sg); sg.connect(delaySend); }
    s.start(t, Math.random() * 0.3); s.stop(t + dur + 0.02);
  }

  const SOUNDS = {
    spawn(t) {   // shimmer: soft rising sweep + sparkling major arpeggio
      tone(t, { type: 'sine', f0: 280, f1: 1100, dur: 0.32, a: 0.02, g: 0.18, send: 0.4 });
      [659, 831, 988, 1319].forEach((f, i) => tone(t + 0.04 + i * 0.045, { type: 'triangle', f0: f, dur: 0.28, g: 0.22, send: 0.6 }));
    },
    rare(t) {
      SOUNDS.spawn(t);
      [1568, 1976, 2349, 2637, 3136].forEach((f, i) => tone(t + 0.22 + i * 0.05, { type: 'sine', f0: f, dur: 0.35, g: 0.12, send: 0.8 }));
    },
    grab(t) { tone(t, { type: 'sine', f0: 900, f1: 640, dur: 0.05, g: 0.35 }); },
    release(t) { tone(t, { type: 'sine', f0: 520, f1: 380, dur: 0.07, g: 0.3 }); },
    select(t) {
      tone(t, { type: 'sine', f0: 1046, dur: 0.06, g: 0.25 });
      tone(t + 0.055, { type: 'sine', f0: 1568, dur: 0.1, g: 0.22, send: 0.3 });
    },
    deselect(t) {
      tone(t, { type: 'sine', f0: 1318, dur: 0.06, g: 0.2 });
      tone(t + 0.055, { type: 'sine', f0: 880, dur: 0.1, g: 0.2 });
    },
    delete(t) {  // soft "dematerialize": falling filtered sweep + airy noise
      tone(t, { type: 'triangle', f0: 1400, f1: 180, dur: 0.26, g: 0.28, lp: 2600, send: 0.35 });
      noise(t, { dur: 0.18, g: 0.08, bp: 5000, q: 0.8, send: 0.3 });
    },
    dwell(t) { tone(t, { type: 'sine', f0: 2100, dur: 0.025, g: 0.08 }); },
    confirm(t) {
      tone(t, { type: 'sine', f0: 784, dur: 0.08, g: 0.24 });
      tone(t + 0.07, { type: 'triangle', f0: 1175, dur: 0.14, g: 0.22, send: 0.3 });
    },
    shutter(t) {
      noise(t, { dur: 0.04, g: 0.35, bp: 3200, q: 1 });
      noise(t + 0.06, { dur: 0.05, g: 0.25, bp: 2200, q: 1 });
      tone(t, { type: 'sine', f0: 160, f1: 90, dur: 0.08, g: 0.25 });
    },
    count(t) { tone(t, { type: 'sine', f0: 880, dur: 0.12, g: 0.22, send: 0.2 }); },
    go(t) { tone(t, { type: 'sine', f0: 1320, dur: 0.18, g: 0.24, send: 0.3 }); },
    recStart(t) {
      tone(t, { type: 'sine', f0: 660, dur: 0.08, g: 0.22 });
      tone(t + 0.08, { type: 'sine', f0: 990, dur: 0.14, g: 0.22, send: 0.2 });
    },
    recStop(t) {
      tone(t, { type: 'sine', f0: 990, dur: 0.08, g: 0.2 });
      tone(t + 0.08, { type: 'sine', f0: 660, dur: 0.14, g: 0.2 });
    },
    arm(t) { tone(t, { type: 'sine', f0: 330, f1: 440, dur: 0.25, a: 0.06, g: 0.16, curve: 'lin', send: 0.4 }); },
    cancel(t) { tone(t, { type: 'sine', f0: 392, f1: 262, dur: 0.18, g: 0.16, curve: 'lin' }); },
    toast(t) { tone(t, { type: 'sine', f0: 1480, dur: 0.05, g: 0.1 }); },
  };

  function play(name) {
    const fn = SOUNDS[name];
    if (!fn || muted) return;
    if (!ensure()) return;
    if (ctx.state !== 'running') { resumeIfNeeded(); if (ctx.state !== 'running') return; }
    const now = ctx.currentTime;
    if (lastPlayed[name] != null && now - lastPlayed[name] < 0.03) return;   // de-spam
    lastPlayed[name] = now;
    try { fn(now + 0.005); } catch (e) { console.warn('[audio]', name, e); }
  }

  /** Alchemy hum: progress 0..1 raises pitch/brightness; null fades out. */
  function hum(progress) {
    if (progress == null || muted) {
      if (humNodes && ctx) {
        const h = humNodes; humNodes = null;
        const t = ctx.currentTime;
        h.v.gain.cancelScheduledValues(t);
        h.v.gain.setTargetAtTime(0, t, 0.05);
        setTimeout(() => { try { h.o1.stop(); h.o2.stop(); h.lfo.stop(); } catch (e) { /* */ } }, 400);
      }
      return;
    }
    if (!ensure() || ctx.state !== 'running') return;
    const p = Math.max(0, Math.min(1, progress));
    const t = ctx.currentTime;
    if (!humNodes) {
      const o1 = ctx.createOscillator(); o1.type = 'sine';
      const o2 = ctx.createOscillator(); o2.type = 'triangle';
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 2;
      const v = ctx.createGain(); v.gain.value = 0;
      const trem = ctx.createGain(); trem.gain.value = 0.75;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 7;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.25;
      lfo.connect(lfoG); lfoG.connect(trem.gain);
      o1.connect(f); o2.connect(f); f.connect(trem); trem.connect(v); v.connect(master);
      const s = ctx.createGain(); s.gain.value = 0.3; v.connect(s); s.connect(delaySend);
      o1.start(t); o2.start(t); lfo.start(t);
      humNodes = { o1, o2, f, v, lfo };
    }
    const base = 110 + 220 * p;
    humNodes.o1.frequency.setTargetAtTime(base, t, 0.05);
    humNodes.o2.frequency.setTargetAtTime(base * 1.5 * 1.003, t, 0.05);
    humNodes.f.frequency.setTargetAtTime(500 + 2600 * p, t, 0.05);
    humNodes.lfo.frequency.setTargetAtTime(6 + 8 * p, t, 0.1);
    humNodes.v.gain.setTargetAtTime(0.10 + 0.16 * p, t, 0.06);
  }

  /** Create/resume the AudioContext. Call from a real tap (LAUNCH). */
  async function unlock() {
    if (muted) return false;               // sound OFF: never wake the audio session (R2-31)
    if (!ensure()) return false;
    try {
      // iOS legacy unlock: play one silent sample inside the gesture
      const b = ctx.createBuffer(1, 1, ctx.sampleRate); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
      await ctx.resume();
    } catch (e) { /* */ }
    return ctx.state === 'running';
  }

  return {
    unlock,
    play,
    hum,
    /** Sound ON/OFF. ON from a real tap also starts the context (that tap is the unlock gesture). */
    setMuted(b) {
      const was = muted;
      muted = !!b;
      setSession(muted ? 'ambient' : 'playback');
      if (muted) hum(null);
      if (master) master.gain.setTargetAtTime(muted ? 0 : gain, ctx.currentTime, 0.02);
      if (muted) suspendSoon();
      else if (was) {
        clearTimeout(suspendTimer);
        const act = typeof navigator !== 'undefined' && navigator.userActivation;
        if (ctx || !act || act.isActive) unlock();
      }
    },
    /** A recording uses destinationStream(): keep the context running until release (even if muted). */
    hold() {
      held++;
      let done = false;
      return () => { if (done) return; done = true; held = Math.max(0, held - 1); if (muted) suspendSoon(); };
    },
    get muted() { return muted; },
    get context() { return ctx; },
    get state() { return ctx ? ctx.state : 'none'; },
    /** MediaStream carrying every SFX (for MediaRecorder). Creates the context if needed. */
    destinationStream() {
      if (!ensure()) return null;
      if (!mediaDest) { mediaDest = ctx.createMediaStreamDestination(); out.connect(mediaDest); }
      return mediaDest.stream;
    },
  };
}
