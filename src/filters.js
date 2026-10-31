/**
 * One Euro Filter — an adaptive low-pass filter for noisy real-time signals.
 * Casiez, Roussel & Vogel, CHI 2012.
 *
 * Slow movement → low cutoff → strong smoothing (kills fingertip jitter).
 * Fast movement → cutoff rises with speed → low lag (strokes keep up).
 */

function smoothingFactor(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

class LowPass {
  constructor() {
    this.reset();
  }
  reset() {
    this.raw = null;
    this.value = null;
  }
  filter(x, alpha) {
    this.value = this.value === null ? x : alpha * x + (1 - alpha) * this.value;
    this.raw = x;
    return this.value;
  }
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.lastTime = null;
  }

  reset() {
    this.x.reset();
    this.dx.reset();
    this.lastTime = null;
  }

  /** @param {number} value  @param {number} t  timestamp in seconds */
  filter(value, t) {
    if (this.lastTime === null) {
      this.lastTime = t;
      this.dx.filter(0, 1);
      return this.x.filter(value, 1);
    }
    let dt = t - this.lastTime;
    if (!(dt > 0)) dt = 1 / 60;
    this.lastTime = t;

    const derivative = (value - this.x.raw) / dt;
    const smoothedDerivative = this.dx.filter(derivative, smoothingFactor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedDerivative);
    return this.x.filter(value, smoothingFactor(cutoff, dt));
  }
}

/** Filters a 2D point with independent One Euro filters per axis. */
export class PointFilter {
  constructor(options) {
    this.fx = new OneEuroFilter(options);
    this.fy = new OneEuroFilter(options);
  }
  configure({ minCutoff, beta }) {
    for (const f of [this.fx, this.fy]) {
      if (minCutoff !== undefined) f.minCutoff = minCutoff;
      if (beta !== undefined) f.beta = beta;
    }
  }
  reset() {
    this.fx.reset();
    this.fy.reset();
  }
  /** @param {{x:number,y:number}} p  @param {number} tMs timestamp in ms */
  filter(p, tMs) {
    const t = tMs / 1000;
    return { x: this.fx.filter(p.x, t), y: this.fy.filter(p.y, t) };
  }
}

/** Maps a 0..1 "smoothing" UI value to One Euro parameters tuned for screen pixels. */
export function smoothingToParams(smoothing) {
  const s = Math.min(1, Math.max(0, smoothing));
  return {
    minCutoff: 4.0 - s * 3.4, // 4.0 Hz (raw) … 0.6 Hz (silky)
    beta: 0.02 - s * 0.012,
  };
}
