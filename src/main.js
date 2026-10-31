import { HandTracker } from './tracker.js';
import { analyzeHand, poseToIntent, Intent, IntentStabilizer, PinchDetector, LM } from './gestures.js';
import { PointFilter, smoothingToParams } from './filters.js';
import { Board } from './board.js';
import { Effects } from './effects.js';
import { drawHand, drawCursor } from './hud.js';
import { BRUSHES } from './brushes.js';

/* ── Configuration ─────────────────────────────────────── */

const COLORS = ['#00f0ff', '#ff2bd6', '#7dff3a', '#ffb020', '#9b6bff', '#f4f8ff'];
const SIZES = [3, 5, 8, 12, 18, 26, 36];
const BRUSH_NAMES = { neon: 'NEON', ink: 'INK', rainbow: 'SPECTRUM', spark: 'PARTICLE' };
const SHAPE_NAMES = {
  line: 'LINE', circle: 'CIRCLE', ellipse: 'ELLIPSE', triangle: 'TRIANGLE', rectangle: 'RECTANGLE',
  square: 'SQUARE', quad: 'QUAD', pentagon: 'PENTAGON', hexagon: 'HEXAGON',
};

const DEFAULTS = {
  color: COLORS[0],
  brush: 'neon',
  size: 8,
  smartShapes: true,
  drawTrigger: 'index',
  smoothing: 0.55,
  camera: 'dim',
  skeleton: true,
  mirror: true,
};

const DWELL_MS = 650; //         hover time to press a button in the air
const DWELL_REPEAT_MS = 420; //  auto-repeat for undo / size buttons
const CLEAR_HOLD_MS = 1200; //   fist hold time to wipe the canvas
const LOST_GRACE_MS = 180; //    tolerate brief tracking dropouts mid-stroke
const STORAGE_KEY = 'airink.settings.v1';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable (private mode) — settings just won't persist */
  }
}

/* ── Per-hand state ────────────────────────────────────── */

class HandState {
  constructor(id, filterParams) {
    this.id = id;
    // Pen up/down must feel instant; erase/clear must never fire on a glitch.
    this.stabilizer = new IntentStabilizer({
      holdMs: 70,
      minFrames: 2,
      per: { [Intent.ERASE]: { holdMs: 160, minFrames: 3 }, [Intent.CLEAR]: { holdMs: 220, minFrames: 4 } },
    });
    this.pinch = new PinchDetector();
    this.penFilter = new PointFilter({ ...filterParams, dCutoff: 1 });
    this.palmFilter = new PointFilter({ minCutoff: 1.2, beta: 0.01, dCutoff: 1 });
    this.intent = Intent.NONE;
    this.history = [];
    this.stroke = null;
    this.eraser = null;
    this.eraserRadius = 40;
    this.cursor = null;
    this.pen = null;
    this.screen = null;
    this.wrist = null;
    this.lostAt = null;
    this.dwellEl = null;
    this.dwellStart = 0;
    this.dwellLock = null;
    this.dwell = 0;
    this.clearStart = null;
    this.clearProgress = 0;
    this.clearFired = false;
  }
}

/* ── App ───────────────────────────────────────────────── */

class AirInk {
  constructor() {
    this.settings = loadSettings();
    this.video = $('#camera');
    this.board = new Board($('#board'));
    this.live = $('#live');
    this.lctx = this.live.getContext('2d');
    this.effects = new Effects();
    this.tracker = null;
    this.stream = null;
    this.hands = [];
    this.nextHandId = 1;
    this.fit = { ox: 0, oy: 0, dw: innerWidth, dh: innerHeight };
    this.dpr = 1;
    this.lastFrame = performance.now();
    this.lastVideoTime = -1;
    this.fps = 0;
    this.inferMs = 0;
    this.lastTelemetry = 0;
    this.lastHandSeen = 0;
    this.mouseStroke = null;
    this.mode = 'boot';
    this.primaryIntent = null;

    this.bindUI();
    this.resize();
    this.applySettings({ persist: false });
    addEventListener('resize', () => this.resize());
    this.board.onChange(() => this.updateReadout());
    requestAnimationFrame((t) => this.loop(t));
  }

