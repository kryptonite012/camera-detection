import { renderStroke, renderEraserTail } from './brushes.js';
import { recognizeShape, alignedSamples } from './shapes.js';

const MORPH_MS = 320;
const MORPH_SAMPLES = 72;
const easeOutBack = (t) => {
  const c1 = 1.5, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

let nextId = 1;

/**
 * The drawing surface: committed strokes live on a cached canvas layer;
 * in-progress strokes and shape morphs are drawn each frame on the live layer.
 * History is a list of actions so undo/redo works for strokes and clears.
 */
export class Board {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.strokes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.active = new Set();
    this.morphs = [];
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
  }
  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  resize(width, height, dpr) {
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.redraw();
  }

  redraw() {
    const { ctx, canvas, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of this.strokes) renderStroke(ctx, s, dpr);
  }

  begin({ brush, color, size }) {
    const stroke = {
      id: nextId++, brush, color, size, points: [], closed: false, sharp: false,
      seed: (Math.random() * 1e9) | 0,
    };
    this.active.add(stroke);
    return stroke;
  }

  /** Append a point; width is derived from speed for the tapering ink brush. */
  add(stroke, x, y, t) {
    const pts = stroke.points;
    const last = pts[pts.length - 1];
    if (last) {
      const d = Math.hypot(x - last.x, y - last.y);
      if (d < 1.2) return false;
      const speed = d / Math.max(1, t - last.t); // px per ms
      const target = Math.min(1.35, Math.max(0.35, 1.45 - speed * 0.55));
      const w = last.w + (target - last.w) * 0.35;
      pts.push({ x, y, t, w });
    } else {
      pts.push({ x, y, t, w: 1 });
    }
    if (stroke.brush === 'eraser') {
      // Erasing must affect the committed layer immediately.
      const { ctx, dpr } = this;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderEraserTail(ctx, stroke, pts.length - 1);
    }
    return true;
  }

  /** Remove points recorded after `t` (used to cut gesture-transition tails). */
  trimAfter(stroke, t) {
    while (stroke.points.length > 1 && stroke.points[stroke.points.length - 1].t > t) stroke.points.pop();
  }

  cancel(stroke) {
    this.active.delete(stroke);
  }

  /**
   * Finish a stroke. With smart shapes on, a recognised stroke morphs into its
   * clean geometry before being committed.
   * @returns the recognised shape (if any)
   */
  end(stroke, { smartShapes = false, now = performance.now() } = {}) {
    this.active.delete(stroke);
    if (!stroke.points.length) return null;
    if (stroke.brush === 'eraser') {
      this.commit(stroke, false);
      return null;
    }
    const shape = smartShapes ? recognizeShape(stroke.points) : null;
    if (!shape) {
      this.commit(stroke);
      return null;
    }
    const { from, to } = alignedSamples(shape, stroke.points, MORPH_SAMPLES);
    this.morphs.push({ stroke, shape, from, to, start: now });
    return shape;
  }

  commit(stroke, render = true) {
    this.strokes.push(stroke);
    this.undoStack.push({ type: 'add', stroke });
    this.redoStack.length = 0;
    if (render) {
      const { ctx, dpr } = this;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderStroke(ctx, stroke, dpr);
    }
    this.emit({ type: 'commit', stroke });
  }

  /** Advance morph animations; returns shapes that just finished. */
  update(now) {
    const done = [];
    this.morphs = this.morphs.filter((m) => {
      if (now - m.start < MORPH_MS) return true;
      const { stroke, shape } = m;
      stroke.points = shape.points.map((p) => ({ x: p.x, y: p.y, t: now, w: 1 }));
      stroke.closed = shape.closed;
      stroke.sharp = shape.sharp;
      stroke.shape = shape.type;
      this.commit(stroke);
      done.push(m);
      return false;
    });
    return done;
  }

  /** Draw in-progress strokes and morphs onto the live layer. */
  renderLive(ctx, now) {
    for (const s of this.active) if (s.brush !== 'eraser') renderStroke(ctx, s, this.dpr);
    for (const m of this.morphs) {
      const t = Math.min(1, (now - m.start) / MORPH_MS);
      const k = easeOutBack(t);
      const pts = m.from.map((p, i) => ({
        x: p.x + (m.to[i].x - p.x) * k,
        y: p.y + (m.to[i].y - p.y) * k,
        w: 1,
      }));
      renderStroke(ctx, m.stroke, this.dpr, pts);
    }
  }

  get isEmpty() {
    return this.strokes.length === 0;
  }

  clear() {
    if (!this.strokes.length) return false;
    this.undoStack.push({ type: 'clear', strokes: this.strokes });
    this.redoStack.length = 0;
    this.strokes = [];
    this.redraw();
    this.emit({ type: 'clear' });
    return true;
  }

  undo() {
    const action = this.undoStack.pop();
    if (!action) return false;
    if (action.type === 'add') this.strokes.pop();
    else if (action.type === 'clear') this.strokes = action.strokes;
    this.redoStack.push(action);
    this.redraw();
    this.emit({ type: 'undo' });
    return true;
  }

  redo() {
    const action = this.redoStack.pop();
    if (!action) return false;
    if (action.type === 'add') this.strokes.push(action.stroke);
    else if (action.type === 'clear') this.strokes = [];
    this.undoStack.push(action);
    this.redraw();
    this.emit({ type: 'redo' });
    return true;
  }

  get pointCount() {
    return this.strokes.reduce((n, s) => n + s.points.length, 0);
  }
}
