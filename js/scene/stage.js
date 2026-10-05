// Renderer, camera, video background compositing, bloom, resize, frame sync.
// Pipeline (r186 built-in effects path, SPEC §13.5):
//   scene (holograms + fx only, cleared to black) → MSAA HalfFloat target
//   → UnrealBloomPass (adds glow in place) → videoCompositePass (camera image + holo)
//   → renderer's own output step (sRGB OETF). The video never blooms.
// Image quality (2026-10-05): the camera image is always drawn at the full device pixel ratio (cap 2). 低 / the auto
// drop save GPU time on the holograms only (no bloom, no MSAA), never by lowering the camera resolution.
// くっきり (setClarity): a light halo-free unsharp mask + slight contrast/saturation lift for cheap webcams.
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const BLOOM_LAYER = 1;

const CompositeShader = {
  name: 'HSVideoComposite',
  uniforms: {
    tDiffuse: { value: null },
    tVideo: { value: null },
    uHasVideo: { value: 0 },
    uVideoAspect: { value: 16 / 9 },
    uViewAspect: { value: 16 / 9 },
    uMirror: { value: 1 },
    uOcclusion: { value: 0.45 },
    uTexel: { value: null },        // 1 / camera texture size (sharpen taps)
    uSharp: { value: 0 },           // くっきり: unsharp amount (0 = off)
    uContrast: { value: 1 },
    uSat: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tVideo;
    uniform float uHasVideo, uVideoAspect, uViewAspect, uMirror, uOcclusion, uSharp, uContrast, uSat;
    uniform vec2 uTexel;
    varying vec2 vUv;
    // くっきり: 5-tap unsharp mask in the camera's own (sRGB-encoded) values, clamped to the local min/max so an
    // edge gets steeper but never overshoots (no bright/dark halo), then a very slight contrast + saturation lift.
    vec3 clarity(vec2 uv, vec3 c) {
      vec3 n = texture2D(tVideo, uv + vec2(0.0, uTexel.y)).rgb;
      vec3 s = texture2D(tVideo, uv - vec2(0.0, uTexel.y)).rgb;
      vec3 e = texture2D(tVideo, uv + vec2(uTexel.x, 0.0)).rgb;
      vec3 w = texture2D(tVideo, uv - vec2(uTexel.x, 0.0)).rgb;
      vec3 lo = min(c, min(min(n, s), min(e, w)));
      vec3 hi = max(c, max(max(n, s), max(e, w)));
      c = clamp(c + uSharp * (c - 0.25 * (n + s + e + w)), lo, hi);
      c = (c - 0.5) * uContrast + 0.5;
      float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
      return clamp(mix(vec3(y), c, uSat), 0.0, 1.0);
    }
    void main() {
      vec4 holo = texture2D(tDiffuse, vUv);
      vec3 bg = vec3(0.0);
      if (uHasVideo > 0.5) {
        // object-fit: cover — identical math to core/mapping.js
        vec2 uv = vUv;
        if (uViewAspect > uVideoAspect) uv.y = 0.5 + (uv.y - 0.5) * (uVideoAspect / uViewAspect);
        else uv.x = 0.5 + (uv.x - 0.5) * (uViewAspect / uVideoAspect);
        if (uMirror > 0.5) uv.x = 1.0 - uv.x;
        uv.y = 1.0 - uv.y;                       // textures are uploaded with flipY = false
        vec4 cam = texture2D(tVideo, uv);
        if (uSharp > 0.0) cam.rgb = clarity(uv, cam.rgb);
        bg = sRGBTransferEOTF(cam).rgb;
      }
      float occ = clamp(holo.a, 0.0, 1.0) * uOcclusion;
      gl_FragColor = vec4(bg * (1.0 - occ) + holo.rgb, 1.0);
      #ifdef ENCODE_SRGB
        gl_FragColor = sRGBTransferOETF(gl_FragColor);   // composer fallback: last pass, no OutputPass
      #endif
    }`,
};

function detectMobile() {
  try {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return coarse || /iPhone|iPad|Android|Mobile/i.test(ua);
  } catch { return false; }
}

/**
 * Bloom buffer size (R3-14). UnrealBloomPass blurs in texels, so a capture-raised buffer (縦: ~2x) would halve
 * the glow. Keep it at the on-screen size: db = drawing buffer, k = capDpr / baseDpr.
 */
export function bloomSize(dbW, dbH, capDpr, baseDpr) {
  const k = baseDpr > 0 ? capDpr / baseDpr : 1;
  if (!(k > 1.001)) return [dbW, dbH];
  return [Math.max(1, Math.round(dbW / k)), Math.max(1, Math.round(dbH / k))];
}

/**
 * Pixel ratio of the drawing buffer (camera image + holograms): the device pixel ratio, capped (desktop 2, mobile
 * pixelRatio.mobile). Quality (低 / auto drop) never lowers it — the camera image must stay at full resolution.
 */
export function basePixelRatio(dpr, mobile, pr = {}) {
  return Math.min(dpr || 1, mobile ? (pr.mobile ?? 1.5) : (pr.high ?? 2));
}

/**
 * One render's step of the auto-quality fps sample (R3-15). Only visible, continuous rendering counts:
 * a hidden page (s.hidden, set on visibilitychange) or a render gap > maxGapMs restarts the sample.
 * → { sample, fps } (fps only when the sample finished; sample null then).
 */
export function autoQualityStep(s, now, aq = {}) {
  if (!s) return { sample: null };
  const gap = aq.maxGapMs ?? 1000;
  if (s.hidden || (s.last != null && now - s.last > gap)) return { sample: { t0: now, frames: 0, last: now } };
  const n = { ...s, frames: s.frames + 1, last: now };
  const el = now - n.t0;
  if (el >= (aq.sampleMs ?? 4000)) return { sample: null, fps: n.frames * 1000 / el };
  return { sample: n };
}

/**
 * @param {{canvas:HTMLCanvasElement, video?:HTMLVideoElement, config:object, mobile?:boolean}} o
 */
export function createStage({ canvas, video = null, config, mobile, forcePipeline = null }) {
  const R = config?.render || config || {};
  const isMobile = mobile ?? detectMobile();

  // --- context: WebGL2 is required (support check in index.html). HalfFloat RTs need
  //     EXT_color_buffer_float (or _half_float). If missing → composer fallback.
  const attrs = { antialias: true, alpha: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
  const gl = canvas.getContext('webgl2', attrs);
  const halfFloatOk = forcePipeline !== 'composer' && !!gl && !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));

  let renderer;
  const rOpts = { canvas, context: gl || undefined, antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
  if (halfFloatOk) rOpts.outputBufferType = THREE.HalfFloatType;
  renderer = new THREE.WebGLRenderer(rOpts);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  const useEffects = halfFloatOk && typeof renderer.setEffects === 'function';
  const pipeline = useEffects ? 'effects' : 'composer';

  const scene = new THREE.Scene();
  scene.background = null;
  const camera = new THREE.PerspectiveCamera(R.camera?.fov ?? 50, 16 / 9, 0.1, 100);
  camera.position.set(0, 0, R.camera?.z ?? 10);
  camera.lookAt(0, 0, 0);
  camera.layers.enable(BLOOM_LAYER);

  // --- passes
  const bloomCfg = R.bloom || { strength: 0.85, radius: 0.55, threshold: 0 };
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), bloomCfg.strength, bloomCfg.radius, bloomCfg.threshold);
  const compositePass = new ShaderPass(CompositeShader);
  const cu = compositePass.uniforms;
  cu.uOcclusion.value = R.composite?.occlusion ?? 0.45;
  cu.uTexel.value = new THREE.Vector2(1 / 1280, 1 / 720);
  let clarityOn = false;
  function setClarity(on) {
    clarityOn = !!on;
    const C = R.composite || {};
    cu.uSharp.value = clarityOn ? (C.sharpen ?? 0.6) : 0;
    cu.uContrast.value = clarityOn ? (C.contrast ?? 1.04) : 1;
    cu.uSat.value = clarityOn ? (C.saturation ?? 1.06) : 1;
  }
  setClarity(R.composite?.clarity !== false);

  // 低 = no MSAA (R 2026-10-05). The built-in effects path keeps its multisampled scene target private: it is the
  // one target three binds with samples > 0 + a depth buffer during a render; found on the first render, then its
  // sample count follows the quality (dispose → three re-creates it with the new count on its next use).
  let sceneRT = null, probing = false;
  if (useEffects) {
    const setRT = renderer.setRenderTarget;
    renderer.setRenderTarget = function (t, ...rest) {
      if (probing && !sceneRT && t && t.samples > 0 && t.depthBuffer && t.texture?.type === THREE.HalfFloatType) { sceneRT = t; probing = false; queueMicrotask(applyMsaa); }
      return setRT.call(this, t, ...rest);
    };
  }
  function applyMsaa() {
    if (!sceneRT) return;
    const want = (quality === 'low' || autoDropped) ? 0 : 4;   // mobile 'auto' (no bloom) keeps MSAA for its lines
    if (sceneRT.samples !== want) { sceneRT.samples = want; sceneRT.dispose(); }
  }

  // composer fallback (only when the built-in effects path is unavailable)
  let composer = null;
  async function buildComposer() {
    const [{ EffectComposer }, { RenderPass }] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
    ]);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.UnsignedByteType, samples: 4 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(bloomPass);
    // composite is the last pass and encodes sRGB itself, so the camera image never passes
    // through an 8-bit linear buffer (that would band dark tones beyond ±3/255)
    compositePass.material.defines.ENCODE_SRGB = '';
    compositePass.material.needsUpdate = true;
    composer.addPass(compositePass);
    applyQuality();
    resize(W, H, dpr);
  }

  // --- background sources
  let videoTex = null;           // live VideoTexture fallback
  let frameTex = null;           // texture fed by setFrame
  let frameTexW = 0, frameTexH = 0;
  let curFrame = null, pendingFrame = null;
  let lastFrameAt = -1e9;
  let vw = 0, vh = 0;
  let mirror = true;

  function makeVideoTexture() {
    if (!video || videoTex) return;
    videoTex = new THREE.VideoTexture(video);
    prepTex(videoTex);
  }
  function prepTex(t) {
    t.colorSpace = THREE.NoColorSpace;    // decoded in the shader (sRGBTransferEOTF)
    t.flipY = false;
    t.premultiplyAlpha = false;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
  }
  makeVideoTexture();

  function frameSize(f) {
    if (!f) return [0, 0];
    return [f.displayWidth || f.videoWidth || f.width || 0, f.displayHeight || f.videoHeight || f.height || 0];
  }

  /** Upload this exact frame as the background (the frame the tracker just analysed). */
  function setFrame(frame) {
    if (!frame) {   // null = live mode (tracker too slow for frame sync): show the live VideoTexture now
      if (pendingFrame) { safeClose(pendingFrame); pendingFrame = null; }
      lastFrameAt = -1e9;
      return;
    }
    if (pendingFrame && pendingFrame !== frame) safeClose(pendingFrame);
    pendingFrame = frame;
    lastFrameAt = performance.now();
  }
  function safeClose(f) { try { f && f.close && f.close(); } catch { /* already closed */ } }

  function uploadPending() {
    if (!pendingFrame) return;
    const f = pendingFrame; pendingFrame = null;
    const [fw, fh] = frameSize(f);
    if (!fw || !fh) { safeClose(f); return; }
    if (!frameTex || frameTexW !== fw || frameTexH !== fh) {
      if (frameTex) frameTex.dispose();          // storage size changed → new texture
      frameTex = new THREE.Texture();
      prepTex(frameTex);
      frameTexW = fw; frameTexH = fh;
    }
    frameTex.image = f;                          // ImageBitmap or VideoFrame (three r186 handles both)
    frameTex.needsUpdate = true;
    if (curFrame && curFrame !== f) safeClose(curFrame);   // previous one is on the GPU already
    curFrame = f;
    if (!vw || !vh || vw !== fw || vh !== fh) { vw = fw; vh = fh; updateAspect(); }
  }

  function pickBackground(now) {
    const frameFresh = frameTex && (now - lastFrameAt) < (R.frameTimeoutMs ?? 600);
    if (frameFresh) { cu.tVideo.value = frameTex; cu.uHasVideo.value = 1; return; }
    if (video && video.readyState >= 2 && video.videoWidth) {
      makeVideoTexture();
      if (video.videoWidth !== vw || video.videoHeight !== vh) { vw = video.videoWidth; vh = video.videoHeight; updateAspect(); }
      cu.tVideo.value = videoTex; cu.uHasVideo.value = 1; return;
    }
    if (frameTex) { cu.tVideo.value = frameTex; cu.uHasVideo.value = 1; return; }
    cu.uHasVideo.value = 0;
  }

  // --- size / mapping
  let W = 1280, H = 720, dpr = 1;
  let quality = R.quality || 'auto';
  let effective = 'high';
  let afterRender = [];
  const qualityListeners = [];

  // the camera image is never drawn below the device pixel ratio: 低 / auto drop do not change it (see top)
  const baseDpr = () => basePixelRatio(dpr, isMobile, R.pixelRatio);
  // 縦 photo / video (R2-11, capture.js): the drawing buffer is raised to >= capH px tall, so the 1080x1920
  // output is not an upscaled small canvas. Applied at the start of render() (a resize clears the canvas,
  // so it never happens between a render and its display).
  let capH = 0, capApplied = 0;
  const dprFor = h => Math.max(baseDpr(), h > 0 ? Math.min(h / H, 4) : 0);
  function capDpr() { return dprFor(capApplied); }
  function setCaptureHeight(px) { capH = px > 0 ? Math.round(px) : 0; }
  /** drawing-buffer height the NEXT render() uses (objects.update sizes points with it) */
  const bufferHeight = () => H * dprFor(capH);
  function updateAspect() {
    cu.uViewAspect.value = W / H;
    cu.uVideoAspect.value = vw && vh ? vw / vh : W / H;
    if (vw && vh) cu.uTexel.value.set(1 / vw, 1 / vh);
  }
  function resize(w, h, d = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1)) {
    W = Math.max(1, Math.round(w)); H = Math.max(1, Math.round(h)); dpr = d || 1;
    renderer.setPixelRatio(capDpr());
    renderer.setSize(W, H, true);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    // after renderer/composer setSize: both resize every pass to the full (capture-raised) buffer
    if (composer) { composer.setPixelRatio(capDpr()); composer.setSize(W, H); }
    bloomPass.setSize(...bloomSize(db.x, db.y, capDpr(), baseDpr()));
    updateAspect();
  }
  function setVideoSize(w, h) { if (w && h) { vw = w; vh = h; updateAspect(); } }
  function setMirror(b) { mirror = !!b; cu.uMirror.value = mirror ? 1 : 0; }
  setMirror(true);

  function applyQuality() {
    effective = quality === 'auto' ? ((isMobile || autoDropped) ? 'low' : 'high') : quality;
    if (useEffects) renderer.setEffects(effective === 'low' ? [compositePass] : [bloomPass, compositePass]);
    else if (composer) bloomPass.enabled = effective !== 'low';
    applyMsaa();
  }
  function setQuality(q) {
    quality = q || 'auto';
    if (quality !== 'auto') autoDropped = false;
    applyQuality();
    resize(W, H, dpr);
    qualityListeners.forEach(fn => { try { fn(effective, quality); } catch (e) { console.warn(e); } });
  }
  const getQuality = () => quality;
  const getEffectiveQuality = () => effective;

  // --- adaptive quality (call startAutoQuality() when hands first appear)
  let autoDropped = false;
  let autoSample = null;   // {t0, frames}
  function startAutoQuality() {
    if (quality !== 'auto' || effective === 'low' || autoSample) return;
    autoSample = { t0: performance.now(), frames: 0, last: null };
  }
  // rAF stops while hidden: the time away must not count as slow frames (R3-15)
  const onVis = () => { if (typeof document !== 'undefined' && document.hidden && autoSample) autoSample.hidden = true; };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  function tickAutoQuality(now) {
    if (!autoSample) return;
    const aq = R.autoQuality || { sampleMs: 4000, minFps: 24 };
    const r = autoQualityStep(autoSample, now, aq);
    autoSample = r.sample;
    if (r.fps !== undefined) {
      const f = r.fps;
      if (f < (aq.minFps ?? 24) && quality === 'auto') {
        autoDropped = true; effective = 'low';
        if (useEffects) renderer.setEffects([compositePass]); else bloomPass.enabled = false;
        applyMsaa();
        resize(W, H, dpr);
        qualityListeners.forEach(fn => { try { fn('low', 'auto', { dropped: true, fps: f }); } catch (e) { console.warn(e); } });
      }
    }
  }
  const onQualityChange = fn => { qualityListeners.push(fn); };

  // --- picking helpers
  const _ray = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const _v = new THREE.Vector3();
  function screenToWorld(sx, sy, zPlane = 0, out = new THREE.Vector3()) {
    _ndc.set((sx / W) * 2 - 1, -(sy / H) * 2 + 1);
    _ray.setFromCamera(_ndc, camera);
    _plane.constant = -zPlane;
    if (!_ray.ray.intersectPlane(_plane, out)) out.set(0, 0, zPlane);
    return out;
  }
  function worldToScreen(v3) {
    _v.copy(v3).project(camera);
    return { x: (_v.x * 0.5 + 0.5) * W, y: (-_v.y * 0.5 + 0.5) * H, z: _v.z };
  }
  /** world units per CSS px at depth z (perspective) */
  function worldPerPx(z = 0) {
    const d = camera.position.z - z;
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / H;
  }

  // --- fps
  const frameTimes = [];
  function fps() {
    if (frameTimes.length < 2) return 0;
    const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
    return span > 0 ? ((frameTimes.length - 1) * 1000) / span : 0;
  }

  // --- context loss
  let lost = false;
  const restoreListeners = [];
  const onLost = (e) => { e.preventDefault(); lost = true; };
  const onRestored = () => {
    lost = false;
    // three re-initialises its GL state itself; re-arm what we own.
    // old GL handles died with the context: drop (don't dispose → no cross-context deletes)
    if (videoTex) {
      // stop the old texture's requestVideoFrameCallback loop (only dispose() cancels it) — no GL delete (R2-23)
      const o = videoTex;
      if (o._requestVideoFrameCallbackId) {
        try { (o.source?.data || o.image)?.cancelVideoFrameCallback?.(o._requestVideoFrameCallbackId); } catch { /* ignore */ }
        o._requestVideoFrameCallbackId = 0;
      }
      videoTex = null; makeVideoTexture();
    }
    if (frameTex) { frameTex = null; frameTexW = frameTexH = 0; }
    sceneRT = null; probing = useEffects;   // three made new targets: find the scene target again
    applyQuality();
    resize(W, H, dpr);
    restoreListeners.forEach(fn => { try { fn(); } catch (err) { console.warn(err); } });
  };
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);
  const onVideoResize = () => { if (video?.videoWidth) setVideoSize(video.videoWidth, video.videoHeight); };
  video?.addEventListener?.('resize', onVideoResize);

  // --- render
  function render(dt = 1 / 60) {
    if (lost) return;
    if (capApplied !== capH) { capApplied = capH; resize(W, H, dpr); }
    const now = performance.now();
    uploadPending();
    pickBackground(now);
    if (useEffects && !sceneRT) probing = true;
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
    probing = false;
    for (const fn of afterRender) { try { fn(canvas); } catch (e) { console.warn(e); } }
    frameTimes.push(now); if (frameTimes.length > 60) frameTimes.shift();
    // a hi-res capture frame is slow by design: do not let it trigger the auto quality drop
    if (!capApplied) tickAutoQuality(now); else if (autoSample) autoSample = { t0: now, frames: 0, last: now };
  }
  function onAfterRender(fn) {
    afterRender.push(fn);
    return () => { afterRender = afterRender.filter(f => f !== fn); };
  }

  function dispose() {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    video?.removeEventListener?.('resize', onVideoResize);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    safeClose(curFrame); safeClose(pendingFrame);
    videoTex?.dispose(); frameTex?.dispose();
    bloomPass.dispose(); compositePass.dispose();
    renderer.dispose();
  }

  applyQuality();
  resize(canvas.clientWidth || W, canvas.clientHeight || H, typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
  if (!useEffects) buildComposer().catch(e => console.error('composer fallback failed', e));

  return {
    renderer, scene, camera, BLOOM_LAYER, pipeline, isMobile,
    setVideoSize, setMirror, getMirror: () => mirror, setQuality, getQuality, getEffectiveQuality, onQualityChange, startAutoQuality,
    resize, getSize: () => ({ W, H, dpr: capDpr() }), screenToWorld, worldToScreen, worldPerPx,
    setFrame, render, onAfterRender, onContextRestored: fn => restoreListeners.push(fn), fps, dispose,
    lineWidth: () => (isMobile ? (R.holo?.edgeWidth?.mobile ?? 1.5) : (R.holo?.edgeWidth?.desktop ?? 2)),
    isContextLost: () => lost,
    setCaptureHeight, bufferHeight,
    /** くっきり on/off (camera image only) */
    setClarity, getClarity: () => clarityOn,
    /** the camera's own resolution (not a downscaled frame copy): capture.js sizes photos / videos from it */
    getCameraSize: () => (video?.videoWidth ? { w: video.videoWidth, h: video.videoHeight } : (vw && vh ? { w: vw, h: vh } : null)),
    /** MSAA samples of the scene target (null until the first render / composer path) */
    msaaSamples: () => (sceneRT ? sceneRT.samples : null),
    /** bloom input size in px (half-res mip 0 ×2); a capture keeps it at the on-screen size (R3-14) */
    bloomBufferSize: () => ({ w: bloomPass.renderTargetBright.width * 2, h: bloomPass.renderTargetBright.height * 2 }),
  };
}
