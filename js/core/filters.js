// PURE: One Euro filters (Casiez et al. 2012). Time is always passed in (ms). No DOM / THREE / window.

const TAU = 2 * Math.PI;
const alphaFor = (cutoff, dt) => {
  const r = TAU * cutoff * dt;
  return r / (r + 1);
};

/** Scalar One Euro filter. filter(value, tMs) → filtered value. */
export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  get value() { return this.x; }
  filter(value, tMs) {
    if (this.x === null || this.t === null || !(tMs > this.t)) {
      if (this.x === null || this.t === null) { this.x = value; this.dx = 0; this.t = tMs; return value; }
      // same/earlier timestamp: no time passed → keep state (never divide by zero)
      return this.x;
    }
    const dt = Math.min((tMs - this.t) / 1000, 0.5);
    this.t = tMs;
    const dxRaw = (value - this.x) / dt;
    this.dx += alphaFor(this.dCutoff, dt) * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alphaFor(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/**
 * Vector One Euro: one adaptive cutoff for all components (speed = |d/dt| of the vector), so a
 * point is smoothed isotropically (per-axis filters make diagonal motion lag unevenly).
 */
export class OneEuroVec {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}, dims = 2) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.dims = dims;
    this.reset();
  }
  reset() { this.x = null; this.dx = null; this.t = null; }
  /** v: number[] (length dims). Returns a new array. */
  filter(v, tMs) {
    const n = this.dims;
    if (this.x === null) { this.x = v.slice(0, n); this.dx = new Array(n).fill(0); this.t = tMs; return this.x.slice(); }
    if (!(tMs > this.t)) return this.x.slice();
    const dt = Math.min((tMs - this.t) / 1000, 0.5);
    this.t = tMs;
    const ad = alphaFor(this.dCutoff, dt);
    let sp = 0;
    for (let i = 0; i < n; i++) {
      this.dx[i] += ad * ((v[i] - this.x[i]) / dt - this.dx[i]);
      sp += this.dx[i] * this.dx[i];
    }
    const a = alphaFor(this.minCutoff + this.beta * Math.sqrt(sp), dt);
    for (let i = 0; i < n; i++) this.x[i] += a * (v[i] - this.x[i]);
    return this.x.slice();
  }
  /** Shift the internal state by a constant offset (used to re-base without a jump). */
  shift(d) { if (this.x) for (let i = 0; i < this.dims; i++) this.x[i] += d[i] || 0; }
}

/**
 * Filters an array of points [{x,y[,z]}] with one OneEuroVec per point (beta in units/s).
 */
export class PointsFilter {
  constructor(params, count = 21, dims = 2) {
    this.params = { ...params }; this.count = count; this.dims = dims;
    this.f = Array.from({ length: count }, () => new OneEuroVec(this.params, dims));
  }
  reset() { for (const f of this.f) f.reset(); }
  setParams(p) { Object.assign(this.params, p); for (const f of this.f) Object.assign(f, p); }
  filter(points, tMs) {
    const out = new Array(this.count);
    const d = this.dims;
    for (let i = 0; i < this.count; i++) {
      const p = points[i];
      const r = this.f[i].filter(d === 3 ? [p.x, p.y, p.z || 0] : [p.x, p.y], tMs);
      out[i] = d === 3 ? { x: r[0], y: r[1], z: r[2] } : { x: r[0], y: r[1] };
    }
    return out;
  }
}

/** Exponential smoothing helper with time constant tauMs (frame-rate independent). */
export function emaAlpha(dtMs, tauMs) {
  if (!(dtMs > 0)) return 1;
  return 1 - Math.exp(-dtMs / Math.max(1e-6, tauMs));
}
