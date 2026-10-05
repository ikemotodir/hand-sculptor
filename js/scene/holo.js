// Hologram look: shape geometry, designed wires, face/edge/glint materials.
// Faces: fresnel rim + moving scanlines + sweep band + tiny flicker (NormalBlending, depthWrite off).
// Edges: fat lines (LineSegments2 + LineMaterial, width in CSS px), additive, HDR → bloom.
// Glints: additive twinkling points on corners / wire crossings.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'octa', 'pyramid', 'icosa', 'star', 'heart'];

/** Uniforms shared by every hologram (updated once per frame by objects.update). */
export const HOLO_SHARED = {
  uTime: { value: 0 },
  uPxScale: { value: 600 },       // drawing-buffer px per world unit at distance 1
};

// ---------------------------------------------------------------- geometry
function heartShape() {
  const s = new THREE.Shape();
  // classic bezier heart (tip down after flip), 22×19 units → scaled below
  s.moveTo(5, 5);
  s.bezierCurveTo(5, 5, 4, 0, 0, 0);
  s.bezierCurveTo(-6, 0, -6, 7, -6, 7);
  s.bezierCurveTo(-6, 11, -3, 15.4, 5, 19);
  s.bezierCurveTo(12, 15.4, 16, 11, 16, 7);
  s.bezierCurveTo(16, 7, 16, 0, 10, 0);
  s.bezierCurveTo(7, 0, 5, 5, 5, 5);
  return s;
}
function starShape(outer = 0.9, inner = 0.4, n = 5) {
  const s = new THREE.Shape();
  for (let i = 0; i <= n * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  return s;
}

export function makeShapeGeometry(type) {
  let g;
  switch (type) {
    case 'sphere': g = new THREE.SphereGeometry(0.8, 48, 32); break;
    case 'cylinder': g = new THREE.CylinderGeometry(0.62, 0.62, 1.45, 48, 1); break;
    case 'cone': g = new THREE.ConeGeometry(0.78, 1.55, 48, 1); break;
    case 'torus': g = new THREE.TorusGeometry(0.6, 0.24, 32, 96); break;
    case 'octa': g = new THREE.OctahedronGeometry(0.95, 0); break;
    case 'pyramid': g = new THREE.ConeGeometry(0.95, 1.35, 4, 1); g.rotateY(Math.PI / 4); g.translate(0, -0.1, 0); break;
    case 'icosa': g = new THREE.IcosahedronGeometry(0.9, 0); break;
    case 'star': g = new THREE.ExtrudeGeometry(starShape(0.95, 0.42), { depth: 0.34, bevelEnabled: false }); g.translate(0, 0, -0.17); break;
    case 'heart': {
      g = new THREE.ExtrudeGeometry(heartShape(), { depth: 5.2, bevelEnabled: false, curveSegments: 28 });
      // flip Y and Z together (= 180° about X, det > 0): tip-down heart, same outline as the wires,
      // winding stays consistent with the normals so exported GLB/USDZ hearts face outward (R2-22)
      g.translate(-5, -9.5, -2.6); g.scale(0.075, -0.075, -0.075);
      break;
    }
    case 'box':
    default: g = new THREE.BoxGeometry(1.25, 1.25, 1.25); break;
  }
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------- designed wires
function circleSegs(out, n, fn) {
  let prev = fn(0);
  for (let i = 1; i <= n; i++) {
    const p = fn(i / n);
    out.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
    prev = p;
  }
}
const TAU = Math.PI * 2;

function edgesOf(geo, angle = 20) {
  const e = new THREE.EdgesGeometry(geo, angle);
  const arr = Array.from(e.attributes.position.array);
  e.dispose();
  return arr;
}

function outlineSegs(points, z, out) {
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    out.push(a.x, a.y, z, b.x, b.y, z);
  }
}

/** Returns { wires: number[] (segment pairs), glints: number[] (xyz) } in shape-local units. */
export function makeWires(type, geo) {
  const w = [], gl = [];
  switch (type) {
    case 'sphere': {
      const r = 0.8;
      for (const lat of [-60, -30, 0, 30, 60]) {
        const phi = THREE.MathUtils.degToRad(lat), rr = r * Math.cos(phi), y = r * Math.sin(phi);
        circleSegs(w, 64, t => [Math.cos(t * TAU) * rr, y, Math.sin(t * TAU) * rr]);
      }
      for (let k = 0; k < 8; k++) {
        const th = (k / 8) * TAU;
        circleSegs(w, 32, t => { const p = -Math.PI / 2 + t * Math.PI; return [Math.cos(p) * Math.cos(th) * r, Math.sin(p) * r, Math.cos(p) * Math.sin(th) * r]; });
        gl.push(Math.cos(th) * r, 0, Math.sin(th) * r);
      }
      gl.push(0, r, 0, 0, -r, 0);
      break;
    }
    case 'cylinder': {
      const r = 0.62, h = 1.45;
      for (const y of [-h / 2, -h / 4, 0, h / 4, h / 2]) circleSegs(w, 64, t => [Math.cos(t * TAU) * r, y, Math.sin(t * TAU) * r]);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU, x = Math.cos(a) * r, z = Math.sin(a) * r;
        w.push(x, -h / 2, z, x, h / 2, z);
        gl.push(x, h / 2, z, x, -h / 2, z);
      }
      break;
    }
    case 'cone': {
      const r = 0.78, h = 1.55;
      for (const f of [0, 1 / 3, 2 / 3]) {
        const rr = r * (1 - f), y = -h / 2 + h * f;
        circleSegs(w, 64, t => [Math.cos(t * TAU) * rr, y, Math.sin(t * TAU) * rr]);
      }
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU, x = Math.cos(a) * r, z = Math.sin(a) * r;
        w.push(x, -h / 2, z, 0, h / 2, 0);
        gl.push(x, -h / 2, z);
      }
      gl.push(0, h / 2, 0);
      break;
    }
    case 'torus': {
      const R = 0.6, r = 0.24;
      for (let k = 0; k < 12; k++) {
        const u = (k / 12) * TAU;
        circleSegs(w, 24, t => { const v = t * TAU; return [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]; });
        gl.push((R + r) * Math.cos(u), (R + r) * Math.sin(u), 0);
      }
      circleSegs(w, 96, t => [(R + r) * Math.cos(t * TAU), (R + r) * Math.sin(t * TAU), 0]);
      circleSegs(w, 96, t => [(R - r) * Math.cos(t * TAU), (R - r) * Math.sin(t * TAU), 0]);
      circleSegs(w, 96, t => [R * Math.cos(t * TAU), R * Math.sin(t * TAU), r]);
      break;
    }
    case 'heart': {
      const pts = heartShape().getSpacedPoints(96).slice(0, -1).map(p => new THREE.Vector2((p.x - 5) * 0.075, -(p.y - 9.5) * 0.075));
      const z0 = -2.6 * 0.075, z1 = 2.6 * 0.075;
      outlineSegs(pts, z0, w); outlineSegs(pts, z1, w);
      for (let k = 0; k < 12; k++) { const p = pts[Math.round((k / 12) * pts.length) % pts.length]; w.push(p.x, p.y, z0, p.x, p.y, z1); gl.push(p.x, p.y, z1); }
      break;
    }
    default: {   // polyhedra & star: real edges
      const arr = edgesOf(geo, 20);
      w.push(...arr);
      const seen = new Set();
      for (let i = 0; i < arr.length; i += 3) {
        const key = `${arr[i].toFixed(3)},${arr[i + 1].toFixed(3)},${arr[i + 2].toFixed(3)}`;
        if (seen.has(key)) continue; seen.add(key); gl.push(arr[i], arr[i + 1], arr[i + 2]);
      }
    }
  }
  return { wires: w, glints: gl };
}

