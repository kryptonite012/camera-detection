/**
 * Smart-shape recognition: turns a wobbly air-drawn stroke into clean geometry.
 *
 * Pipeline:
 *   1. Reject tiny strokes.
 *   2. Straight enough → LINE (angle snapped to 45° steps when close).
 *   3. Endpoints far apart → leave it as freehand.
 *   4. Closed loop → trim the overshoot, then fit both an ellipse and a
 *      polygon (Ramer–Douglas–Peucker + corner cleanup) and keep whichever
 *      hugs the drawn points more tightly.
 *   5. Polygons are classified (triangle / rectangle / square / quad /
 *      pentagon / hexagon) and rectangles are squared up.
 *
 * Pure geometry, no DOM — unit tested in Node.
 */

const TAU = Math.PI * 2;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function pathLength(pts, closed = false) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 1) L += dist(pts[pts.length - 1], pts[0]);
  return L;
}

export function bounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX, h = maxY - minY;
  return { minX, minY, maxX, maxY, w, h, cx: minX + w / 2, cy: minY + h / 2, diag: Math.hypot(w, h) };
}

/** Resample a polyline to `n` points evenly spaced by arc length. */
export function resample(pts, n, closed = false) {
  const src = closed ? [...pts, pts[0]] : pts;
  if (src.length < 2) return Array.from({ length: n }, () => ({ ...pts[0] }));
  const total = pathLength(src);
  const count = closed ? n : n - 1; // closed: last sample must not duplicate the first
  const step = total / count;
  const out = [{ x: src[0].x, y: src[0].y }];
  let carried = 0;
  for (let i = 1; i < src.length && out.length < n; i++) {
    let a = src[i - 1];
    const b = src[i];
    let seg = dist(a, b);
    while (carried + seg >= step && out.length < n) {
      const t = (step - carried) / seg;
      const p = lerp(a, b, t);
      out.push(p);
      a = p;
      seg = dist(a, b);
      carried = 0;
    }
    carried += seg;
  }
  while (out.length < n) out.push({ ...src[src.length - 1] });
  return out;
}

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceToPolygon(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = pointSegmentDistance(p, poly[i], poly[(i + 1) % poly.length]);
    if (d < best) best = d;
  }
  return best;
}

function rdp(pts, epsilon) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  let maxD = -1, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointSegmentDistance(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= epsilon) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), epsilon);
  const right = rdp(pts.slice(idx), epsilon);
  return [...left.slice(0, -1), ...right];
}

/** RDP for a closed loop: split at the point farthest from the start. */
function rdpClosed(pts, epsilon) {
  let far = 0, maxD = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[0], pts[i]);
    if (d > maxD) { maxD = d; far = i; }
  }
  const first = rdp(pts.slice(0, far + 1), epsilon);
  const second = rdp([...pts.slice(far), pts[0]], epsilon);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function interiorAngle(prev, p, next) {
  const a = Math.atan2(prev.y - p.y, prev.x - p.x);
  const b = Math.atan2(next.y - p.y, next.x - p.x);
  let d = Math.abs(a - b);
  if (d > Math.PI) d = TAU - d;
  return d; // radians, π = straight
}

/** Drop near-straight vertices and merge vertices joined by tiny edges. */
function cleanPolygon(vertices, perimeter) {
  let v = vertices.slice();
  let changed = true;
  while (changed && v.length > 3) {
    changed = false;
    // Merge the shortest edge if it's tiny.
    let shortest = Infinity, si = -1;
    for (let i = 0; i < v.length; i++) {
      const d = dist(v[i], v[(i + 1) % v.length]);
      if (d < shortest) { shortest = d; si = i; }
    }
    if (shortest < perimeter * 0.07) {
      const j = (si + 1) % v.length;
      const merged = lerp(v[si], v[j], 0.5);
      v = v.filter((_, k) => k !== si && k !== j);
      v.splice(Math.min(si, v.length), 0, merged);
      changed = true;
      continue;
    }
    // Remove the flattest vertex if it's nearly straight.
    let flattest = -1, fi = -1;
    for (let i = 0; i < v.length; i++) {
      const ang = interiorAngle(v[(i - 1 + v.length) % v.length], v[i], v[(i + 1) % v.length]);
      if (ang > flattest) { flattest = ang; fi = i; }
    }
    if (flattest > (155 * Math.PI) / 180) {
      v.splice(fi, 1);
      changed = true;
    }
  }
  return v;
}

