/**
 * Brush renderers. Every stroke is re-renderable from its data alone
 * (points + brush + color + size + seed), which keeps undo/redo exact.
 */

export const BRUSHES = ['neon', 'ink', 'rainbow', 'spark'];

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: ((a.w ?? 1) + (b.w ?? 1)) / 2 });

/**
 * Break a stroke into drawable segments. Smooth strokes use midpoint
 * quadratic curves (control point = the sampled point); sharp strokes
 * (recognised polygons, lines) use straight segments.
 */
export function segments(pts, closed = false, sharp = false) {
  const n = pts.length;
  const out = [];
  if (n < 2) return out;
  if (sharp) {
    for (let i = 1; i < n; i++) out.push({ a: pts[i - 1], b: pts[i], w: avgW(pts[i - 1], pts[i]) });
    if (closed) out.push({ a: pts[n - 1], b: pts[0], w: avgW(pts[n - 1], pts[0]) });
    return out;
  }
  if (closed) {
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n], p = pts[i], next = pts[(i + 1) % n];
      out.push({ a: mid(prev, p), c: p, b: mid(p, next), w: p.w ?? 1 });
    }
    return out;
  }
  if (n === 2) return [{ a: pts[0], b: pts[1], w: avgW(pts[0], pts[1]) }];
  out.push({ a: pts[0], b: mid(pts[0], pts[1]), w: pts[0].w ?? 1 });
  for (let i = 1; i < n - 1; i++) out.push({ a: mid(pts[i - 1], pts[i]), c: pts[i], b: mid(pts[i], pts[i + 1]), w: pts[i].w ?? 1 });
  out.push({ a: mid(pts[n - 2], pts[n - 1]), b: pts[n - 1], w: pts[n - 1].w ?? 1 });
  return out;
}

function avgW(a, b) {
  return ((a.w ?? 1) + (b.w ?? 1)) / 2;
}

function tracePath(ctx, segs) {
  ctx.beginPath();
  ctx.moveTo(segs[0].a.x, segs[0].a.y);
  for (const s of segs) {
    if (s.c) ctx.quadraticCurveTo(s.c.x, s.c.y, s.b.x, s.b.y);
    else ctx.lineTo(s.b.x, s.b.y);
  }
}

