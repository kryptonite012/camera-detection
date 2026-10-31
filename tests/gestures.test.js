import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analyzeHand, poseToIntent, Pose, Intent, IntentStabilizer, PinchDetector,
} from '../src/gestures.js';
import { OneEuroFilter } from '../src/filters.js';

// Real MediaPipe landmarks extracted from MediaPipe's own test photos.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/hands.json', import.meta.url)));
const hand = (name, i = 0) => {
  const f = fixtures[name];
  return { landmarks: f.hands[i].map(([x, y, z]) => ({ x, y, z })), aspect: f.aspect };
};

const expectations = {
  pointing_up: Pose.POINT,
  victory: Pose.PEACE,
  fist: Pose.FIST,
  thumb_up: Pose.THUMB,
  right_hands: Pose.PALM,
  left_hands: Pose.PALM,
};

for (const [name, pose] of Object.entries(expectations)) {
  test(`classifies ${name} as ${pose}`, () => {
    for (let i = 0; i < fixtures[name].hands.length; i++) {
      const { landmarks, aspect } = hand(name, i);
      assert.equal(analyzeHand(landmarks, aspect).pose, pose);
    }
  });
}

test('classification is rotation invariant (hand pointing sideways)', () => {
  const { landmarks, aspect } = hand('pointing_up');
  // Rotate 90° around the wrist in isotropic space.
  const w = landmarks[0];
  const rotated = landmarks.map((p) => ({
    x: w.x + (-(p.y - w.y)) / aspect,
    y: w.y + (p.x - w.x) * aspect,
    z: p.z,
  }));
  assert.equal(analyzeHand(rotated, aspect).pose, Pose.POINT);
});

test('maps poses to intents for the index-finger trigger', () => {
  const a = (name) => analyzeHand(hand(name).landmarks, hand(name).aspect);
  assert.equal(poseToIntent(a('pointing_up'), 'index'), Intent.DRAW);
  assert.equal(poseToIntent(a('victory'), 'index'), Intent.HOVER);
  assert.equal(poseToIntent(a('right_hands'), 'index'), Intent.ERASE);
  assert.equal(poseToIntent(a('fist'), 'index'), Intent.CLEAR);
  assert.equal(poseToIntent(a('thumb_up'), 'index'), Intent.HOVER);
});

test('pinch trigger: pointing hovers, a fist never counts as a pinch', () => {
  const a = (name) => analyzeHand(hand(name).landmarks, hand(name).aspect);
  const pinch = new PinchDetector();
  assert.equal(pinch.update(a('fist')), false);
  assert.equal(poseToIntent(a('pointing_up'), 'pinch', false), Intent.HOVER);
  assert.equal(poseToIntent(a('pointing_up'), 'pinch', true), Intent.DRAW);
});

test('pinch detector uses hysteresis', () => {
  const p = new PinchDetector({ enter: 0.3, exit: 0.5 });
  const fake = (d) => ({ pinchDistance: d, metrics: { index: { reach: 1 } } });
  assert.equal(p.update(fake(0.4)), false);
  assert.equal(p.update(fake(0.25)), true);
  assert.equal(p.update(fake(0.45)), true, 'stays pinched inside the hysteresis band');
  assert.equal(p.update(fake(0.55)), false);
});

test('stabilizer ignores single-frame flicker and reports change start', () => {
  const s = new IntentStabilizer({ holdMs: 60, minFrames: 2 });
  let t = 0;
  const step = (intent) => s.update(intent, (t += 33));
  step(Intent.HOVER); step(Intent.HOVER); step(Intent.HOVER);
  assert.equal(s.state, Intent.HOVER);
  // one-frame glitch
  step(Intent.DRAW);
  step(Intent.HOVER);
  assert.equal(s.state, Intent.HOVER);
  // sustained change
  const r1 = step(Intent.DRAW);
  assert.equal(r1.changed, false);
  step(Intent.DRAW);
  const r3 = step(Intent.DRAW);
  assert.equal(s.state, Intent.DRAW);
  assert.ok(r3.changed);
  assert.equal(r3.previous, Intent.HOVER);
  assert.equal(r3.changeStartedAt, t - 66);
});

test('stabilizer can demand longer confirmation for destructive intents', () => {
  const s = new IntentStabilizer({ holdMs: 60, minFrames: 2, per: { [Intent.CLEAR]: { holdMs: 200, minFrames: 4 } } });
  let t = 0;
  const step = (intent) => s.update(intent, (t += 33));
  step(Intent.DRAW); step(Intent.DRAW); step(Intent.DRAW);
  assert.equal(s.state, Intent.DRAW);
  for (let i = 0; i < 4; i++) step(Intent.CLEAR); // ~100 ms of a misread fist
  assert.equal(s.state, Intent.DRAW, 'short fist glitch must not interrupt drawing');
  for (let i = 0; i < 4; i++) step(Intent.CLEAR);
  assert.equal(s.state, Intent.CLEAR);
});

test('One Euro filter smooths jitter but tracks fast motion', () => {
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0.02 });
  // Stationary signal with ±5 px noise → output varies far less.
  let maxDev = 0;
  for (let i = 0; i < 120; i++) {
    const v = f.filter(100 + (i % 2 ? 5 : -5), i / 60);
    if (i > 30) maxDev = Math.max(maxDev, Math.abs(v - 100));
  }
  assert.ok(maxDev < 2, `jitter suppressed (max deviation ${maxDev.toFixed(2)})`);
  // Fast ramp → lag stays small thanks to the speed-adaptive cutoff.
  f.reset();
  let v = 0;
  for (let i = 0; i < 60; i++) v = f.filter(i * 20, i / 60); // 1200 px/s
  assert.ok(59 * 20 - v < 40, `lag ${(59 * 20 - v).toFixed(1)} px`);
});
