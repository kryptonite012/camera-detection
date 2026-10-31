import { HAND_CONNECTIONS, FINGERTIPS, Intent } from './gestures.js';
import { rgba } from './brushes.js';
import { roundRect } from './effects.js';

const HUD = '#00e5ff';

const INTENT_LABEL = {
  [Intent.DRAW]: 'DRAW',
  [Intent.HOVER]: 'HOVER',
  [Intent.ERASE]: 'ERASE',
  [Intent.CLEAR]: 'CLEAR',
  [Intent.NONE]: 'SCAN',
};

/** Glowing skeleton + depth-scaled joints + targeting brackets for one hand. */
export function drawHand(ctx, hand, now) {
  const pts = hand.screen;
  const accent = hand.intent === Intent.DRAW ? hand.color : hand.intent === Intent.ERASE ? '#ff4d6d' : HUD;

  ctx.save();
  ctx.lineCap = 'round';

  // Bones
  ctx.shadowColor = HUD;
  ctx.shadowBlur = 8;
  ctx.strokeStyle = rgba(HUD, 0.55);
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
  }
  ctx.stroke();

  // Joints — nearer joints (more negative z) render larger.
  ctx.shadowBlur = 6;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const depth = Math.max(0.6, Math.min(1.8, 1 - p.z * 6));
    const tip = FINGERTIPS.includes(i);
    ctx.fillStyle = tip ? '#ffffff' : rgba(HUD, 0.9);
    ctx.beginPath();
    ctx.arc(p.x, p.y, (tip ? 3.6 : 2.4) * depth, 0, Math.PI * 2);
    ctx.fill();
    if (tip) {
      ctx.strokeStyle = rgba(HUD, 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7 * depth, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;

  // Targeting brackets
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const pad = 18;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const L = Math.min(22, (maxX - minX) / 4);
  ctx.strokeStyle = rgba(accent, 0.85);
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [x, y, dx, dy] of [[minX, minY, 1, 1], [maxX, minY, -1, 1], [maxX, maxY, -1, -1], [minX, maxY, 1, -1]]) {
    ctx.moveTo(x, y + dy * L);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * L, y);
  }
  ctx.stroke();

  // Scan line sweeping through the box
  const sweep = ((now / 1400) % 1);
  const sy = minY + (maxY - minY) * sweep;
  const grad = ctx.createLinearGradient(minX, 0, maxX, 0);
  grad.addColorStop(0, rgba(accent, 0));
  grad.addColorStop(0.5, rgba(accent, 0.35));
  grad.addColorStop(1, rgba(accent, 0));
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(minX, sy);
  ctx.lineTo(maxX, sy);
  ctx.stroke();

  // Tag
  const tag = `${hand.side} · ${Math.round(hand.score * 100)}% · ${INTENT_LABEL[hand.intent] ?? ''}`;
  ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
  const tw = ctx.measureText(tag).width + 16;
  const ty = minY - 26;
  ctx.fillStyle = 'rgba(2, 8, 18, 0.75)';
  roundRect(ctx, minX, ty, tw, 20, 4);
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.7);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(tag, minX + 8, ty + 10.5);

  ctx.restore();
}

/** The reticle that follows the active fingertip (or palm, when erasing). */
export function drawCursor(ctx, hand, now, size) {
  const { cursor, intent, color } = hand;
  if (!cursor) return;
  const { x, y } = cursor;
  ctx.save();
  ctx.lineCap = 'round';

  if (intent === Intent.ERASE) {
    const r = hand.eraserRadius;
    ctx.strokeStyle = 'rgba(255, 77, 109, 0.9)';
    ctx.shadowColor = '#ff4d6d';
    ctx.shadowBlur = 12;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.lineDashOffset = -now / 30;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 77, 109, 0.08)';
    ctx.fill();
    ctx.restore();
    return;
  }

  if (intent === Intent.CLEAR) {
    const p = hand.clearProgress ?? 0;
    const r = 46;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#ffb020';
    ctx.shadowColor = '#ffb020';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffb020';
    ctx.font = '700 11px Orbitron, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p >= 1 ? 'CLEARED' : 'HOLD', x, y - 6);
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.fillText(p >= 1 ? '' : 'TO CLEAR', x, y + 8);
    ctx.restore();
    return;
  }

  const drawing = intent === Intent.DRAW;
  const spin = now / 900;
  const r = drawing ? Math.max(9, size * 0.9) : 16;

  // Rotating segmented ring
  ctx.strokeStyle = drawing ? color : rgba(HUD, 0.95);
  ctx.shadowColor = drawing ? color : HUD;
  ctx.shadowBlur = 12;
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const a = spin + (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.arc(x, y, r, a, a + Math.PI / 3.2);
    ctx.stroke();
  }
  // Crosshair ticks
  if (!drawing) {
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(x + dx * (r + 4), y + dy * (r + 4));
      ctx.lineTo(x + dx * (r + 10), y + dy * (r + 10));
    }
    ctx.stroke();
  }
  // Core
  ctx.fillStyle = drawing ? color : '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, drawing ? Math.max(2.5, size * 0.35) : 2.5, 0, Math.PI * 2);
  ctx.fill();

  // Dwell progress for in-air button presses
  if (hand.dwell > 0) {
    ctx.strokeStyle = '#ffffff';
    ctx.shadowColor = HUD;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r + 7, -Math.PI / 2, -Math.PI / 2 + hand.dwell * Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