  /* ── Boot ─────────────────────────────────────────────── */

  bootLog(text, cls = 'run') {
    const li = document.createElement('li');
    li.className = cls;
    const label = document.createElement('span');
    label.textContent = text;
    li.append(label);
    if (cls !== 'note') li.append(document.createElement('em'));
    $('#bootLog').append(li);
    const set = (state, tag) => {
      li.className = state;
      const em = li.querySelector('em');
      if (em) em.textContent = tag;
    };
    set(cls, cls === 'run' ? '····' : '');
    return { ok: (tag = 'OK') => set('ok', tag), fail: (tag = 'FAIL') => set('fail', tag) };
  }

  async start() {
    const startBtn = $('#startBtn');
    startBtn.disabled = true;
    startBtn.textContent = 'INITIALIZING';
    document.body.classList.add('booting');
    $('#bootLog').replaceChildren();

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.bootLog('Secure context', 'fail').fail('BLOCKED');
      this.bootLog('Camera needs https:// or http://localhost — run `npm start` and open the printed URL.', 'note');
      return this.bootFailed();
    }

    // Kick off model loading and the camera permission prompt in parallel.
    let step = null;
    // `?cpu` forces the CPU (XNNPACK) engine — handy if a GPU driver misbehaves.
    const preferGPU = !new URLSearchParams(location.search).has('cpu');
    const trackerPromise = new HandTracker()
      .init((msg) => {
        step?.ok();
        step = this.bootLog(msg);
      }, { preferGPU })
      .then((t) => {
        step?.ok(t.delegate);
        return t;
      });
    trackerPromise.catch(() => {}); // handled below