// ---------------------------------------------------------------- cache (shared per shape type)
const CACHE = new Map();
export function getShapeAssets(type) {
  if (!SHAPES.includes(type)) type = 'box';
  let a = CACHE.get(type);
  if (a) return a;
  const geometry = makeShapeGeometry(type);
  const { wires, glints } = makeWires(type, geometry);
  const lineGeo = new LineSegmentsGeometry().setPositions(wires);
  new LineSegments2(lineGeo).computeLineDistances();   // dash attributes (used only to drop end caps)
  const glintGeo = new THREE.BufferGeometry();
  glintGeo.setAttribute('position', new THREE.Float32BufferAttribute(glints, 3));
  const ph = new Float32Array(glints.length / 3).map(() => Math.random());
  glintGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(ph, 1));
  const radius = geometry.boundingSphere.radius;
  a = { type, geometry, lineGeo, glintGeo, wirePositions: new Float32Array(wires), radius };
  CACHE.set(type, a);
  return a;
}
export function disposeShapeCache() {
  for (const a of CACHE.values()) { a.geometry.dispose(); a.lineGeo.dispose(); a.glintGeo.dispose(); }
  CACHE.clear();
}

// ---------------------------------------------------------------- materials
const FACE_VS = /* glsl */`
  varying vec3 vN; varying vec3 vW; varying vec3 vL;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz; vL = position;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const FACE_FS = /* glsl */`
  uniform vec3 uColor; uniform float uAlpha, uFlash, uHi, uSeed, uReveal, uRim, uFresPow, uScanD, uScanS, uTime, uRadius;
  varying vec3 vN; varying vec3 vW; varying vec3 vL;
  void main() {
    // materialize (preview): reveal bottom → top with a bright front
    float yN = vL.y / uRadius * 0.5 + 0.5;
    float front = uReveal * 1.15 - 0.05;
    if (yN > front) discard;
    float edgeGlow = smoothstep(0.08, 0.0, front - yN) * step(uReveal, 0.999);

    vec3 V = normalize(cameraPosition - vW);
    float ndv = abs(dot(normalize(vN), V));
    float fres = pow(1.0 - ndv, uFresPow);
    float sl = 0.5 + 0.5 * sin((vW.y * uScanD - uTime * uScanS) * 6.2831853);
    sl = smoothstep(0.15, 1.0, sl);
    float bandPos = fract(uTime * 0.16 + uSeed);
    float band = smoothstep(0.10, 0.0, abs(yN - bandPos));
    float flick = 0.94 + 0.06 * fract(sin(floor(uTime * 18.0) * 12.9898 + uSeed * 78.233) * 43758.5453);

    float a = uAlpha * (0.55 + 0.45 * sl) + fres * uRim * (0.10 + uAlpha * 1.0) + band * 0.08 + edgeGlow * 0.6;
    a = a * flick + uFlash * 0.25 + uHi * 0.04;
    vec3 col = uColor * (0.85 + fres * 0.9 + band * 0.7) + uColor * uFlash * 0.6 + vec3(edgeGlow * 0.8 + uFlash * 0.12);
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
    #include <colorspace_fragment>
  }`;

const GLINT_VS = /* glsl */`
  attribute float aPhase;
  uniform float uSize, uTime, uPxScale;
  varying float vTw;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float tw = 0.55 + 0.45 * sin(uTime * (1.6 + aPhase * 2.2) + aPhase * 40.0);
    vTw = tw;
    float sc = length(modelMatrix[0].xyz);
    gl_PointSize = max(1.5, uSize * sc * uPxScale / -mv.z * (0.75 + 0.5 * tw));
    gl_Position = projectionMatrix * mv;
  }`;
const GLINT_FS = /* glsl */`
  uniform vec3 uColor; uniform float uAlpha;
  varying float vTw;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p);
    float core = exp(-d * d * 90.0);
    float halo = exp(-d * d * 18.0) * 0.35;
    float cross = (exp(-abs(p.x) * 60.0) * exp(-abs(p.y) * 7.0) + exp(-abs(p.y) * 60.0) * exp(-abs(p.x) * 7.0)) * 0.6;
    float v = (core + halo + cross) * vTw * uAlpha;
    if (v < 0.003) discard;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), core * 0.6) * v, v);
    #include <colorspace_fragment>
  }`;

const _white = new THREE.Color(1, 1, 1);

// Additive fat lines double up where round end caps overlap (beaded look on circles).
// LineMaterial discards end caps when USE_DASH is on, so enable dashing with one endless dash.
const NO_CAPS = { dashed: true, dashSize: 1e9, gapSize: 0 };

/**
 * Create one hologram.
 * @param {{type:string, color:string|THREE.Color, level?:number, lineWidth?:number, cfg?:object}} o
 * cfg = RENDER.holo
 */
export function createHolo({ type, color, level = 0.2, lineWidth = 2, cfg = {} }) {
  const assets = getShapeAssets(type);
  const C = {
    faceMul: 0.35, edgeIntensity: 1.6, edgeWhite: 0.22, fresnelPower: 2.4, rim: 0.9,
    scanDensity: 9, scanSpeed: 0.6, glintSize: 0.16, ...cfg,
  };
  const base = new THREE.Color(color);

  const root = new THREE.Group();     // stored transform (position / quaternion / scale)
  const inner = new THREE.Group();    // idle bob + spawn pop (never serialized)
  root.add(inner);

  const faceMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: base.clone() }, uAlpha: { value: level * C.faceMul },
      uFlash: { value: 0 }, uHi: { value: 0 }, uSeed: { value: Math.random() }, uReveal: { value: 1 },
      uRim: { value: C.rim }, uFresPow: { value: C.fresnelPower }, uScanD: { value: C.scanDensity }, uScanS: { value: C.scanSpeed },
      uRadius: { value: assets.radius },
      uTime: HOLO_SHARED.uTime,
    },
    vertexShader: FACE_VS, fragmentShader: FACE_FS,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(assets.geometry, faceMat);
  mesh.renderOrder = 1;

  const edgeMat = new LineMaterial({
    color: 0xffffff, linewidth: lineWidth, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 1, worldUnits: false, ...NO_CAPS,
  });
  const edges = new LineSegments2(assets.lineGeo, edgeMat);
  edges.renderOrder = 2;
  edges.frustumCulled = false;

  const glintMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: base.clone() }, uAlpha: { value: 1 }, uSize: { value: C.glintSize },
      uTime: HOLO_SHARED.uTime, uPxScale: HOLO_SHARED.uPxScale,
    },
    vertexShader: GLINT_VS, fragmentShader: GLINT_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const glints = new THREE.Points(assets.glintGeo, glintMat);
  glints.renderOrder = 3;

  // soft halo line under the core edge, only used when bloom is off (quality 低 / mobile)
  const haloMat = new LineMaterial({
    color: 0xffffff, linewidth: lineWidth * 4, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0.16, worldUnits: false, ...NO_CAPS,
  });
  const halo = new LineSegments2(assets.lineGeo, haloMat);
  halo.renderOrder = 1;
  halo.frustumCulled = false;
  halo.visible = false;

  inner.add(mesh, halo, edges, glints);

  let level_ = level;
  const tmp = new THREE.Color();
  const st = { selected: 0, hover: 0 };   // eased 0..1

  // bright colors (white / yellow / mint) glow much more than blue / red at the same value →
  // normalise by luminance so every palette color reads at a similar strength
  let lumK = 1;
  function setColor(c) {
    base.set(c);
    const luma = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
    lumK = 1.15 - 0.5 * luma;
    faceMat.uniforms.uColor.value.copy(base).multiplyScalar(lumK);
    glintMat.uniforms.uColor.value.copy(base).multiplyScalar(lumK);
  }
  setColor(color);
  function setLevel(l) { level_ = l; }

  /**
   * @param {number} t   seconds (shared clock)
   * @param {number} dt
   * @param {{selected?:boolean, hover?:boolean, flash?:number, alpha?:number, reveal?:number}} s
   */
  function update(t, dt, s = {}) {
    const k = 1 - Math.exp(-dt * 10);
    st.selected += ((s.selected ? 1 : 0) - st.selected) * k;
    st.hover += ((s.hover ? 1 : 0) - st.hover) * k;
    const alpha = s.alpha ?? 1;
    const flash = s.flash ?? 0;
    const breathe = 0.88 + 0.12 * Math.sin(t * 2.1 + faceMat.uniforms.uSeed.value * 6.28);
    const selPulse = st.selected * (0.35 + 0.25 * Math.sin(t * 4.2));
    const inten = C.edgeIntensity * lumK * (breathe + selPulse) * alpha + flash * 0.35;
    tmp.copy(base).lerp(_white, C.edgeWhite + st.hover * (0.85 - C.edgeWhite));
    edgeMat.color.copy(tmp).multiplyScalar(inten);
    edgeMat.opacity = 1;
    if (halo.visible) { haloMat.color.copy(base).multiplyScalar(lumK * (0.8 + selPulse)); haloMat.opacity = 0.2 * alpha; }
    faceMat.uniforms.uAlpha.value = level_ * C.faceMul * alpha * (1 + st.selected * 0.35);
    faceMat.uniforms.uFlash.value = flash;
    faceMat.uniforms.uHi.value = st.hover;
    faceMat.uniforms.uReveal.value = s.reveal ?? 1;
    glintMat.uniforms.uAlpha.value = alpha * (0.85 + st.selected * 0.6 + flash * 0.5);
  }

  function setLineWidth(px) { edgeMat.linewidth = px; haloMat.linewidth = px * 4; }
  function setGlowLines(on) { halo.visible = !!on; }

  function dispose() {
    root.removeFromParent();
    faceMat.dispose(); edgeMat.dispose(); haloMat.dispose(); glintMat.dispose();
    // geometries are shared per shape type (see getShapeAssets) — not disposed here
  }

  return {
    type: assets.type, root, inner, mesh, edges, halo, glints, radius: assets.radius,
    geometry: assets.geometry, wirePositions: assets.wirePositions,
    get color() { return base; }, get level() { return level_; },
    setColor, setLevel, setLineWidth, setGlowLines, update, dispose,
  };
}

// ---------------------------------------------------------------- small helpers for rings / sigils
/** Circle (or dashed circle) as segment positions in the XY plane. */
export function ringPositions(radius, n = 96, dashed = false, dashFrac = 0.55) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU, a1 = ((i + (dashed ? dashFrac : 1)) / n) * TAU;
    out.push(Math.cos(a0) * radius, Math.sin(a0) * radius, 0, Math.cos(a1) * radius, Math.sin(a1) * radius, 0);
  }
  return out;
}

export function makeFatLines(positions, { color = 0xffffff, width = 2, opacity = 1, dashed = false, dashSize = 0.1, gapSize = 0.1 } = {}) {
  const geo = new LineSegmentsGeometry().setPositions(positions);
  const mat = new LineMaterial({
    color, linewidth: width, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity,
    worldUnits: false, ...(dashed ? { dashed, dashSize, gapSize } : NO_CAPS),
  });
  const line = new LineSegments2(geo, mat);
  line.computeLineDistances();
  line.frustumCulled = false;
  return line;
}

/** Soft radial dot texture (no DOM): used by particles and glow sprites. */
let _dotTex = null;
export function dotTexture() {
  if (_dotTex) return _dotTex;
  const N = 64, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (x + 0.5) / N - 0.5, dy = (y + 0.5) / N - 0.5;
    const d = Math.sqrt(dx * dx + dy * dy) * 2;
    const v = Math.max(0, Math.exp(-d * d * 5) - 0.0067);
    const i = (y * N + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = Math.round(v * 255);
  }
  _dotTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  _dotTex.needsUpdate = true;
  _dotTex.magFilter = THREE.LinearFilter; _dotTex.minFilter = THREE.LinearFilter;
  return _dotTex;
}
