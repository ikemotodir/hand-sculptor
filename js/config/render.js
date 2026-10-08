// Rendering / look tunables. Owned by the scene modules (stage, holo, objects, fx, export).
export const RENDER = {
  camera: { fov: 50, z: 10 },
  baseSize: 1.6,                 // world units of a scale-1 shape
  scaleRange: [0.25, 6],
  quality: 'auto',               // 'auto' | 'high' | 'low'  (auto: desktop high, mobile low)
  pixelRatio: { high: 2, mobile: 1.5 },   // cap of the device pixel ratio; 低 / auto drop never lower it (camera image)
  bloom: { strength: 0.6, radius: 0.35, threshold: 0.12 },
  // Final pass: video + holograms. occlusion darkens the camera image slightly behind
  // hologram faces so they stay readable on bright backgrounds (0 = pure additive).
  // くっきり (setting, default on): halo-free unsharp amount + slight contrast / saturation lift of the camera image.
  // denoise (2026-10-08, 720p webcams): motion-adaptive temporal blend of the camera image with the previous denoised
  // frame, run once per NEW camera frame at camera resolution, before くっきり (which then sharpens the clean image).
  //   strength = blend weight of the previous frame where nothing moved; lo..hi = per-pixel difference (0-1, camera
  //   values, 5-tap mean) over which the weight fades to 0 → moving hands are never blended (no ghosting).
  //   enabled = desktop default; mobile = phones/tablets default (off: saves a full-screen pass).
  composite: { occlusion: 0.45, clarity: true, sharpen: 0.6, contrast: 1.04, saturation: 1.06,
    denoise: { enabled: true, mobile: false, strength: 0.65, lo: 0.03, hi: 0.10 } },
  autoQuality: { sampleMs: 4000, minFps: 24, maxGapMs: 1000 },   // a longer render gap (hidden / covered) restarts the sample
  frameTimeoutMs: 600,           // no setFrame() for this long → fall back to live VideoTexture
  holo: {
    opacityLevels: [0.10, 0.20, 0.40],   // 薄 / 中 / 濃 (user level)
    defaultOpacity: 0.20,
    faceMul: 0.35,                        // face alpha = level × faceMul
    edgeWidth: { desktop: 2.0, mobile: 1.5 }, // CSS px (never × dpr)
    edgeIntensity: 1.25,                   // HDR multiplier → bloom
    edgeWhite: 0.15,                      // mix of white into the edge core
    fresnelPower: 3.0, rim: 0.7,
    scanDensity: 9.0, scanSpeed: 0.6,
    glintSize: 0.12,
    idleSpin: 0.15, bob: 0.03, bobHz: 0.22,
    previewAlpha: 0.4,
  },
  select: { ringScale: 1.28, ringSpin: 0.6 },
  spinDecay: 0.93,               // per 1/60 s
  maxSpin: 12,
  rareChance: 0.05,
  rareColor: '#ffd75e',
  fx: {
    particles: 32, rareParticles: 64,
    particleLife: 0.4, ringLife: 0.83, lineLife: 1.17, gravity: 7.2,
    flashLife: 0.2, deleteShrink: 0.28,
    sizeRef: 1.3,               // v1 object size; fx scale = objectSize / sizeRef
  },
  export: { scale: 0.1, opacity: 0.55, emissive: 0.8 },   // 1 world unit → 0.1 m in GLB/USDZ
  shapes: ['box', 'sphere', 'cylinder', 'cone', 'torus', 'octa', 'pyramid', 'icosa', 'star', 'heart'],
  colors: ['#00f0ff', '#3d8bff', '#00ffa3', '#8b5cff', '#ff4fd8', '#ffe14d', '#ff8a3d', '#ffffff', '#ff3b5c'],
};