    const camStep = this.bootLog('Requesting camera access');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      const { videoWidth: w, videoHeight: h } = this.video;
      camStep.ok(`${w}×${h}`);
      this.resize();
      this.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        this.toast('CAMERA DISCONNECTED');
        this.setTracking('mouse', 'NO CAMERA');
      });
    } catch (err) {
      camStep.fail(err?.name === 'NotAllowedError' ? 'DENIED' : 'FAIL');
      this.bootLog(
        err?.name === 'NotAllowedError'
          ? 'Camera permission was blocked. Allow it from the address bar, then retry.'
          : err?.name === 'NotFoundError'
            ? 'No camera found. Connect a webcam, then retry.'
            : `Camera error: ${err?.message || err}`,
        'note',
      );
      return this.bootFailed();
    }

    try {
      this.tracker = await trackerPromise;
    } catch (err) {
      console.error(err);
      step?.fail();
      this.bootLog('Could not load the hand-tracking model. Check your connection and retry.', 'note');
      return this.bootFailed();
    }

    this.bootLog('Neural hand tracker online').ok('READY');
    setTimeout(() => this.enter('camera'), 450);
  }

  bootFailed() {
    document.body.classList.remove('booting');
    const startBtn = $('#startBtn');
    startBtn.disabled = false;
    startBtn.textContent = 'RETRY';
  }

  enter(mode) {
    this.mode = mode;
    document.body.classList.remove('booting');
    document.body.dataset.state = 'running';
    document.body.classList.toggle('camera-live', mode === 'camera');
    if (mode === 'camera') {
      this.setTracking('searching', 'SEARCHING');
      $('#tEngine').textContent = this.tracker.delegate;
    } else {
      this.setTracking('mouse', 'MOUSE MODE');
      $('#tEngine').textContent = 'N/A';
      this.toast('DRAW WITH MOUSE OR TOUCH');
    }
    this.lastHandSeen = performance.now();
  }

  setTracking(state, text) {
    if (document.body.dataset.tracking === state) return;
    document.body.dataset.tracking = state;
    $('#statusText').textContent = text;
  }

  /* ── Layout ───────────────────────────────────────────── */

  resize() {
    const w = innerWidth, h = innerHeight;
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.board.resize(w, h, this.dpr);
    this.live.width = Math.round(w * this.dpr);
    this.live.height = Math.round(h * this.dpr);
    this.live.style.width = `${w}px`;
    this.live.style.height = `${h}px`;
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
    const s = Math.max(w / vw, h / vh);
    this.fit = { dw: vw * s, dh: vh * s, ox: (w - vw * s) / 2, oy: (h - vh * s) / 2, vw, vh };
  }

  /** Normalised landmark → screen px, matching the CSS object-fit: cover video. */
  toScreen(p) {
    const x = this.settings.mirror ? 1 - p.x : p.x;
    return { x: this.fit.ox + x * this.fit.dw, y: this.fit.oy + p.y * this.fit.dh, z: p.z };
  }

  /* ── Settings & UI ────────────────────────────────────── */

  applySettings({ persist = true } = {}) {
    const s = this.settings;
    document.body.dataset.camera = s.camera;
    document.body.classList.toggle('mirror', s.mirror);
    document.documentElement.style.setProperty('--current', s.color);

    for (const el of $$('[data-action="color"]')) el.classList.toggle('active', el.dataset.value === s.color);
    for (const el of $$('[data-action="brush"]')) el.classList.toggle('active', el.dataset.value === s.brush);
    $('[data-action="shapes"]').classList.toggle('active', s.smartShapes);
    for (const el of $$('[data-action="set"]')) {
      el.classList.toggle('active', String(s[el.dataset.key]) === el.dataset.value);
    }
    const sv = $('#sizeValue');
    sv.querySelector('b').textContent = s.size;
    sv.style.setProperty('--dot', `${clamp(s.size, 4, 22)}px`);

    const pinch = s.drawTrigger === 'pinch';
    $('#drawGlyph').textContent = pinch ? '🤏' : '☝️';
    $('#drawLabel').textContent = pinch ? 'Pinch' : 'Index finger';
    $('#hint p').innerHTML = pinch
      ? 'Raise your hand and <b>pinch</b> thumb + index to draw'
      : 'Raise your hand and point your <b>index finger</b> to draw';
    $('#hint .hint-glyph').textContent = pinch ? '🤏' : '☝️';

    const params = smoothingToParams(s.smoothing);
    for (const h of this.hands) h.penFilter.configure(params);

    this.updateReadout();
    if (persist) saveSettings(s);
  }

  updateReadout() {
    const s = this.settings;
    $('#rBrush').textContent = BRUSH_NAMES[s.brush];
    $('#rSize').textContent = `${s.size}PX`;
    $('#rShapes').textContent = s.smartShapes ? 'SHAPES ON' : 'SHAPES OFF';
    const n = this.board.strokes.filter((st) => st.brush !== 'eraser').length;
    $('#rStrokes').textContent = `${n} STROKE${n === 1 ? '' : 'S'}`;
  }

  toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 1300);
  }

  bindUI() {
    $('#startBtn').addEventListener('click', () => this.start());
    $('#mouseBtn').addEventListener('click', () => this.enter('mouse'));
    this.video.addEventListener('resize', () => this.resize());

    const toolbar = $('#toolbar');
    const updateOverflow = () => {
      const left = toolbar.scrollLeft > 4;
      const right = toolbar.scrollLeft + toolbar.clientWidth < toolbar.scrollWidth - 4;
      toolbar.dataset.more = left && right ? 'both' : left ? 'left' : right ? 'right' : '';
    };
    toolbar.addEventListener('scroll', updateOverflow, { passive: true });
    addEventListener('resize', updateOverflow);
    requestAnimationFrame(updateOverflow);

    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (el) this.activate(el);
    });

    // Mouse / touch / pen drawing (also handy without a camera).
    addEventListener('pointerdown', (e) => {
      if (this.mode === 'boot' || e.button !== 0 || e.target.closest('.ui-zone')) return;
      const s = this.settings;
      this.mouseStroke = this.board.begin({ brush: s.brush, color: s.color, size: s.size });
      this.board.add(this.mouseStroke, e.clientX, e.clientY, performance.now());
    });
    addEventListener('pointermove', (e) => {
      if (!this.mouseStroke) return;
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ev of events) {
        if (this.board.add(this.mouseStroke, ev.clientX, ev.clientY, performance.now())) {
          this.effects.emit(ev.clientX, ev.clientY, this.settings.color, { count: 1 });
        }
      }
    });
    const endMouse = () => {
      if (!this.mouseStroke) return;
      this.finishStroke(this.mouseStroke);
      this.mouseStroke = null;
    };
    addEventListener('pointerup', endMouse);
    addEventListener('pointercancel', endMouse);

    addEventListener('keydown', (e) => {
      if (this.mode === 'boot') return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? this.run('redo') : this.run('undo'); }
      if (mod && k === 'y') { e.preventDefault(); return this.run('redo'); }
      if (mod && k === 's') { e.preventDefault(); return this.run('save'); }
      if (mod || e.altKey) return;
      const keymap = { z: 'undo', y: 'redo', c: 'clear', s: 'save', g: 'shapes', '[': 'size-down', ']': 'size-up' };
      if (keymap[k]) return this.run(keymap[k]);
      if (k >= '1' && k <= String(COLORS.length)) return this.run('color', COLORS[Number(k) - 1]);
      if (k === 'b') return this.run('brush', BRUSHES[(BRUSHES.indexOf(this.settings.brush) + 1) % BRUSHES.length]);
      if (k === 'h') {
        const order = ['dim', 'on', 'off'];
        return this.run('set', order[(order.indexOf(this.settings.camera) + 1) % order.length], 'camera');
      }
      if (k === 'k') return this.run('set', String(!this.settings.skeleton), 'skeleton');
      if (k === 'escape') $('#settings').hidden = true;
    });
  }

  activate(el) {
    el.classList.add('fired');
    setTimeout(() => el.classList.remove('fired'), 160);
    this.run(el.dataset.action, el.dataset.value, el.dataset.key);
  }

  run(action, value, key) {
    const s = this.settings;
    switch (action) {
      case 'color':
        s.color = value;
        break;
      case 'brush':
        s.brush = value;
        this.toast(`${BRUSH_NAMES[value]} BRUSH`);
        break;
      case 'size-down':
      case 'size-up': {
        const i = SIZES.findIndex((v) => v >= s.size);
        const idx = clamp((i < 0 ? SIZES.length - 1 : i) + (action === 'size-up' ? 1 : -1), 0, SIZES.length - 1);
        s.size = SIZES[idx];
        break;
      }
      case 'shapes':
        s.smartShapes = !s.smartShapes;
        this.toast(s.smartShapes ? 'SMART SHAPES ON' : 'SMART SHAPES OFF');
        break;
      case 'undo':
        this.toast(this.board.undo() ? 'UNDO' : 'NOTHING TO UNDO');
        return;
      case 'redo':
        this.toast(this.board.redo() ? 'REDO' : 'NOTHING TO REDO');
        return;
      case 'clear':
        this.clearAll();
        return;
      case 'save':
        this.save();
        return;
      case 'settings': {
        const panel = $('#settings');
        panel.hidden = !panel.hidden;
        $('#toolbar [data-action="settings"]').setAttribute('aria-expanded', String(!panel.hidden));
        return;
      }
      case 'set': {
        const current = s[key];
        s[key] = typeof current === 'boolean' ? value === 'true' : typeof current === 'number' ? Number(value) : value;
        if (key === 'drawTrigger') this.toast(value === 'pinch' ? 'PINCH TO DRAW' : 'POINT TO DRAW');
        if (key === 'camera') this.toast(`CAMERA: ${{ on: 'CLEAR', dim: 'HOLOGRAM', off: 'VOID' }[value]}`);
        break;
      }
      default:
        return;
    }
    this.applySettings();
  }

  clearAll(at) {
    if (!this.board.clear()) {
      this.toast('CANVAS EMPTY');
      return;
    }
    const x = at?.x ?? innerWidth / 2, y = at?.y ?? innerHeight / 2;
    this.effects.ring(x, y, '#ffb020', { maxRadius: Math.hypot(innerWidth, innerHeight) * 0.6, life: 900, width: 4 });
    this.effects.ring(x, y, '#00e5ff', { maxRadius: 220, life: 600 });
    this.effects.emit(x, y, '#ffb020', { count: 40, speed: 0.5, life: 700 });
    this.toast('CANVAS CLEARED · Z TO UNDO');
  }

  save() {
    const src = this.board.canvas;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#03060d';
    ctx.fillRect(0, 0, out.width, out.height);
    if (this.mode === 'camera' && this.settings.camera !== 'off' && this.video.videoWidth) {
      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      ctx.globalAlpha = this.settings.camera === 'dim' ? 0.4 : 0.85;
      if (this.settings.mirror) {
        ctx.translate(innerWidth, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(this.video, this.fit.ox, this.fit.oy, this.fit.dw, this.fit.dh);
      ctx.restore();
    }
    ctx.drawImage(src, 0, 0);
    ctx.font = `700 ${12 * this.dpr}px Orbitron, sans-serif`;
    ctx.fillStyle = 'rgba(0, 229, 255, 0.55)';
    ctx.textAlign = 'right';
    ctx.fillText('AIRINK', out.width - 16 * this.dpr, out.height - 16 * this.dpr);
    out.toBlob((blob) => {
      if (!blob) return this.toast('SAVE FAILED');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `airink-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      this.toast('SAVED PNG');
    }, 'image/png');
  }

  /* ── Strokes ──────────────────────────────────────────── */

  finishStroke(stroke, trimAfter = null) {
    if (trimAfter !== null) this.board.trimAfter(stroke, trimAfter);
    this.board.end(stroke, { smartShapes: this.settings.smartShapes, now: performance.now() });
  }

  /* ── Hand processing ──────────────────────────────────── */

  /** Greedy nearest-wrist matching keeps per-hand state stable across frames. */
  matchHands(detected, now) {
    const params = smoothingToParams(this.settings.smoothing);
    const free = new Set(this.hands);
    const maxJump = Math.hypot(innerWidth, innerHeight) * 0.3;
    const pairs = detected.map((d) => {
      const wrist = this.toScreen(d.landmarks[LM.WRIST]);
      let best = null, bestD = maxJump;
      for (const h of free) {
        const dd = dist(h.wrist, wrist);
        if (dd < bestD) { bestD = dd; best = h; }
      }
      if (best) free.delete(best);
      return { d, state: best };
    });
    const teleport = Math.hypot(innerWidth, innerHeight) * 0.12;
    for (const p of pairs) {
      if (!p.state) {
        p.state = new HandState(this.nextHandId++, params);
        this.hands.push(p.state);
      } else if (dist(p.state.wrist, this.toScreen(p.d.landmarks[LM.WRIST])) > teleport) {
        // Big jump (re-acquired hand): don't let the smoother sweep across the gap.
        p.state.penFilter.reset();
        p.state.palmFilter.reset();
        p.state.history.length = 0;
      }
      p.state.lostAt = null;
    }
    // Hands that vanished: keep briefly (grace period), then finalise.
    for (const h of free) {
      h.lostAt ??= now;
      if (now - h.lostAt > LOST_GRACE_MS) this.releaseHand(h);
    }
    return pairs;
  }

  releaseHand(h) {
    if (h.stroke) this.finishStroke(h.stroke);
    if (h.eraser) this.board.end(h.eraser);
    this.setDwell(h, null);
    this.hands = this.hands.filter((x) => x !== h);
  }

  processHands(rawDetections, now) {
    const aspect = this.fit.vw / this.fit.vh;
    const s = this.settings;
    const detected = dedupeHands(rawDetections);

    for (const { d, state: h } of this.matchHands(detected, now)) {
      // Raw labels assume a mirrored image; we feed raw frames, so flip.
      h.side = d.handedness === 'Left' ? 'RIGHT' : d.handedness === 'Right' ? 'LEFT' : 'HAND';
      h.score = d.score;
      h.screen = d.landmarks.map((p) => this.toScreen(p));
      h.wrist = h.screen[LM.WRIST];
      h.color = s.color;

      const analysis = analyzeHand(d.landmarks, aspect);
      h.pose = analysis.pose;
      h.analysis = analysis;
      const pinching = h.pinch.update(analysis);
      const r = h.stabilizer.update(poseToIntent(analysis, s.drawTrigger, pinching), now);
      h.intent = r.state;

      // Pen position: index fingertip (or the pinch point), One-Euro filtered.
      const sc = h.screen;
      const penRaw = s.drawTrigger === 'pinch'
        ? { x: (sc[LM.THUMB_TIP].x + sc[LM.INDEX_TIP].x) / 2, y: (sc[LM.THUMB_TIP].y + sc[LM.INDEX_TIP].y) / 2 }
        : sc[LM.INDEX_TIP];
      const pen = h.penFilter.filter(penRaw, now);
      h.pen = pen;
      h.history.push({ x: pen.x, y: pen.y, t: now });
      while (h.history.length && now - h.history[0].t > 400) h.history.shift();

      const palmIdx = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
      const palm = h.palmFilter.filter({
        x: palmIdx.reduce((a, i) => a + sc[i].x, 0) / palmIdx.length,
        y: palmIdx.reduce((a, i) => a + sc[i].y, 0) / palmIdx.length,
      }, now);

      h.cursor = h.intent === Intent.ERASE || h.intent === Intent.CLEAR ? palm : pen;

      const uiZone = this.uiZoneAt(pen);
      const button = uiZone ? this.buttonAt(pen) : null;

      // ── Draw ──
      if (h.intent === Intent.DRAW && !uiZone) {
        if (!h.stroke) {
          h.stroke = this.board.begin({ brush: s.brush, color: s.color, size: s.size });
          // Backfill the few frames spent confirming the gesture → crisp stroke starts.
          if (r.changed) for (const p of h.history) if (p.t >= r.changeStartedAt) this.board.add(h.stroke, p.x, p.y, p.t);
        }
        if (this.board.add(h.stroke, pen.x, pen.y, now)) {
          this.effects.emit(pen.x, pen.y, s.brush === 'rainbow' ? hslToHex((now / 6) % 360) : s.color, { count: 2 });
        }
      } else if (h.stroke) {
        // Cut the tail drawn while the hand was already changing gesture.
        const trim = r.changed && r.previous === Intent.DRAW ? r.changeStartedAt : null;
        this.finishStroke(h.stroke, trim);
        h.stroke = null;
      }

      // ── Erase ──
      if (h.intent === Intent.ERASE) {
        h.eraserRadius = clamp(dist(sc[LM.INDEX_MCP], sc[LM.PINKY_MCP]) * 0.9, 26, 150);
        if (!h.eraser) h.eraser = this.board.begin({ brush: 'eraser', color: '#000', size: h.eraserRadius * 2 });
        this.board.add(h.eraser, palm.x, palm.y, now);
      } else if (h.eraser) {
        this.board.end(h.eraser);
        h.eraser = null;
      }

      // ── Fist hold → clear ──
      if (h.intent === Intent.CLEAR) {
        h.clearStart ??= h.stabilizer.since;
        h.clearProgress = clamp((now - h.clearStart) / CLEAR_HOLD_MS, 0, 1);
        if (h.clearProgress >= 1 && !h.clearFired) {
          h.clearFired = true;
          this.clearAll(palm);
        }
      } else {
        h.clearStart = null;
        h.clearProgress = 0;
        h.clearFired = false;
      }

      // ── In-air button presses (dwell) ──
      const canPress = (h.intent === Intent.HOVER || h.intent === Intent.DRAW) && !h.stroke;
      this.updateDwell(h, canPress ? button : null, now);
    }

    // Status + legend reflect the most recently tracked hand.
    const visible = this.hands.filter((h) => !h.lostAt);
    if (visible.length) {
      this.lastHandSeen = now;
      this.setTracking('tracking', visible.length > 1 ? 'TRACKING ×2' : 'TRACKING');
    } else {
      this.setTracking('searching', 'SEARCHING');
    }
    const intent = visible[0]?.intent ?? null;
    if (intent !== this.primaryIntent) {
      this.primaryIntent = intent;
      for (const li of $$('#legend li')) li.classList.toggle('active', li.dataset.intent === intent);
    }
  }

  uiZoneAt(p) {
    if (p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) return null;
    return document.elementFromPoint(p.x, p.y)?.closest('.ui-zone') ?? null;
  }

  buttonAt(p) {
    const el = document.elementFromPoint(p.x, p.y)?.closest('[data-action]');
    return el && !el.closest('[hidden]') ? el : null;
  }

  setDwell(h, el) {
    if (h.dwellEl && h.dwellEl !== el && !this.hands.some((o) => o !== h && o.dwellEl === h.dwellEl)) {
      h.dwellEl.classList.remove('dwelling');
      h.dwellEl.style.removeProperty('--dwell');
    }
    h.dwellEl = el;
  }

  updateDwell(h, target, now) {
    if (target !== h.dwellEl) {
      this.setDwell(h, target);
      h.dwellStart = now;
      if (target !== h.dwellLock) h.dwellLock = null;
    }
    if (!target || target === h.dwellLock) {
      h.dwell = 0;
      if (target) {
        target.classList.remove('dwelling');
        target.style.removeProperty('--dwell');
      }
      return;
    }
    h.dwell = clamp((now - h.dwellStart) / DWELL_MS, 0, 1);
    target.classList.add('dwelling');
    target.style.setProperty('--dwell', h.dwell.toFixed(3));
    if (h.dwell >= 1) {
      this.activate(target);
      this.effects.emit(h.pen.x, h.pen.y, '#ffffff', { count: 14, speed: 0.25, life: 450 });
      if (target.hasAttribute('data-repeat')) {
        h.dwellStart = now - DWELL_MS + DWELL_REPEAT_MS; // auto-repeat while held
      } else {
        h.dwellLock = target; // must move away before pressing again
      }
      h.dwell = 0;
      target.style.setProperty('--dwell', '0');
    }
  }

  /* ── Frame loop ───────────────────────────────────────── */

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(64, now - this.lastFrame);
    this.lastFrame = now;
    if (dt > 0) this.fps += (1000 / dt - this.fps) * 0.08;

    if (this.mode === 'camera' && this.tracker && this.video.readyState >= 2) {
      const vt = this.video.currentTime;
      if (vt !== this.lastVideoTime) {
        this.lastVideoTime = vt;
        const t0 = performance.now();
        try {
          const { hands } = this.tracker.detect(this.video, now);
          this.inferMs += (performance.now() - t0 - this.inferMs) * 0.15;
          this.processHands(hands, now);
        } catch (err) {
          console.error('Hand detection failed', err);
        }
      }
    }

    for (const m of this.board.update(now)) {
      const { shape, stroke } = m;
      this.effects.label(shape.center.x, shape.center.y, SHAPE_NAMES[shape.type] ?? shape.type.toUpperCase(), stroke.color === '#f4f8ff' ? '#00e5ff' : stroke.color, {
        sub: `MATCH ${Math.round(shape.confidence * 100)}%`,
      });
      this.effects.burstAlong(m.to, stroke.color, 0.5);
    }

    this.effects.update(dt);
    this.render(now);

    if (now - this.lastTelemetry > 250) {
      this.lastTelemetry = now;
      $('#tFps').textContent = Math.round(this.fps);
      $('#tInfer').textContent = this.tracker ? this.inferMs.toFixed(1) : '--';
      $('#tHands').textContent = this.hands.filter((h) => !h.lostAt).length;
      $('#hint').hidden = !(this.mode === 'camera' && this.board.isEmpty && now - this.lastHandSeen > 1500);
    }
  }

  render(now) {
    const ctx = this.lctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.board.renderLive(ctx, now);
    this.effects.render(ctx);
    for (const h of this.hands) {
      if (h.lostAt || !h.screen) continue;
      if (this.settings.skeleton) drawHand(ctx, h, now);
      drawCursor(ctx, h, now, this.settings.size);
    }
  }
}

/** The detector occasionally reports one hand twice — keep the most confident copy. */
function dedupeHands(hands) {
  const kept = [];
  for (const d of [...hands].sort((a, b) => b.score - a.score)) {
    const lm = d.landmarks;
    const palm = Math.hypot(lm[LM.WRIST].x - lm[LM.MIDDLE_MCP].x, lm[LM.WRIST].y - lm[LM.MIDDLE_MCP].y);
    const duplicate = kept.some((k) => {
      let sum = 0;
      for (let i = 0; i < 21; i++) sum += Math.hypot(k.landmarks[i].x - lm[i].x, k.landmarks[i].y - lm[i].y);
      return sum / 21 < palm * 0.35;
    });
    if (!duplicate) kept.push(d);
  }
  return kept;
}

function hslToHex(h, sat = 1, light = 0.6) {
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

window.airink = new AirInk();