function traceSegment(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(s.a.x, s.a.y);
  if (s.c) ctx.quadraticCurveTo(s.c.x, s.c.y, s.b.x, s.b.y);
  else ctx.lineTo(s.b.x, s.b.y);
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

export function tint(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  const m = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

export function rgba(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dot(ctx, p, r) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

/* ─── Brushes ─────────────────────────────────────────────── */

function neon(ctx, stroke, pts, segs, dpr) {
  const { color, size } = stroke;
  if (pts.length === 1) {
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 3 * dpr;
    ctx.fillStyle = color;
    dot(ctx, pts[0], size / 2);
    ctx.shadowBlur = size * dpr;
    ctx.fillStyle = tint(color, 0.75);
    dot(ctx, pts[0], size * 0.22);
    return;
  }
  // Outer halo
  ctx.strokeStyle = rgba(color, 0.16);
  ctx.lineWidth = size * 2.6;
  tracePath(ctx, segs);
  if (stroke.closed) ctx.closePath();
  ctx.stroke();
  // Glowing body
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 2.4 * dpr;
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  tracePath(ctx, segs);
  if (stroke.closed) ctx.closePath();
  ctx.stroke();
  // Hot core
  ctx.shadowBlur = size * 0.8 * dpr;
  ctx.shadowColor = tint(color, 0.5);
  ctx.strokeStyle = tint(color, 0.78);
  ctx.lineWidth = Math.max(1, size * 0.34);
  tracePath(ctx, segs);
  if (stroke.closed) ctx.closePath();
  ctx.stroke();
}

function ink(ctx, stroke, pts, segs, dpr) {
  const { color, size } = stroke;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.shadowColor = rgba(color, 0.55);
  ctx.shadowBlur = size * 0.6 * dpr;
  if (pts.length === 1) return dot(ctx, pts[0], size / 2);
  if (stroke.sharp) {
    ctx.lineWidth = size;
    tracePath(ctx, segs);
    if (stroke.closed) ctx.closePath();
    ctx.stroke();
    return;
  }
  // Pressure-like taper from per-point width (speed based).
  for (const s of segs) {
    ctx.lineWidth = Math.max(0.8, size * s.w);
    traceSegment(ctx, s);
    ctx.stroke();
  }
}

function rainbow(ctx, stroke, pts, segs) {
  const { size } = stroke;
  const hue0 = (stroke.seed % 360);
  if (pts.length === 1) {
    ctx.fillStyle = `hsl(${hue0}, 100%, 60%)`;
    return dot(ctx, pts[0], size / 2);
  }
  let travelled = 0;
  for (const pass of [{ w: 2.6, a: 0.14 }, { w: 1, a: 1 }, { w: 0.32, a: 0.85, light: 88 }]) {
    travelled = 0;
    ctx.lineWidth = Math.max(1, size * pass.w);
    for (const s of segs) {
      travelled += Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
      const hue = (hue0 + travelled * 0.6) % 360;
      ctx.strokeStyle = `hsla(${hue}, 100%, ${pass.light ?? 60}%, ${pass.a})`;
      traceSegment(ctx, s);
      ctx.stroke();
    }
  }
}

function spark(ctx, stroke, pts, segs, dpr) {
  const { color, size } = stroke;
  const rand = rng(stroke.seed);
  const spacing = Math.max(3, size * 0.7);
  const samples = [];
  if (pts.length === 1) samples.push(pts[0]);
  else {
    let carry = 0;
    for (const s of segs) {
      const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
      let d = spacing - carry;
      while (d <= L) {
        const t = d / L;
        // Point on quadratic (or line) segment
        const c = s.c ?? { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
        const u = 1 - t;
        samples.push({ x: u * u * s.a.x + 2 * u * t * c.x + t * t * s.b.x, y: u * u * s.a.y + 2 * u * t * c.y + t * t * s.b.y });
        d += spacing;
      }
      carry = L - (d - spacing);
    }
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 1.5 * dpr;
  for (const p of samples) {
    const jx = (rand() - 0.5) * size * 0.9, jy = (rand() - 0.5) * size * 0.9;
    const r = size * (0.12 + rand() * 0.38);
    ctx.fillStyle = rgba(color, 0.55 + rand() * 0.45);
    dot(ctx, { x: p.x + jx, y: p.y + jy }, r);
    if (rand() > 0.7) {
      ctx.fillStyle = tint(color, 0.85);
      dot(ctx, { x: p.x + jx, y: p.y + jy }, r * 0.4);
    }
  }
}

function eraser(ctx, stroke, pts, segs) {
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  ctx.lineWidth = stroke.size;
  if (pts.length === 1) return dot(ctx, pts[0], stroke.size / 2);
  tracePath(ctx, segs);
  ctx.stroke();
}

const RENDERERS = { neon, ink, rainbow, spark, eraser };

/**
 * Render a stroke. `pointsOverride` lets the morph animation draw
 * intermediate geometry without mutating the stroke.
 */
export function renderStroke(ctx, stroke, dpr = 1, pointsOverride = null) {
  const pts = pointsOverride ?? stroke.points;
  if (!pts.length) return;
  const closed = pointsOverride ? false : !!stroke.closed;
  const sharp = pointsOverride ? false : !!stroke.sharp;
  const segs = segments(pts, closed, sharp);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = stroke.alpha ?? 1;
  (RENDERERS[stroke.brush] || neon)(ctx, { ...stroke, closed, sharp }, pts, segs, dpr);
  ctx.restore();
}

/** Render only the newest part of an eraser stroke (incremental, cheap). */
export function renderEraserTail(ctx, stroke, fromIndex) {
  const pts = stroke.points.slice(Math.max(0, fromIndex - 1));
  renderStroke(ctx, { ...stroke, points: pts });
}
