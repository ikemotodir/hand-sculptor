// Effects, all dt-driven (no timers). Spawn recipe = v1 exactly (SPEC §13.5), converted to seconds:
//   32 particles (0.4 s, gravity 7.2 u/s²) + 3 data rings (0.83 s, 4.8 rad/s) + 10 scan lines (1.17 s)
//   + glow sprite flash (8·e^(−31t), 0.2 s). The object's own uFlash/bounce is driven by objects.js.
// Also: delete rings, select ping, and the 3D alchemy sigil (circle + hexagon) with energy lines.
import * as THREE from 'three';
import { dotTexture, ringPositions, makeFatLines } from './holo.js';

const TAU = Math.PI * 2;

export function createFx({ stage, config }) {
  const R = config?.render || config || {};
  const F = { particles: 32, rareParticles: 64, particleLife: 0.4, ringLife: 0.83, lineLife: 1.17, gravity: 7.2, flashLife: 0.2, sizeRef: 1.3, ...(R.fx || {}) };
  const baseSize = R.baseSize ?? 1.6;
  const group = new THREE.Group();
  group.name = 'fx';
  stage.scene.add(group);
  const live = [];   // { t, life, step(t, dt), dispose() }
  const lineW = () => (stage.lineWidth ? stage.lineWidth() : 2);

  function hdr(color, k) { return new THREE.Color(color).multiplyScalar(k); }
  function add(item) { live.push(item); return item; }

  // ---------------------------------------------------------------- particles
  function burst(pos, color, { k = 1, count = F.particles, speed = 1, delay = 0, life = F.particleLife, upBias = 0.04 } = {}) {
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { p[i * 3] = pos.x; p[i * 3 + 1] = pos.y; p[i * 3 + 2] = pos.z; }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    // v1: s = 0.06..0.17 units per 16 ms tick → ×60 per second
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const th = Math.random() * TAU, ph = Math.random() * Math.PI, s = (0.06 + Math.random() * 0.11) * 60 * k * speed;
      vel[i * 3] = Math.sin(ph) * Math.cos(th) * s;
      vel[i * 3 + 1] = Math.sin(ph) * Math.sin(th) * s + upBias * 60 * k * speed;
      vel[i * 3 + 2] = Math.cos(ph) * s;
    }
    const mat = new THREE.PointsMaterial({
      color: hdr(color, 2.2), map: dotTexture(), size: 0.15 * k, sizeAttenuation: true,
      transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.visible = delay <= 0;
    group.add(pts);
    const g = F.gravity * k;
    return add({
      t: -delay, life,
      step(t, dt) {
        if (t < 0) return;
        pts.visible = true;
        const a = geo.attributes.position.array;
        for (let i = 0; i < count; i++) {
          vel[i * 3 + 1] -= g * dt;
          a[i * 3] += vel[i * 3] * dt; a[i * 3 + 1] += vel[i * 3 + 1] * dt; a[i * 3 + 2] += vel[i * 3 + 2] * dt;
        }
        geo.attributes.position.needsUpdate = true;
        mat.opacity = Math.max(0, 1 - t / life);
      },
      dispose() { pts.removeFromParent(); geo.dispose(); mat.dispose(); },
    });
  }

  // ---------------------------------------------------------------- rings
  function ring(pos, color, { inner, outer, rotX = 0, rotY = 0, k = 1, life, scaleFn, opacityFn, spin = 0, billboard = false }) {
    const geo = new THREE.RingGeometry(inner, outer, 48);
    const mat = new THREE.MeshBasicMaterial({ color: hdr(color, 0.85), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos);
    if (!billboard) { m.rotation.x = rotX; m.rotation.y = rotY; }
    group.add(m);
    return add({
      t: 0, life,
      step(t, dt) {
        m.scale.setScalar(k * scaleFn(t));
        mat.opacity = Math.max(0, opacityFn(t));
        m.rotation.z += spin * dt;
        if (billboard) m.quaternion.copy(stage.camera.quaternion);
      },
      dispose() { m.removeFromParent(); geo.dispose(); mat.dispose(); },
    });
  }

  // ---------------------------------------------------------------- glow sprite flash
  function glow(pos, color, { k = 1, peak = 8, decay = 31, life = F.flashLife, size = 1.5 } = {}) {
    const mat = new THREE.SpriteMaterial({ map: dotTexture(), color: new THREE.Color(color), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const sp = new THREE.Sprite(mat);
    sp.position.copy(pos);
    sp.scale.setScalar(size * k);
    group.add(sp);
    const base = new THREE.Color(color);
    return add({
      t: 0, life,
      step(t) {
        const I = peak * Math.exp(-decay * t);
        mat.color.copy(base).multiplyScalar(Math.min(I, 2) * 0.32);
        mat.opacity = Math.min(1, I * 0.5);
        sp.scale.setScalar(size * k * (1 + t * 1.5));
      },
      dispose() { sp.removeFromParent(); mat.dispose(); },
    });
  }

  // ---------------------------------------------------------------- public effects
  /** v1 spawn recipe. opts.size = object world size (scale × baseSize). */
  function spawn(pos3, color, { size = baseSize, rare = false } = {}) {
    const k = size / F.sizeRef;
    const pos = pos3.clone ? pos3.clone() : new THREE.Vector3(pos3.x, pos3.y, pos3.z);
    burst(pos, color, { k, count: rare ? F.rareParticles : F.particles });
    for (let ri = 0; ri < 3; ri++) {
      const a0 = 0.65 - ri * 0.15;
      ring(pos, color, {
        inner: 0.02 + ri * 0.12, outer: 0.08 + ri * 0.12, rotX: -Math.PI / 2 + ri * Math.PI / 4, rotY: ri * Math.PI / 3,
        k, life: F.ringLife, spin: 4.8,
        scaleFn: t => 1 + 0.3 * (ri + 1) * (t * 7.2),
        opacityFn: t => a0 * (1 - (t * 7.2) / 6),
      });
    }
    // 10 radial scan lines (v1: from (0,-0.8,0) to (cos a·0.65, 0.4, sin a·0.65)), scale.y grows
    const segs = [];
    for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; segs.push(0, -0.8, 0, Math.cos(a) * 0.65, 0.4, Math.sin(a) * 0.65); }
    const lines = makeFatLines(segs, { color: hdr(color, 1.3), width: lineW() * 0.75, opacity: 0.6 });
    lines.position.copy(pos);
    group.add(lines);
    add({
      t: 0, life: F.lineLife,
      step(t) {
        const lf = t * 6;
        lines.material.opacity = Math.max(0, 0.6 - lf * 0.1);
        lines.scale.set(k, k * (1 + lf * 0.4), k);
      },
      dispose() { lines.removeFromParent(); lines.geometry.dispose(); lines.material.dispose(); },
    });
    glow(pos, color, { k, peak: 8, decay: 31, life: F.flashLife });
    if (rare) glow(pos, '#ffffff', { k, peak: 4, decay: 12, life: 0.35, size: 2.0 });
  }

  /** v1 delete: 4 rings expanding + flash; plus the object's "shrink into particles" burst. */
  function remove(pos3, color, { size = baseSize } = {}) {
    const k = size / F.sizeRef;
    const pos = pos3.clone ? pos3.clone() : new THREE.Vector3(pos3.x, pos3.y, pos3.z);
    // v1 timing (f = 9t, scale 1 + 1.5f, opacity 0.7 − 0.18f) but drawn as crisp fat-line circles
    for (let i = 0; i < 4; i++) {
      const l = makeFatLines(ringPositions(0.1 * (i + 1), 64), { color: hdr(color, 1.5), width: lineW() * 1.2, opacity: 0.7 });
      l.position.copy(pos);
      l.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      group.add(l);
      add({
        t: 0, life: 5 / 9,
        step(t) { const f = t * 9; l.scale.setScalar(k * (1 + 1.5 * f)); l.material.opacity = Math.max(0, 0.7 - 0.18 * f); },
        dispose() { l.removeFromParent(); l.geometry.dispose(); l.material.dispose(); },
      });
    }
    glow(pos, color, { k, peak: 10, decay: 45, life: 0.14 });
    burst(pos, color, { k, count: 24, speed: 0.55, delay: (F.deleteShrink ?? 0.28) * 0.6, life: 0.45, upBias: 0.0 });
  }

  /** Selection ping: one billboarded ring expanding around the object. */
  function select(pos3, color, { size = baseSize } = {}) {
    const pos = pos3.clone ? pos3.clone() : new THREE.Vector3(pos3.x, pos3.y, pos3.z);
    const r = size * 0.62;
    ring(pos, color, {
      inner: 0.94, outer: 1.0, k: r, life: 0.38, billboard: true,
      scaleFn: t => 0.75 + 0.55 * (1 - Math.pow(1 - t / 0.38, 3)),
      opacityFn: t => 0.9 * (1 - t / 0.38),
    });
  }

  // ---------------------------------------------------------------- alchemy sigil (3D, bloom-visible)
  let sig = null;
  const SIG = { alpha: 0, target: 0, R: 1, prog: 0, rotA: 0, rotB: 0, flashT: -1, flashing: false, lastEvent: null, prevPhase: 'idle', color: new THREE.Color('#00f0ff') };
  function buildSigil() {
    const root = new THREE.Group(); root.name = 'sigil'; root.visible = false;
    const w = lineW();
    const mk = (pos, o) => { const l = makeFatLines(pos, { color: 0xffffff, width: w, ...o }); root.add(l); return l; };
    const outer = mk(ringPositions(1.0, 128), { width: w });
    const ticksPos = [];
    for (let i = 0; i < 48; i++) { const a = (i / 48) * TAU, r0 = 1.06, r1 = i % 4 === 0 ? 1.18 : 1.11; ticksPos.push(Math.cos(a) * r0, Math.sin(a) * r0, 0, Math.cos(a) * r1, Math.sin(a) * r1, 0); }
    const ticks = mk(ticksPos, { width: w * 0.7 });
    const dashed = mk(ringPositions(0.9, 40, true, 0.5), { width: w * 0.8 });
    const hexPos = [];
    for (let i = 0; i < 6; i++) {
      const a0 = Math.PI / 2 + (i / 6) * TAU, a1 = Math.PI / 2 + ((i + 1) / 6) * TAU;
      hexPos.push(Math.cos(a0) * 0.8, Math.sin(a0) * 0.8, 0, Math.cos(a1) * 0.8, Math.sin(a1) * 0.8, 0);
      hexPos.push(Math.cos(a0) * 0.42, Math.sin(a0) * 0.42, 0, Math.cos(a0) * 0.8, Math.sin(a0) * 0.8, 0);
    }
    const hexGroup = new THREE.Group(); root.add(hexGroup);
    const hex = makeFatLines(hexPos, { color: 0xffffff, width: w }); hexGroup.add(hex);
    const innerRing = makeFatLines(ringPositions(0.42, 96), { color: 0xffffff, width: w * 0.8 }); hexGroup.add(innerRing);
    const core = makeFatLines(ringPositions(0.16, 48), { color: 0xffffff, width: w }); root.add(core);
    // progress arc (clockwise from 12 o'clock), revealed with instanceCount
    const arcPos = [];
    const N = 128;
    for (let i = 0; i < N; i++) {
      const a0 = Math.PI / 2 - (i / N) * TAU, a1 = Math.PI / 2 - ((i + 1) / N) * TAU;
      arcPos.push(Math.cos(a0) * 1.26, Math.sin(a0) * 1.26, 0, Math.cos(a1) * 1.26, Math.sin(a1) * 1.26, 0);
    }
    const arc = mk(arcPos, { width: w * 1.4 });
    // gyroscope rings (tilted, rotate in 3D)
    const gyro = new THREE.Group(); root.add(gyro);
    const g1 = makeFatLines(ringPositions(0.62, 96, true, 0.7), { color: 0xffffff, width: w * 0.7 }); g1.rotation.x = 1.25; gyro.add(g1);
    const g2 = makeFatLines(ringPositions(0.62, 96, true, 0.7), { color: 0xffffff, width: w * 0.7 }); g2.rotation.y = 1.25; gyro.add(g2);
    // energy beams palm → center (unit segment, transformed per frame; dashes keep world size via dashScale)
    const beams = [0, 1].map(() => {
      const b = makeFatLines([0, 0, 0, 1, 0, 0], { color: 0xffffff, width: w * 1.2, dashed: true, dashSize: 0.18, gapSize: 0.12 });
      group.add(b); b.visible = false; return b;
    });
    const glowMat = new THREE.SpriteMaterial({ map: dotTexture(), color: 0xffffff, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const glowSp = new THREE.Sprite(glowMat); root.add(glowSp);
    group.add(root);
    const lines = [outer, ticks, dashed, hex, innerRing, core, arc, g1, g2];
    return { root, outer, ticks, dashed, hexGroup, hex, innerRing, core, arc, arcN: N, gyro, g1, g2, beams, glowSp, glowMat, lines };
  }

  let alch = null;            // latest state from setAlchemy
  const _mid = new THREE.Vector3(), _pa = new THREE.Vector3(), _pb = new THREE.Vector3();

  /**
   * @param {null|{phase:string, mid:{x,y}, dist:number, progress:number, pa?:{x,y}, pb?:{x,y}, color?:string}} state
   * pa/pb (palm centers, screen px) are optional — derived from mid ± dist/2 when missing.
   */
  function setAlchemy(state) {
    alch = state && state.mid ? state : null;
    if (alch?.color) SIG.color.set(alch.color);
  }

  function updateSigil(dt) {
    const phase = alch?.phase || 'idle';
    const active = phase === 'armed' || phase === 'growing';
    if (active && !sig) sig = buildSigil();
    if (!sig) return;
    // commit flash: growing → cooldown (or a spawn event)
    const ev = alch?.event?.type === 'spawn' ? alch.event : null;
    if ((SIG.prevPhase === 'growing' && phase === 'cooldown') || (ev && ev !== SIG.lastEvent)) {
      if (!SIG.flashing || SIG.flashT > 0.2) { SIG.flashT = 0; SIG.flashing = true; }
    }
    if (ev) SIG.lastEvent = ev;
    SIG.prevPhase = phase;

    const p = active ? Math.max(0, Math.min(1, alch.progress || 0)) : SIG.prog;
    SIG.prog += (p - SIG.prog) * (1 - Math.exp(-dt * 14));
    SIG.target = active ? (phase === 'armed' ? 0.55 : 0.7 + 0.3 * SIG.prog) : 0;
    const fadeK = SIG.target > SIG.alpha ? 10 : (SIG.flashing ? 5 : 9);
    SIG.alpha += (SIG.target - SIG.alpha) * (1 - Math.exp(-dt * fadeK));
    let flashBoost = 0, flashScale = 1;
    if (SIG.flashing) {
      SIG.flashT += dt;
      flashBoost = 1.6 * Math.exp(-SIG.flashT * 9);
      flashScale = 1 + 0.35 * (1 - Math.exp(-SIG.flashT * 6));
      if (SIG.flashT > 0.5) SIG.flashing = false;
    }
    const visible = SIG.alpha > 0.01 || SIG.flashing;
    sig.root.visible = visible;
    if (!visible) { sig.beams.forEach(b => (b.visible = false)); return; }

    if (alch && alch.mid) {
      stage.screenToWorld(alch.mid.x, alch.mid.y, 0, _mid);
      // retarget the radius only from a real hand distance: the real cooldown state has dist 0,
      // which must not collapse the sigil during the commit flash (R2-7)
      if (alch.dist > 0) {
        const wpp = stage.worldPerPx ? stage.worldPerPx(0) : 0.0125;
        const Rw = Math.max(0.25, alch.dist * 0.5 * wpp);
        SIG.R += (Rw - SIG.R) * (1 - Math.exp(-dt * 16));
      }
      sig.root.position.copy(_mid);
    }
    const Rr = SIG.R * (0.72 + 0.28 * SIG.prog) * flashScale;
    sig.root.scale.setScalar(Rr);
    const spd = 0.6 + 2.2 * SIG.prog;
    SIG.rotA += dt * spd; SIG.rotB -= dt * spd * 0.7;
    sig.dashed.rotation.z = SIG.rotA;
    sig.hexGroup.rotation.z = SIG.rotB;
    sig.ticks.rotation.z = SIG.rotA * 0.25;
    sig.gyro.rotation.y = SIG.rotA * 1.3;
    sig.gyro.rotation.x = SIG.rotB * 0.6;
    const arcN = Math.max(0, Math.round(SIG.prog * sig.arcN));
    sig.arc.geometry.instanceCount = Math.max(1, arcN);
    sig.arc.visible = arcN > 0;

    const a = SIG.alpha;
    const c = SIG.color;
    const tint = (line, k, op = 1) => { line.material.color.copy(c).multiplyScalar(k * (1 + flashBoost * 0.45)); line.material.opacity = Math.min(1, a * op + flashBoost * 0.15); };
    tint(sig.outer, 1.5); tint(sig.ticks, 1.1, 0.8); tint(sig.dashed, 1.2, 0.9);
    tint(sig.hex, 1.4 * (0.6 + 0.4 * SIG.prog)); tint(sig.innerRing, 1.1, 0.8); tint(sig.core, 1.8, SIG.prog);
    tint(sig.arc, 2.0); tint(sig.g1, 0.9, 0.35 + 0.5 * SIG.prog); tint(sig.g2, 0.9, 0.35 + 0.5 * SIG.prog);
    sig.glowMat.color.copy(c).multiplyScalar((0.1 + 0.25 * SIG.prog) * a + flashBoost * 0.18);
    sig.glowSp.scale.setScalar(0.55 + 0.3 * SIG.prog);

    // energy beams from both palms to the center
    const showBeams = !!alch && (alch.phase === 'armed' || alch.phase === 'growing');
    if (showBeams) {
      let pa = alch.pa, pb = alch.pb;
      if (!pa || !pb) { const h = (alch.dist || 0) / 2; pa = { x: alch.mid.x - h, y: alch.mid.y }; pb = { x: alch.mid.x + h, y: alch.mid.y }; }
      stage.screenToWorld(pa.x, pa.y, 0, _pa); stage.screenToWorld(pb.x, pb.y, 0, _pb);
      [[_pa, sig.beams[0]], [_pb, sig.beams[1]]].forEach(([from, b]) => {
        const dx = _mid.x - from.x, dy = _mid.y - from.y, len = Math.hypot(dx, dy);
        b.visible = len > 0.05;
        b.position.copy(from);
        b.rotation.set(0, 0, Math.atan2(dy, dx));
        b.scale.set(len, 1, 1);
        b.material.dashScale = len;
        b.material.dashOffset = -SIG.rotA * 1.6;
        b.material.color.copy(c).multiplyScalar(1.6);
        b.material.opacity = a * (0.35 + 0.65 * SIG.prog);
      });
    } else sig.beams.forEach(b => (b.visible = false));
  }

  // ---------------------------------------------------------------- loop
  function update(dt) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    for (let i = live.length - 1; i >= 0; i--) {
      const it = live[i];
      it.t += dt;
      if (it.t >= it.life) { it.dispose(); live.splice(i, 1); continue; }
      it.step(it.t, dt);
    }
    updateSigil(dt);
  }

  function clear() { for (const it of live) it.dispose(); live.length = 0; }
  function dispose() {
    clear();
    if (sig) { sig.lines.forEach(l => { l.geometry.dispose(); l.material.dispose(); }); sig.beams.forEach(b => { b.geometry.dispose(); b.material.dispose(); }); sig.glowMat.dispose(); }
    group.removeFromParent();
  }

  return { spawn, remove, select, burst: (p, c, o) => burst(p, c, o), setAlchemy, update, clear, dispose, activeCount: () => live.length, group };
}
