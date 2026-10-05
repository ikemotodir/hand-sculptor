// Throwaway export scene (SPEC §13.5): solid emissive meshes + plain LineSegments from the
// designed wires. No LineSegments2 / Points / fx. GLB via GLTFExporter; USDZ via a tiny built-in
// writer (no USDZExporter / fflate needed).
import * as THREE from 'three';

/**
 * @param {Array<{type:string, color:string, level:number, matrixWorld:THREE.Matrix4, geometry:THREE.BufferGeometry, wirePositions:Float32Array}>} items
 * @param {{scale?:number, opacity?:number, emissive?:number, center?:boolean}} opts
 * @returns {THREE.Group}
 */
export function buildExportGroup(items, { scale = 0.1, opacity = 0.55, emissive = 0.8, center = true } = {}) {
  const group = new THREE.Group();
  group.name = 'HandSculptor';
  const box = new THREE.Box3();
  items.forEach((it, i) => {
    const color = new THREE.Color(it.color);
    const holder = new THREE.Group();
    holder.name = `${it.type}_${i + 1}`;
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(it.matrixWorld);
    holder.matrix.decompose(holder.position, holder.quaternion, holder.scale);
    holder.matrixAutoUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: emissive, roughness: 0.35, metalness: 0.1,
      transparent: true, opacity: Math.min(1, Math.max(0.25, opacity + (it.level ?? 0.2) * 0.5)), side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(it.geometry.clone(), mat);
    mesh.name = `${it.type}_${i + 1}_body`;
    holder.add(mesh);
    if (it.wirePositions?.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(it.wirePositions), 3));
      const lines = new THREE.LineSegments(lg, new THREE.MeshBasicMaterial({ color }));   // Basic → glTF unlit, no exporter warning
      lines.name = `${it.type}_${i + 1}_wire`;
      holder.add(lines);
    }
    group.add(holder);
    holder.updateMatrixWorld(true);
    box.expandByObject(mesh);
  });
  if (center && items.length) {
    // center X/Z, put the lowest point on y = 0 (AR places the model on the floor/table)
    const c = box.getCenter(new THREE.Vector3());
    group.children.forEach(h => { h.position.x -= c.x; h.position.y -= box.min.y; h.position.z -= c.z; });
  }
  group.scale.setScalar(scale);
  group.updateMatrixWorld(true);
  return group;
}

/** Dispose a group made by buildExportGroup. */
export function disposeExportGroup(group) {
  group.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
}

/** @returns {Promise<ArrayBuffer>} binary glTF */
export async function exportGLB(group) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();
  return exporter.parseAsync(group, { binary: true, onlyVisible: true });
}

// ------------------------------------------------------------------ USDZ (minimal, meshes only)
const f = n => (Number.isFinite(n) ? +n.toFixed(4) : 0);
const col3 = c => `(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`;

function meshToUsda(mesh, name, matPath, indent) {
  const g = mesh.geometry;
  const pos = g.attributes.position, nor = g.attributes.normal;
  const m = new THREE.Matrix4();
  mesh.updateWorldMatrix(true, false);
  m.copy(mesh.matrixWorld);
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const pts = [], nrm = [], counts = [], idx = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    pts.push(`(${f(v.x)}, ${f(v.y)}, ${f(v.z)})`);
    if (nor) { n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); nrm.push(`(${f(n.x)}, ${f(n.y)}, ${f(n.z)})`); }
  }
  if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i));
  else for (let i = 0; i < pos.count; i++) idx.push(i);
  for (let i = 0; i < idx.length / 3; i++) counts.push(3);
  const I = indent;
  return `${I}def Mesh "${name}" (\n${I}    prepend apiSchemas = ["MaterialBindingAPI"]\n${I})\n${I}{\n` +
    `${I}    int[] faceVertexCounts = [${counts.join(', ')}]\n` +
    `${I}    int[] faceVertexIndices = [${idx.join(', ')}]\n` +
    `${I}    rel material:binding = <${matPath}>\n` +
    (nrm.length ? `${I}    normal3f[] normals = [${nrm.join(', ')}] (\n${I}        interpolation = "vertex"\n${I}    )\n` : '') +
    `${I}    point3f[] points = [${pts.join(', ')}]\n` +
    `${I}    uniform token subdivisionScheme = "none"\n` +
    `${I}    uniform bool doubleSided = 1\n${I}}\n`;
}

function buildUsda(group) {
  group.updateMatrixWorld(true);
  const meshes = [];
  group.traverse(o => { if (o.isMesh) meshes.push(o); });
  let mats = '', geo = '';
  meshes.forEach((mesh, i) => {
    const mat = mesh.material;
    const mp = `/Root/Materials/M${i}`;
    mats += `        def Material "M${i}"\n        {\n` +
      `            token outputs:surface.connect = <${mp}/Surface.outputs:surface>\n` +
      `            def Shader "Surface"\n            {\n` +
      `                uniform token info:id = "UsdPreviewSurface"\n` +
      `                color3f inputs:diffuseColor = ${col3(mat.color)}\n` +
      `                color3f inputs:emissiveColor = ${col3(mat.emissive.clone().multiplyScalar(mat.emissiveIntensity ?? 1))}\n` +
      `                float inputs:metallic = ${f(mat.metalness ?? 0)}\n` +
      `                float inputs:roughness = ${f(mat.roughness ?? 0.5)}\n` +
      `                float inputs:opacity = ${f(mat.opacity ?? 1)}\n` +
      `                token outputs:surface\n            }\n        }\n`;
    geo += meshToUsda(mesh, `Obj${i}`, mp, '        ');
  });
  return `#usda 1.0\n(\n    customLayerData = {\n        string creator = "HAND SCULPTOR"\n    }\n    defaultPrim = "Root"\n    metersPerUnit = 1\n    upAxis = "Y"\n)\n\n` +
    `def Xform "Root" (\n    kind = "component"\n)\n{\n` +
    `    def Scope "Materials"\n    {\n${mats}    }\n\n` +
    `    def Xform "Geom"\n    {\n${geo}    }\n}\n`;
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Store-only zip with every file's data 64-byte aligned (USDZ requirement). */
export function zipStore64(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameB = enc.encode(name);
    const crc = crc32(data);
    const headerLen = 30 + nameB.length;
    let pad = (64 - ((offset + headerLen + 4) % 64)) % 64;   // extra field: 4-byte header + padding
    const extraLen = 4 + pad;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, nameB.length, true); h.setUint16(28, extraLen, true);
    const extra = new DataView(new ArrayBuffer(extraLen));
    extra.setUint16(0, 0x1986, true); extra.setUint16(2, pad, true);
    parts.push(new Uint8Array(h.buffer), nameB, new Uint8Array(extra.buffer), data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0, true); c.setUint16(10, 0, true);
    c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nameB.length, true);
    c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nameB);
    offset += headerLen + extraLen + data.length;
  }
  const cdStart = offset;
  const cdLen = central.reduce((s, b) => s + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdLen, true); e.setUint32(16, cdStart, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let p = 0; for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

/** @returns {Promise<Uint8Array>} USDZ bytes (for AR Quick Look on iOS) */
export async function exportUSDZ(group) {
  const usda = new TextEncoder().encode(buildUsda(group));
  return zipStore64([['model.usda', usda]]);
}