function rotate(p, c, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** Fit a rectangle to 4 roughly-right-angled vertices; snaps to axis / square. */
function squareUp(quad) {
  // Dominant orientation: average edge angle folded into [0, 90°).
  let sx = 0, sy = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const w = dist(a, b);
    const ang = Math.atan2(b.y - a.y, b.x - a.x) * 4; // ×4 folds the 90° symmetry
    sx += Math.cos(ang) * w;
    sy += Math.sin(ang) * w;
  }
  let theta = Math.atan2(sy, sx) / 4;
  if (Math.abs(theta) < (10 * Math.PI) / 180) theta = 0;

  const c = centroid(quad);
  const r = quad.map((p) => rotate(p, c, -theta));
  const xs = r.map((p) => p.x).sort((a, b) => a - b);
  const ys = r.map((p) => p.y).sort((a, b) => a - b);
  let left = (xs[0] + xs[1]) / 2, right = (xs[2] + xs[3]) / 2;
  let top = (ys[0] + ys[1]) / 2, bottom = (ys[2] + ys[3]) / 2;
  let w = right - left, h = bottom - top;
  let isSquare = false;
  if (Math.abs(w - h) / Math.max(w, h) < 0.12) {
    const s = (w + h) / 2;
    const mx = (left + right) / 2, my = (top + bottom) / 2;
    left = mx - s / 2; right = mx + s / 2; top = my - s / 2; bottom = my + s / 2;
    w = h = s;
    isSquare = true;
  }
  const corners = [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
  ].map((p) => rotate(p, c, theta));
  return { corners, isSquare };
}

function ellipsePoints(c, rx, ry, n = 72) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * TAU;
    return { x: c.x + Math.cos(a) * rx, y: c.y + Math.sin(a) * ry };
  });
}

