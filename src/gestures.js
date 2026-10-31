/**
 * Hand pose analysis on MediaPipe's 21-point hand landmarks.
 *
 *   0 wrist
 *   1-4   thumb  (CMC, MCP, IP, TIP)
 *   5-8   index  (MCP, PIP, DIP, TIP)
 *   9-12  middle
 *   13-16 ring
 *   17-20 pinky
 *
 * Everything here is pure math (no DOM), so it runs in Node tests too.
 */

export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const FINGERTIPS = [4, 8, 12, 16, 20];

/** Raw hand poses recognised from finger states. */
export const Pose = {
  POINT: 'point', // index only            ☝️
  PEACE: 'peace', // index + middle        ✌️
  PALM: 'palm', //   all four fingers      ✋
  FIST: 'fist', //   nothing extended      ✊
  THUMB: 'thumb', // thumb only            👍
  OTHER: 'other',
};

/** What the app should do with a hand. */
export const Intent = {
  DRAW: 'draw',
  HOVER: 'hover',
  ERASE: 'erase',
  CLEAR: 'clear',
  NONE: 'none',
};

const FINGERS = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (v) => Math.hypot(v.x, v.y, v.z);
const dist = (a, b) => len(sub(a, b));
const cosAngle = (u, v) => {
  const d = len(u) * len(v);
  return d === 0 ? 1 : (u.x * v.x + u.y * v.y + u.z * v.z) / d;
};

/**
 * Normalised landmarks are anisotropic (x is relative to width, y to height).
 * Convert to an isotropic space so angles and distances are meaningful.
 * MediaPipe's z uses roughly the same scale as x.
 */
export function toIsotropic(landmarks, aspect) {
  return landmarks.map((p) => ({ x: p.x * aspect, y: p.y, z: (p.z || 0) * aspect }));
}

function fingerMetrics(pts, [mcp, pip, dip, tip]) {
  const wrist = pts[0];
  // Straightness: how aligned the proximal and distal bones are (1 = straight).
  const straight = (cosAngle(sub(pts[pip], pts[mcp]), sub(pts[dip], pts[pip])) +
    cosAngle(sub(pts[dip], pts[pip]), sub(pts[tip], pts[dip]))) / 2;
  // Reach: an extended fingertip sits far beyond its PIP joint relative to the wrist.
  const reach = dist(pts[tip], wrist) / Math.max(1e-6, dist(pts[pip], wrist));
  return { straight, reach };
}

/**
 * Analyse a single hand.
 * @param {{x:number,y:number,z:number}[]} landmarks normalised MediaPipe landmarks
 * @param {number} aspect video width / height
 */
export function analyzeHand(landmarks, aspect = 1) {
  const pts = toIsotropic(landmarks, aspect);
  const palm = Math.max(1e-6, dist(pts[LM.WRIST], pts[LM.MIDDLE_MCP]));

  const fingers = {};
  const metrics = {};
  for (const [name, idx] of Object.entries(FINGERS)) {
    const m = fingerMetrics(pts, idx);
    metrics[name] = m;
    fingers[name] = m.straight > 0.55 && m.reach > 1.12;
  }

  // Thumb: straight and its tip held away from the palm (index MCP / pinky side).
  const thumbStraight = cosAngle(sub(pts[3], pts[2]), sub(pts[4], pts[3]));
  const thumbSpread = dist(pts[LM.THUMB_TIP], pts[LM.INDEX_MCP]) / palm;
  const thumbOut = dist(pts[LM.THUMB_TIP], pts[LM.PINKY_MCP]) / Math.max(1e-6, dist(pts[LM.THUMB_MCP], pts[LM.PINKY_MCP]));
  metrics.thumb = { straight: thumbStraight, spread: thumbSpread, out: thumbOut };
  fingers.thumb = thumbStraight > 0.7 && thumbSpread > 0.6 && thumbOut > 1.15;

  const pinchDistance = dist(pts[LM.THUMB_TIP], pts[LM.INDEX_TIP]) / palm;

  const { index, middle, ring, pinky, thumb } = fingers;
  const count = [index, middle, ring, pinky].filter(Boolean).length;
  let pose = Pose.OTHER;
  if (count === 4) pose = Pose.PALM;
  else if (index && !middle && !ring && !pinky) pose = Pose.POINT;
  else if (index && middle && !ring && !pinky) pose = Pose.PEACE;
  else if (count === 0) pose = thumb ? Pose.THUMB : Pose.FIST;

  return { pose, fingers, metrics, pinchDistance, palmSize: palm };
}

/** Map a pose to an app intent given the chosen draw trigger. */
export function poseToIntent(analysis, drawTrigger = 'index', pinching = false) {
  if (drawTrigger === 'pinch') {
    if (pinching) return Intent.DRAW;
    if (analysis.pose === Pose.PALM) return Intent.ERASE;
    if (analysis.pose === Pose.FIST) return Intent.CLEAR;
    return Intent.HOVER;
  }
  switch (analysis.pose) {
    case Pose.POINT: return Intent.DRAW;
    case Pose.PALM: return Intent.ERASE;
    case Pose.FIST: return Intent.CLEAR;
    default: return Intent.HOVER;
  }
}

/** Pinch detector with hysteresis so the pen doesn't flicker at the threshold. */
export class PinchDetector {
  constructor({ enter = 0.32, exit = 0.48 } = {}) {
    this.enter = enter;
    this.exit = exit;
    this.active = false;
  }
  /** @param {ReturnType<typeof analyzeHand>} analysis */
  update(analysis) {
    // A fist also brings thumb and index together — require the index finger
    // to be at least partly raised so curling the hand never reads as a pinch.
    const indexRaised = analysis.metrics.index.reach > 0.85;
    const d = analysis.pinchDistance;
    this.active = indexRaised && (this.active ? d < this.exit : d < this.enter);
    return this.active;
  }
  reset() {
    this.active = false;
  }
}

/**
 * Debounces intents: a new intent must persist for `holdMs` and `minFrames`
 * before it becomes the stable state. Exposes when the change started so the
 * caller can trim / backfill stroke points precisely.
 */
export class IntentStabilizer {
  /**
   * @param {object} opts
   * @param {number} opts.holdMs     default confirmation time
   * @param {number} opts.minFrames  default confirmation frames
   * @param {Record<string, {holdMs?:number, minFrames?:number}>} opts.per
   *        stricter confirmation for specific intents (e.g. destructive ones)
   */
  constructor({ holdMs = 70, minFrames = 2, per = {} } = {}) {
    this.holdMs = holdMs;
    this.minFrames = minFrames;
    this.per = per;
    this.reset();
  }
  reset() {
    this.state = Intent.NONE;
    this.since = 0;
    this.candidate = null;
    this.candidateSince = 0;
    this.candidateFrames = 0;
  }
  update(intent, now) {
    if (intent === this.state) {
      this.candidate = null;
      this.candidateFrames = 0;
      return { state: this.state, changed: false };
    }
    if (intent !== this.candidate) {
      this.candidate = intent;
      this.candidateSince = now;
      this.candidateFrames = 0;
    }
    this.candidateFrames++;
    const holdMs = this.per[intent]?.holdMs ?? this.holdMs;
    const minFrames = this.per[intent]?.minFrames ?? this.minFrames;
    if (this.candidateFrames >= minFrames && now - this.candidateSince >= holdMs) {
      const previous = this.state;
      this.state = intent;
      this.since = this.candidateSince;
      this.candidate = null;
      this.candidateFrames = 0;
      return { state: this.state, changed: true, previous, changeStartedAt: this.since };
    }
    return { state: this.state, changed: false };
  }
}
