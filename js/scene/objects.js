// SceneAPI implementation (SPEC §5.5 + §12 + §13.4): object registry, screen-space picking,
// transforms, styles, undo, serialization, alchemy preview, export.
import * as THREE from 'three';
import { createHolo, HOLO_SHARED, SHAPES, makeFatLines, ringPositions } from './holo.js';
import { buildExportGroup, disposeExportGroup, exportGLB, exportUSDZ } from './export.js';

const easeOutCubic = x => 1 - Math.pow(1 - x, 3);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** v1 bounce: s(t) = easeOutCubic(min(t,1))·(1 + 0.15·sin(12t)·e^(−1.5t)), t = 5·seconds, ends at 2.5 */
export function popScale(t) {
  if (t >= 2.5) return 1;
  return Math.max(0.01, easeOutCubic(Math.min(t, 1)) * (1 + 0.15 * Math.sin(12 * t) * Math.exp(-1.5 * t)));
}

/**
 * @param {{stage:object, fx:object, config:object, onEvent?:(name:string, data:object)=>void}} o
 */
export function createObjects({ stage, fx, config, onEvent = null }) {
  const R = config?.render || config || {};
  const UIc = config?.ui || {};
  const H = R.holo || {};
  const baseSize = R.baseSize ?? 1.6;
  const [sMin, sMax] = R.scaleRange || [0.25, 6];
  const shapes = (R.shapes || SHAPES).filter(s => SHAPES.includes(s));
  const colors = R.colors || ['#00f0ff'];
  const undoDepth = UIc.undoDepth ?? 50;
  const colorOnSelected = UIc.colorOnSelected ?? true;
  const decay = R.spinDecay ?? 0.93;
  const maxSpin = R.maxSpin ?? 12;
  const shapeScale = 1 / 1.6 * baseSize;   // holo geometry is authored for baseSize 1.6

  const world = new THREE.Group();
  world.name = 'holograms';
  stage.scene.add(world);

  const recs = new Map();    // id → rec
  const order = [];          // ids in creation order
  const dying = [];          // removed recs playing their shrink
  let nextId = 1;
  let selectedId = null, hoverId = null;
  let time = 0;
  const undoStack = [];
  let lastType = null;

  // default style for new spawns: null = random (🎲)
  const style = { type: null, colorIdx: null, opacity: H.defaultOpacity ?? 0.2 };

  // ---------------------------------------------------------------- selection ring (one, reused)
  const lw = () => (stage.lineWidth ? stage.lineWidth() : 2);
  const selRing = new THREE.Group();
  const ringDash = makeFatLines(ringPositions(1, 56, true, 0.55), { width: lw() * 1.1 });
  const ringThin = makeFatLines(ringPositions(0.93, 128), { width: lw() * 0.6 });
  const tickPos = [];
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; tickPos.push(Math.cos(a) * 1.05, Math.sin(a) * 1.05, 0, Math.cos(a) * 1.17, Math.sin(a) * 1.17, 0); }
  const ringTicks = makeFatLines(tickPos, { width: lw() * 1.4 });
  selRing.add(ringDash, ringThin, ringTicks);
  selRing.visible = false;
  stage.scene.add(selRing);
  const ring = { alpha: 0, color: new THREE.Color(), r: 1, pos: new THREE.Vector3() };

  // ---------------------------------------------------------------- helpers
  const emit = (n, d) => { try { onEvent && onEvent(n, d); } catch (e) { console.warn(e); } };
  function resolveColor(c) {
    if (typeof c === 'string' && c && c !== 'random') return c;
    if (typeof c === 'number' && c >= 0 && colors[c]) return colors[c];
    if (style.colorIdx != null && style.colorIdx >= 0 && colors[style.colorIdx]) return colors[style.colorIdx];
    return colors[Math.floor(Math.random() * colors.length)];
  }
  function resolveType(t) {
    if (t && shapes.includes(t)) return t;
    if (style.type && shapes.includes(style.type)) return style.type;
    const pool = shapes.length > 1 ? shapes.filter(s => s !== lastType) : shapes;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  const worldSize = rec => rec.holo.root.scale.x * baseSize;

  function makeRec({ id, type, color, level, rare = false }) {
    const holo = createHolo({ type, color, level, lineWidth: lw(), cfg: H });
    holo.inner.scale.setScalar(1);
    holo.mesh.scale.setScalar(shapeScale); holo.edges.scale.setScalar(shapeScale); holo.glints.scale.setScalar(shapeScale);
    const rec = {
      id, type: holo.type, color, level, rare, holo,
      touched: false, spin: new THREE.Vector2(), popT: null, popT0: 0, flashT: null,
      bobPhase: Math.random() * Math.PI * 2, bobAmp: 1, before: null, styleBefore: null,
    };
    world.add(holo.root);
    recs.set(id, rec);
    order.push(id);
    return rec;
  }
  function snap(rec) {
    const r = rec.holo.root;
    return {
      id: rec.id, type: rec.type, color: rec.color, opacity: rec.level, rare: rec.rare || undefined, touched: rec.touched || undefined,
      p: r.position.toArray().map(n => +n.toFixed(4)), q: r.quaternion.toArray().map(n => +n.toFixed(5)), s: +r.scale.x.toFixed(4),
    };
  }
  function fromSnap(d, { pop = true, keepId = true } = {}) {
    let id = keepId && d.id != null && !recs.has(d.id) ? d.id : nextId++;
    if (typeof id === 'number' && id >= nextId) nextId = id + 1;
    const rec = makeRec({ id, type: d.type, color: d.color || colors[0], level: d.opacity ?? style.opacity, rare: !!d.rare });
    const r = rec.holo.root;
    if (d.p) r.position.fromArray(d.p);
    if (d.q) r.quaternion.fromArray(d.q).normalize();
    r.scale.setScalar(clamp(d.s ?? 1, sMin, sMax));
    rec.touched = !!d.touched;
    if (pop) { rec.popT = 0; rec.popT0 = 0.35; }   // quick soft pop for restores / undo
    return rec;
  }
  function pushUndo(e) { undoStack.push(e); if (undoStack.length > undoDepth) undoStack.shift(); }
  function destroy(rec, { fxRemove = false, shrink = true } = {}) {
    if (!recs.has(rec.id)) return;
    recs.delete(rec.id);
    const i = order.indexOf(rec.id); if (i >= 0) order.splice(i, 1);
    if (selectedId === rec.id) selectedId = null;
    if (hoverId === rec.id) hoverId = null;
    if (fxRemove) fx?.remove(rec.holo.root.position, rec.color, { size: worldSize(rec) });
    if (shrink) { rec.dieT = 0; rec.dieScale = rec.holo.inner.scale.x; dying.push(rec); }
    else rec.holo.dispose();
  }

  // ---------------------------------------------------------------- picking
  const _v = new THREE.Vector3(), _right = new THREE.Vector3();
  function getScreenInfo(id) {
    const rec = recs.get(id);
    if (!rec) return null;
    const r = rec.holo.root;
    const c = stage.worldToScreen(r.position);
    _right.set(1, 0, 0).applyQuaternion(stage.camera.quaternion);
    const wr = rec.holo.radius * shapeScale * r.scale.x * 0.82;
    _v.copy(r.position).addScaledVector(_right, wr);
    const e = stage.worldToScreen(_v);
    return { x: c.x, y: c.y, r: Math.hypot(e.x - c.x, e.y - c.y) };
  }
  function pick(sx, sy, slopPx = 0) {
    let best = null, bestScore = Infinity, bestZ = -Infinity;
    for (const id of order) {
      const s = getScreenInfo(id);
      if (!s) continue;
      const d = Math.hypot(sx - s.x, sy - s.y);
      if (d > s.r + slopPx) continue;
      const score = d / Math.max(1, s.r);
      const z = recs.get(id).holo.root.position.z;
      if (score < bestScore - 0.15 || (Math.abs(score - bestScore) <= 0.15 && z > bestZ)) { best = id; bestScore = score; bestZ = z; }
    }
    return best;
  }

  // ---------------------------------------------------------------- selection / hover
  const getSelected = () => selectedId;
  function select(id) {
    if (id != null && !recs.has(id)) id = null;
    if (id === selectedId) return;
    selectedId = id;
    if (id != null) {
      const rec = recs.get(id);
      fx?.select(rec.holo.root.position, rec.color, { size: worldSize(rec) });
      ring.alpha = 0;
    }
  }
  function setHover(id) { hoverId = id != null && recs.has(id) ? id : null; }

  // ---------------------------------------------------------------- transforms
  function beginTransform(id) {
    const rec = recs.get(id); if (!rec) return;
    rec.touched = true;
    // overlapping gestures on one object (hand grab + mouse wheel / touch drag): keep the pose from the
    // first begin, so one undo returns to where the object was before any of them started
    if (!rec.before) rec.before = snap(rec);
  }
  function endTransform(id) {
    const rec = recs.get(id); if (!rec || !rec.before) return;
    const now = snap(rec), b = rec.before;
    rec.before = null;
    const changed = b.s !== now.s || b.p.some((v, i) => Math.abs(v - now.p[i]) > 1e-3) || b.q.some((v, i) => Math.abs(v - now.q[i]) > 1e-4);
    if (changed) pushUndo({ kind: 'transform', id, before: b });
  }
  function setGrabPose(id, sx, sy, z) {
    const rec = recs.get(id); if (!rec) return;
    rec.touched = true;
    const r = rec.holo.root;
    const zz = z === undefined || z === null ? r.position.z : clamp(z, -6, 4);
    stage.screenToWorld(sx, sy, zz, r.position);
  }
  /** legacy §5.5 helpers (kept for compatibility) */
  function moveScreen(id, dx, dy) {
    const rec = recs.get(id); if (!rec) return;
    const s = stage.worldToScreen(rec.holo.root.position);
    setGrabPose(id, s.x + dx, s.y + dy);
  }
  function setDepth(id, dz) { const rec = recs.get(id); if (rec) { rec.touched = true; rec.holo.root.position.z = clamp(rec.holo.root.position.z + dz, -6, 4); } }

  const _q = new THREE.Quaternion(), _qx = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _qz = new THREE.Quaternion();
  const _qi = new THREE.Quaternion();
  const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
  function rotateWorld(root, ax, ay, az) {
    _qx.setFromAxisAngle(AX, ax); _qy.setFromAxisAngle(AY, ay); _qz.setFromAxisAngle(AZ, az);
    _q.copy(_qy).multiply(_qx).multiply(_qz);
    root.quaternion.premultiply(_q).normalize();
  }
  function rotateBy(id, ax = 0, ay = 0, az = 0) {
    const rec = recs.get(id); if (!rec) return;
    rec.touched = true;
    rotateWorld(rec.holo.root, ax, ay, az);
  }
  function setSpin(id, wx = 0, wy = 0) {
    const rec = recs.get(id); if (!rec) return;
    rec.touched = true;
    rec.spin.set(clamp(wx, -maxSpin, maxSpin), clamp(wy, -maxSpin, maxSpin));
  }
  function scaleBy(id, factor) {
    const rec = recs.get(id); if (!rec || !(factor > 0)) return;
    rec.touched = true;
    rec.holo.root.scale.setScalar(clamp(rec.holo.root.scale.x * factor, sMin, sMax));
  }

  // ---------------------------------------------------------------- style
  function applyStyle(rec, { color, opacity }) {
    if (color != null) {
      const c = resolveColor(color);
      if (c !== rec.color) { rec.color = c; rec.holo.setColor(c); rec.rare = false; }
    }
    if (opacity != null && opacity !== rec.level) { rec.level = opacity; rec.holo.setLevel(opacity); }
  }
  /**
   * setStyle({type, colorIdx, opacity})      → default style for new spawns (null/'random' = 🎲);
   *                                            color/opacity changes also restyle the selection (undoable)
   * setStyle(id, {color?, opacity?})          → restyle one object (undoable)
   */
  function setStyle(a, b) {
    if (a !== null && typeof a === 'object') {
      const o = a;
      const changed = {};
      if ('type' in o) style.type = o.type && o.type !== 'random' ? o.type : null;
      // What the selection gets is decided per tap, not by whether the default changed:
      // tapping the colour/opacity that is already the default must still restyle the selected object.
      if ('colorIdx' in o) {
        const ci = o.colorIdx == null || o.colorIdx === 'random' || o.colorIdx < 0 ? null : o.colorIdx;
        style.colorIdx = ci;
        if (ci != null) changed.color = ci;
      }
      if ('opacity' in o && o.opacity != null) { style.opacity = o.opacity; changed.opacity = o.opacity; }
      // a growing alchemy preview becomes the next object: show the tapped colour/opacity on it now
      if (preview && preview.fadeT == null) {
        if (changed.color != null && !preview.rare) { preview.color = resolveColor(changed.color); preview.holo.setColor(preview.color); }
        if (changed.opacity != null) { preview.level = changed.opacity; preview.holo.setLevel(changed.opacity); }
      }
      if (colorOnSelected && selectedId != null && (changed.color != null || changed.opacity != null)) setStyle(selectedId, changed);
      return { ...style };
    }
    const rec = recs.get(a); if (!rec || !b) return;
    const before = { color: rec.color, opacity: rec.level, rare: rec.rare };
    applyStyle(rec, b);
    if (before.color !== rec.color || before.opacity !== rec.level || before.rare !== rec.rare) pushUndo({ kind: 'style', id: a, before });
  }
  const getStyle = () => ({ ...style });

  // ---------------------------------------------------------------- spawn / remove / duplicate
  let preview = null;   // {holo, type, color, level, rare, scale, progress, fadeT|null, pos}

  function sizeToScale(sizePx, z = 0) {
    if (!(sizePx > 0)) return 1;
    return clamp((sizePx * stage.worldPerPx(z)) / baseSize, sMin, sMax);
  }

  /**
   * spawn({type, color, opacity, sx, sy, sizePx, z, rare}) → id
   * type/color undefined or 'random' → current style (🎲 random when not fixed). color may be a hex or a palette index.
   * rare: undefined → rolled with config.rareChance; true/false forces.
   */
  function spawn(o = {}) {
    let type, color, startT = 0;
    const usePreview = preview && (!o.type || o.type === 'random') && (o.color == null || o.color === 'random');
    if (usePreview) { type = preview.type; color = preview.color; }
    else { type = resolveType(o.type === 'random' ? null : o.type); color = resolveColor(o.color); }
    const level = o.opacity ?? style.opacity;
    const rare = o.rare === true || (o.rare === undefined && (usePreview ? preview.rare : Math.random() < (R.rareChance ?? 0.05)));
    if (rare) color = R.rareColor || '#ffd75e';
    const rec = makeRec({ id: nextId++, type, color, level, rare });
    const r = rec.holo.root;
    const z = o.z ?? 0;
    if (o.sx != null && o.sy != null) stage.screenToWorld(o.sx, o.sy, z, r.position);
    else r.position.set(0, 0, z);
    const s = sizeToScale(o.sizePx, z);
    r.scale.setScalar(s);
    if (usePreview) {
      const ratio = clamp(preview.scale / s, 0, 0.999);
      startT = 1 - Math.cbrt(1 - ratio);       // easeOutCubic(t0) = preview / final
      r.quaternion.copy(preview.holo.root.quaternion);
      preview.holo.dispose(); preview = null;
    }
    rec.popT = 0; rec.popT0 = startT;
    rec.flashT = 0;
    rec.holo.inner.scale.setScalar(popScale(startT));
    lastType = type;
    fx?.spawn(r.position, color, { size: s * baseSize, rare });
    pushUndo({ kind: 'spawn', id: rec.id });
    if (rare) emit('rare', { id: rec.id });
    emit('spawn', { id: rec.id, type, color, rare });
    return rec.id;
  }

  function remove(id) {
    const rec = recs.get(id); if (!rec) return false;
    pushUndo({ kind: 'remove', data: snap(rec) });
    destroy(rec, { fxRemove: true });
    emit('remove', { id });
    return true;
  }

  function duplicate(id) {
    const src = recs.get(id); if (!src) return null;
    const d = snap(src);
    delete d.id;
    const k = worldSize(src) * 0.45;
    d.p = [d.p[0] + k, d.p[1] - k * 0.6, d.p[2]];
    d.rare = src.rare;
    const rec = fromSnap(d, { pop: false, keepId: false });
    rec.popT = 0; rec.popT0 = 0; rec.flashT = 0;
    rec.holo.inner.scale.setScalar(0.01);
    fx?.spawn(rec.holo.root.position, rec.color, { size: worldSize(rec) });
    pushUndo({ kind: 'spawn', id: rec.id });
    emit('spawn', { id: rec.id, type: rec.type, color: rec.color, duplicate: true });
    return rec.id;
  }

  function clear() {
    if (!order.length) return;
    const datas = order.map(id => snap(recs.get(id)));
    pushUndo({ kind: 'clear', datas });
    let n = 0;
    for (const id of [...order]) destroy(recs.get(id), { fxRemove: n++ < 12 });
    emit('clear', {});
  }

  // ---------------------------------------------------------------- alchemy preview
  /** setPreview({sx, sy, sizePx, progress}) while growing; null on cancel/commit. */
  function setPreview(st) {
    if (!st) { if (preview && preview.fadeT == null) preview.fadeT = 0; return; }
    if (!preview || preview.fadeT != null) {
      if (preview) { preview.holo.dispose(); preview = null; }
      const type = resolveType(null), rare = Math.random() < (R.rareChance ?? 0.05);
      const color = rare ? (R.rareColor || '#ffd75e') : resolveColor(null);
      const holo = createHolo({ type, color, level: style.opacity, lineWidth: lw(), cfg: H });
      holo.mesh.scale.setScalar(shapeScale); holo.edges.scale.setScalar(shapeScale); holo.glints.scale.setScalar(shapeScale);
      holo.root.rotation.set(0.35, -0.5, 0);
      world.add(holo.root);
      preview = { holo, type, color, rare, level: style.opacity, scale: 0.01, progress: 0, fadeT: null, alpha: 0 };
    }
    preview.progress = clamp(st.progress ?? 0, 0, 1);
    const s = sizeToScale(st.sizePx);
    preview.scale = Math.max(0.01, s * (0.15 + 0.85 * easeOutCubic(preview.progress)));
    if (st.sx != null) stage.screenToWorld(st.sx, st.sy, 0, preview.holo.root.position);
  }

  // ---------------------------------------------------------------- serialization / undo
  function serialize() { return { v: 2, objects: order.map(id => snap(recs.get(id))) }; }
  function deserialize(data, { undoable = true } = {}) {
    const list = Array.isArray(data) ? data : data?.objects;
    if (!Array.isArray(list)) return 0;
    const prev = order.map(id => snap(recs.get(id)));
    for (const id of [...order]) destroy(recs.get(id), { shrink: false });
    const ids = [];
    for (const d of list) { if (d && shapes.includes(d.type)) ids.push(fromSnap(d).id); }
    if (undoable) pushUndo({ kind: 'restore', ids, prev });
    return ids.length;
  }
  const canUndo = () => undoStack.length > 0;
  function undo() {
    const e = undoStack.pop();
    if (!e) return false;
    switch (e.kind) {
      case 'spawn': { const rec = recs.get(e.id); if (rec) destroy(rec, { fxRemove: false }); break; }
      case 'remove': fromSnap(e.data); break;
      case 'clear': e.datas.forEach(d => fromSnap(d)); break;
      case 'transform': {
        const rec = recs.get(e.id); if (!rec) break;
        const r = rec.holo.root;
        r.position.fromArray(e.before.p); r.quaternion.fromArray(e.before.q); r.scale.setScalar(e.before.s);
        rec.spin.set(0, 0);
        break;
      }
      case 'style': { const rec = recs.get(e.id); if (rec) { applyStyle(rec, { color: e.before.color, opacity: e.before.opacity }); rec.rare = e.before.rare; } break; }
      case 'restore': {
        e.ids.forEach(id => { const rec = recs.get(id); if (rec) destroy(rec, { shrink: false }); });
        e.prev.forEach(d => fromSnap(d));
        break;
      }
    }
    emit('undo', { kind: e.kind });
    return true;
  }

  // ---------------------------------------------------------------- export
  function exportItems() {
    world.updateMatrixWorld(true);
    return order.map(id => {
      const rec = recs.get(id);
      const m = rec.holo.root.matrixWorld.clone().multiply(new THREE.Matrix4().makeScale(shapeScale, shapeScale, shapeScale));
      return { type: rec.type, color: rec.color, level: rec.level, matrixWorld: m, geometry: rec.holo.geometry, wirePositions: rec.holo.wirePositions };
    });
  }
  function exportMeshes(opts) { return buildExportGroup(exportItems(), { ...(R.export || {}), ...(opts || {}) }); }
  async function exportGLBBlob() {
    const g = exportMeshes();
    try { return new Blob([await exportGLB(g)], { type: 'model/gltf-binary' }); } finally { disposeExportGroup(g); }
  }
  async function exportUSDZBlob() {
    const g = exportMeshes();
    try { return new Blob([await exportUSDZ(g)], { type: 'model/vnd.usdz+zip' }); } finally { disposeExportGroup(g); }
  }

  // ---------------------------------------------------------------- per frame
  const _bufSize = new THREE.Vector2();
  function update(dt, nowMs) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    time += dt;
    HOLO_SHARED.uTime.value = time;
    // the buffer height the next render uses (a 縦 capture raises it, R2-11) — so line widths stay the same
    const bufH = stage.bufferHeight ? stage.bufferHeight() : stage.renderer.getDrawingBufferSize(_bufSize).y;
    HOLO_SHARED.uPxScale.value = bufH / (2 * Math.tan(THREE.MathUtils.degToRad(stage.camera.fov / 2)));
    const idleSpin = H.idleSpin ?? 0.15, bob = H.bob ?? 0.03, bobHz = H.bobHz ?? 0.22;
    const dec = Math.pow(decay, dt * 60);
    const glowLines = stage.getEffectiveQuality ? stage.getEffectiveQuality() === 'low' : false;
    const lwNow = lw();

    for (const id of order) {
      const rec = recs.get(id);
      const root = rec.holo.root, inner = rec.holo.inner;
      rec.holo.setGlowLines(glowLines);
      if (rec.lw !== lwNow) { rec.holo.setLineWidth(lwNow); rec.lw = lwNow; }
      // spin inertia (world axes)
      if (rec.spin.lengthSq() > 1e-6) {
        rotateWorld(root, rec.spin.x * dt, rec.spin.y * dt, 0);
        rec.spin.multiplyScalar(dec);
        if (rec.spin.lengthSq() < 1e-4) rec.spin.set(0, 0);
      }
      // idle motion only while untouched; bob lives on the inner child
      if (!rec.touched) rotateWorld(root, 0, idleSpin * dt, 0);
      rec.bobAmp += ((rec.touched ? 0 : 1) - rec.bobAmp) * (1 - Math.exp(-dt * 4));
      rec.bobWorld = Math.sin(time * bobHz * Math.PI * 2 + rec.bobPhase) * bob * rec.bobAmp;
      _qi.copy(root.quaternion).invert();
      inner.position.copy(AY).applyQuaternion(_qi).multiplyScalar(rec.bobWorld / Math.max(root.scale.x, 1e-3));
      // spawn pop
      if (rec.popT != null) {
        rec.popT += dt;
        const t = rec.popT0 + rec.popT * 5;
        inner.scale.setScalar(popScale(t));
        if (t >= 2.5) { rec.popT = null; inner.scale.setScalar(1); }
      }
      let flash = 0;
      if (rec.flashT != null) {
        rec.flashT += dt;
        flash = rec.flashT < 0.2 ? 8 * Math.exp(-31 * rec.flashT) : 0;
        if (rec.flashT >= 0.2) rec.flashT = null;
      }
      rec.holo.update(time, dt, { selected: id === selectedId, hover: id === hoverId && id !== selectedId, flash: Math.min(flash, 3) });
    }

    // removed objects shrink into particles
    const shrinkT = R.fx?.deleteShrink ?? 0.28;
    for (let i = dying.length - 1; i >= 0; i--) {
      const rec = dying[i];
      rec.dieT += dt;
      const k = Math.min(1, rec.dieT / shrinkT);
      rec.holo.inner.scale.setScalar(Math.max(0.001, rec.dieScale * (1 - k * k)));
      rec.holo.update(time, dt, { alpha: 1 - k * 0.5, flash: k < 0.3 ? 1.5 * (1 - k / 0.3) : 0 });
      if (k >= 1) { rec.holo.dispose(); dying.splice(i, 1); }
    }

    // alchemy preview: 40% opacity, reveal grows with progress
    if (preview) {
      const pv = preview;
      pv.holo.root.scale.setScalar(pv.scale);
      pv.holo.root.rotation.y += dt * 0.8;
      let a = (H.previewAlpha ?? 0.4) * (0.4 + 0.6 * pv.progress);
      if (pv.fadeT != null) {
        pv.fadeT += dt;
        a *= Math.max(0, 1 - pv.fadeT / 0.3);
        if (pv.fadeT >= 0.3) { pv.holo.dispose(); preview = null; }
      }
      if (preview) {
        const flick = 0.85 + 0.15 * Math.sin(time * 37.0);
        pv.holo.setGlowLines(glowLines);
        pv.holo.update(time, dt, { alpha: a * flick, reveal: 0.25 + 0.75 * pv.progress });
      }
    }

    // selection ring (billboarded, rotating dashes)
    const sel = selectedId != null ? recs.get(selectedId) : null;
    const target = sel ? 1 : 0;
    ring.alpha += (target - ring.alpha) * (1 - Math.exp(-dt * (sel ? 9 : 14)));
    if (sel) {
      const r = sel.holo.root;
      ring.pos.copy(r.position); ring.pos.y += sel.bobWorld || 0;
      ring.r = sel.holo.radius * shapeScale * r.scale.x * (R.select?.ringScale ?? 1.28) * Math.max(0.3, sel.holo.inner.scale.x);
      ring.color.set(sel.color);
    }
    selRing.visible = ring.alpha > 0.01;
    if (selRing.visible) {
      selRing.position.copy(ring.pos);
      selRing.quaternion.copy(stage.camera.quaternion);
      const pulse = 1 + 0.03 * Math.sin(time * 4);
      selRing.scale.setScalar(ring.r * (1.15 - 0.15 * ring.alpha) * pulse);
      ringDash.rotation.z = time * (R.select?.ringSpin ?? 0.6);
      ringTicks.rotation.z = -time * 0.3;
      const a = ring.alpha;
      ringDash.material.color.copy(ring.color).multiplyScalar(1.7); ringDash.material.opacity = a;
      ringThin.material.color.copy(ring.color).multiplyScalar(0.9); ringThin.material.opacity = a * 0.6;
      ringTicks.material.color.copy(ring.color).multiplyScalar(1.8); ringTicks.material.opacity = a;
    }
    void nowMs;
  }

  function get(id) {
    const rec = recs.get(id); if (!rec) return null;
    const r = rec.holo.root;
    return { id, type: rec.type, color: rec.color, opacity: rec.level, rare: rec.rare, touched: rec.touched, selected: id === selectedId, hover: id === hoverId, position: r.position.toArray(), quaternion: r.quaternion.toArray(), scale: r.scale.x, size: worldSize(rec), spinning: rec.spin.lengthSq() > 1e-4 };
  }

  function dispose() {
    for (const id of [...order]) destroy(recs.get(id), { shrink: false });
    dying.forEach(r => r.holo.dispose()); dying.length = 0;
    if (preview) { preview.holo.dispose(); preview = null; }
    [ringDash, ringThin, ringTicks].forEach(l => { l.geometry.dispose(); l.material.dispose(); });
    selRing.removeFromParent(); world.removeFromParent();
  }

  return {
    // SceneAPI
    pick, getScreenInfo, getSelected, select, setHover, beginTransform, endTransform,
    setGrabPose, moveScreen, setDepth, rotateBy, setSpin, scaleBy, setStyle, getStyle, remove, duplicate, spawn,
    // lifecycle
    update, count: () => order.length, list: () => [...order], get,
    serialize, deserialize, clear, undo, canUndo,
    exportMeshes, exportGLB: exportGLBBlob, exportUSDZ: exportUSDZBlob,
    setPreview, hasPreview: () => !!preview && preview.fadeT == null,
    getHover: () => hoverId, dispose,
  };
}
