import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeShape, resample, pathLength, alignedSamples } from '../src/shapes.js';

// Deterministic PRNG so "hand wobble" is reproducible.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Densify a polyline and add smooth low-frequency wobble + jitter like a real hand. */
function handDrawn(vertices, { closed = true, wobble = 4, seed = 1, overshoot = 0, step = 4 } = {}) {
  const r = rng(seed);
  const path = closed ? [...vertices, vertices[0]] : vertices;
  const out = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const n = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  out.push({ ...path[path.length - 1] });
  if (overshoot > 0) {
    const extra = Math.round(out.length * overshoot);
    for (let k = 1; k <= extra; k++) out.push({ ...out[k] });
  }
  const phase1 = r() * 6, phase2 = r() * 6;
  return out.map((p, i) => ({
    x: p.x + Math.sin(i * 0.11 + phase1) * wobble + (r() - 0.5) * wobble * 0.6,
    y: p.y + Math.cos(i * 0.09 + phase2) * wobble + (r() - 0.5) * wobble * 0.6,
  }));
}

function ellipse(cx, cy, rx, ry, n = 120, startAngle = 0, sweep = Math.PI * 2) {
  return Array.from({ length: n }, (_, i) => {
    const a = startAngle + (i / (n - 1)) * sweep;
    return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
  });
}

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

test('resample keeps endpoints and evenly spaces points', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const r = resample(pts, 11);
  assert.equal(r.length, 11);
  assert.deepEqual(r[0], { x: 0, y: 0 });
  assert.ok(Math.abs(r[10].x - 100) < 1e-9);
  assert.ok(Math.abs(r[5].x - 50) < 1e-9);
  assert.equal(pathLength(r), 100);
});

test('recognises straight lines and snaps near-horizontal ones', () => {
  const s = recognizeShape(handDrawn([{ x: 50, y: 200 }, { x: 450, y: 212 }], { closed: false, wobble: 2 }));
  assert.equal(s?.type, 'line');
  assert.ok(Math.abs(s.points[0].y - s.points[1].y) < 1e-6, 'line should snap horizontal');
});

test('recognises diagonal line', () => {
  const s = recognizeShape(handDrawn([{ x: 0, y: 0 }, { x: 300, y: 260 }], { closed: false, wobble: 2 }));
  assert.equal(s?.type, 'line');
});

for (const seed of [1, 2, 3, 4, 5]) {
  test(`recognises a wobbly circle (seed ${seed})`, () => {
    const pts = handDrawn(ellipse(300, 300, 120, 120, 90, seed), { closed: false, wobble: 5, seed, step: 1000 });
    const s = recognizeShape(pts);
    assert.equal(s?.type, 'circle');
    assert.ok(Math.abs(s.center.x - 300) < 15 && Math.abs(s.center.y - 300) < 15);
  });
}

test('recognises a circle drawn with overshoot', () => {
  const pts = ellipse(300, 300, 100, 100, 140, 0, Math.PI * 2.25);
  assert.equal(recognizeShape(handDrawn(pts, { closed: false, wobble: 3, step: 1000 }))?.type, 'circle');
});

test('recognises a circle that stops short of closing', () => {
  const pts = ellipse(300, 300, 100, 100, 120, 0, Math.PI * 1.85);
  assert.equal(recognizeShape(handDrawn(pts, { closed: false, wobble: 3, step: 1000 }))?.type, 'circle');
});

test('recognises an ellipse', () => {
  const pts = handDrawn(ellipse(300, 300, 200, 90, 120), { closed: false, wobble: 3, step: 1000 });
  assert.equal(recognizeShape(pts)?.type, 'ellipse');
});

for (const seed of [1, 2, 3]) {
  test(`recognises a rectangle and squares it up (seed ${seed})`, () => {
    const s = recognizeShape(handDrawn(rect(100, 100, 360, 200), { wobble: 4, seed }));
    assert.equal(s?.type, 'rectangle');
    assert.equal(s.points.length, 4);
    // axis aligned after snapping
    assert.ok(Math.abs(s.points[0].y - s.points[1].y) < 1e-6);
    assert.ok(Math.abs(s.points[1].x - s.points[2].x) < 1e-6);
  });

  test(`recognises a square, not a circle (seed ${seed})`, () => {
    const s = recognizeShape(handDrawn(rect(100, 100, 250, 250), { wobble: 4, seed }));
    assert.equal(s?.type, 'square');
  });

  test(`recognises a triangle (seed ${seed})`, () => {
    const tri = [{ x: 300, y: 80 }, { x: 480, y: 380 }, { x: 120, y: 380 }];
    const s = recognizeShape(handDrawn(tri, { wobble: 4, seed }));
    assert.equal(s?.type, 'triangle');
    assert.equal(s.points.length, 3);
  });
}

test('recognises a rotated rectangle', () => {
  const c = { x: 300, y: 300 }, a = (25 * Math.PI) / 180;
  const verts = rect(150, 220, 300, 160).map((p) => ({
    x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a),
    y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a),
  }));
  assert.equal(recognizeShape(handDrawn(verts, { wobble: 3 }))?.type, 'rectangle');
});

test('recognises a rectangle drawn with overshoot', () => {
  assert.equal(recognizeShape(handDrawn(rect(100, 100, 300, 180), { wobble: 3, overshoot: 0.12 }))?.type, 'rectangle');
});

test('leaves open curves, U-shapes and scribbles as freehand', () => {
  const arc = ellipse(300, 300, 150, 150, 80, 0, Math.PI);
  assert.equal(recognizeShape(arc), null, 'semicircle');
  const u = [{ x: 100, y: 100 }, { x: 100, y: 300 }, { x: 300, y: 300 }, { x: 300, y: 100 }];
  assert.equal(recognizeShape(handDrawn(u, { closed: false, wobble: 2 })), null, 'U');
  const r = rng(42);
  const scribble = [];
  let x = 300, y = 300;
  for (let i = 0; i < 200; i++) { x += (r() - 0.5) * 60; y += (r() - 0.5) * 60; scribble.push({ x, y }); }
  assert.equal(recognizeShape(scribble), null, 'scribble');
});

test('ignores tiny strokes and taps', () => {
  assert.equal(recognizeShape([{ x: 0, y: 0 }]), null);
  assert.equal(recognizeShape(ellipse(10, 10, 8, 8, 30)), null);
});

test('alignedSamples produces matching point counts that close the loop', () => {
  const free = handDrawn(ellipse(300, 300, 100, 100, 90), { closed: false, wobble: 3, step: 1000 });
  const shape = recognizeShape(free);
  const { from, to } = alignedSamples(shape, free, 64);
  assert.equal(from.length, 64);
  assert.equal(to.length, 64);
  assert.deepEqual(to[0], to[63]);
  assert.ok(Math.hypot(to[0].x - from[0].x, to[0].y - from[0].y) < 20, 'morph starts near the stroke start');
});