/** Cut the trailing overshoot of a closed stroke at the point nearest its start. */
function trimLoop(pts) {
  const L = pathLength(pts);
  let acc = 0, best = pts.length - 1, bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    if (acc < L * 0.6) continue;
    const d = dist(pts[i], pts[0]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return pts.slice(0, best + 1);
}

const POLY_NAMES = { 3: 'triangle', 4: 'quad', 5: 'pentagon', 6: 'hexagon' };

/**
 * @param {{x:number,y:number}[]} input
 * @returns {null | {type:string, points:{x:number,y:number}[], closed:boolean, sharp:boolean, confidence:number, center:{x:number,y:number}}}
 */
export function recognizeShape(input) {
  const pts = [];
  for (const p of input) {
    if (!pts.length || dist(pts[pts.length - 1], p) > 0.5) pts.push({ x: p.x, y: p.y });
  }
  if (pts.length < 5) return null;
  const L = pathLength(pts);
  const box = bounds(pts);
  if (L < 60 || box.diag < 40) return null;

  const start = pts[0], end = pts[pts.length - 1];
  const gap = dist(start, end);

  // ── Line ──────────────────────────────────────────────
  const straightness = gap / L;
  if (straightness > 0.92) {
    let angle = Math.atan2(end.y - start.y, end.x - start.x);
    const step = Math.PI / 4;
    const snapped = Math.round(angle / step) * step;
    if (Math.abs(snapped - angle) < (7 * Math.PI) / 180) angle = snapped;
    const mid = lerp(start, end, 0.5);
    const half = gap / 2;
    const a = { x: mid.x - Math.cos(angle) * half, y: mid.y - Math.sin(angle) * half };
    const b = { x: mid.x + Math.cos(angle) * half, y: mid.y + Math.sin(angle) * half };
    return {
      type: 'line', points: [a, b], closed: false, sharp: true,
      confidence: Math.min(0.99, (straightness - 0.92) / 0.08 * 0.3 + 0.69), center: mid,
    };
  }

  // ── Closed shapes ─────────────────────────────────────
  // Measure closure where the stroke passes back by its start (handles overshoot).
  const loopPts = trimLoop(pts);
  const closeGap = dist(start, loopPts[loopPts.length - 1]);
  if (closeGap > Math.max(0.3 * box.diag, 20) || L < 2 * box.diag) return null;

  const loop = resample(loopPts, 96, true);
  const lb = bounds(loop);
  const size = lb.diag;
  const c = centroid(loop);

  // Ellipse candidate (axis aligned) — radii from mean extents around the centroid.
  let rx = 0, ry = 0;
  for (const p of loop) { rx += Math.abs(p.x - c.x); ry += Math.abs(p.y - c.y); }
  // For an ellipse, mean |cos θ| = 2/π  →  radius = mean·π/2
  rx = (rx / loop.length) * (Math.PI / 2);
  ry = (ry / loop.length) * (Math.PI / 2);
  let ellipseErr = 0;
  for (const p of loop) {
    const nx = (p.x - c.x) / rx, ny = (p.y - c.y) / ry;
    const rn = Math.hypot(nx, ny);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    ellipseErr += rn > 0 ? Math.abs(1 - 1 / rn) * d : Math.min(rx, ry);
  }
  ellipseErr /= loop.length * size;

  // Polygon candidate.
  const perimeter = pathLength(loop, true);
  let poly = cleanPolygon(rdpClosed(loop, size * 0.045), perimeter);
  let polyErr = Infinity;
  if (poly.length >= 3 && poly.length <= 6) {
    polyErr = 0;
    for (const p of loop) polyErr += distanceToPolygon(p, poly);
    polyErr /= loop.length * size;
  }

  const MAX_ERR = 0.05;
  // Pentagons/hexagons are rarely intended — make them prove it.
  const polyBias = poly.length <= 4 ? 1.0 : 0.55;
  const polyWins = polyErr * (1 / polyBias) < ellipseErr;

  if (!polyWins && ellipseErr < MAX_ERR) {
    const confidence = Math.min(0.99, 1 - ellipseErr / MAX_ERR * 0.5);
    const ratio = rx / ry;
    if (ratio > 0.82 && ratio < 1.22) {
      const r = (rx + ry) / 2;
      return { type: 'circle', points: ellipsePoints(c, r, r), closed: true, sharp: false, confidence, center: c };
    }
    return { type: 'ellipse', points: ellipsePoints(c, rx, ry), closed: true, sharp: false, confidence, center: c };
  }

  if (polyWins && polyErr < MAX_ERR) {
    const confidence = Math.min(0.99, 1 - polyErr / MAX_ERR * 0.5);
    let type = POLY_NAMES[poly.length];
    if (poly.length === 4) {
      const rightAngled = poly.every((p, i) => {
        const ang = interiorAngle(poly[(i + 3) % 4], p, poly[(i + 1) % 4]);
        return Math.abs(ang - Math.PI / 2) < (22 * Math.PI) / 180;
      });
      if (rightAngled) {
        const { corners, isSquare } = squareUp(poly);
        poly = corners;
        type = isSquare ? 'square' : 'rectangle';
      }
    }
    // Keep the drawn winding direction (so morph animations don't twist).
    if (Math.sign(signedArea(poly)) !== Math.sign(signedArea(loop))) poly.reverse();
    return { type, points: poly, closed: true, sharp: true, confidence, center: centroid(poly) };
  }

  return null;
}

/**
 * Sample a recognised shape to `n` points aligned with a freehand stroke so the
 * stroke can morph smoothly into the clean geometry.
 */
export function alignedSamples(shape, freehand, n) {
  const from = resample(freehand, n, false);
  if (!shape.closed) return { from, to: resample(shape.points, n, false) };

  // Closed: n-1 samples around the loop, then repeat the first so an open
  // polyline through `to` traces the whole outline.
  let to = resample(shape.points, n - 1, true);
  if (Math.sign(signedArea(to)) !== Math.sign(signedArea(from))) to.reverse();
  let best = 0, bestD = Infinity;
  for (let i = 0; i < to.length; i++) {
    const d = dist(to[i], from[0]);
    if (d < bestD) { bestD = d; best = i; }
  }
  to = [...to.slice(best), ...to.slice(0, best)];
  to.push({ ...to[0] });
  return { from, to };
}
