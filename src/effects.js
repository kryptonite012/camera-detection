import { rgba } from './brushes.js';

/**
 * Lightweight additive particle system + shockwave rings + floating labels.
 * Purely cosmetic; capped so it never costs more than a fraction of a frame.
 */
export class Effects {
  constructor({ maxParticles = 600 } = {}) {
    this.maxParticles = maxParticles;
    this.particles = [];
    this.rings = [];
    this.labels = [];
  }

  emit(x, y, color, { count = 3, speed = 0.12, life = 520, size = 2.2, spread = Math.PI * 2, angle = 0 } = {}) {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.maxParticles) this.particles.shift();
      const a = angle + (Math.random() - 0.5) * spread;
      const v = speed * (0.35 + Math.random());
      this.particles.push({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: life * (0.6 + Math.random() * 0.6),
        age: 0,
        size: size * (0.5 + Math.random()),
        color,
      });
    }
  }

  burstAlong(points, color, density = 0.5) {
    const step = Math.max(1, Math.round(1 / density));
    for (let i = 0; i < points.length; i += step) {
      this.emit(points[i].x, points[i].y, color, { count: 2, speed: 0.08, life: 700, size: 2 });
    }
  }

  ring(x, y, color, { maxRadius = 160, life = 650, width = 3 } = {}) {
    this.rings.push({ x, y, color, maxRadius, life, age: 0, width });
  }

  label(x, y, text, color, { life = 1400, sub = '' } = {}) {
    this.labels.push({ x, y, text, sub, color, life, age: 0 });
  }

  update(dt) {
    const drag = Math.pow(0.996, dt);
    this.particles = this.particles.filter((p) => {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy = p.vy * drag + 0.00012 * dt; // a whisper of gravity
      return p.age < p.life;
    });
    this.rings = this.rings.filter((r) => (r.age += dt) < r.life);
    this.labels = this.labels.filter((l) => (l.age += dt) < l.life);
  }

  render(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const k = 1 - p.age / p.life;
      ctx.fillStyle = rgba(p.color, 0.85 * k);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * k), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const r of this.rings) {
      const t = r.age / r.life;
      const e = 1 - Math.pow(1 - t, 3);
      ctx.strokeStyle = rgba(r.color, 0.9 * (1 - t));
      ctx.lineWidth = r.width * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.maxRadius * e, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of this.labels) {
      const t = l.age / l.life;
      const alpha = t < 0.15 ? t / 0.15 : t > 0.7 ? (1 - t) / 0.3 : 1;
      const y = l.y - 18 * t;
      ctx.globalAlpha = alpha;
      ctx.font = '700 15px Orbitron, "Segoe UI", sans-serif';
      const w = ctx.measureText(l.text).width + 28;
      ctx.fillStyle = 'rgba(4, 10, 20, 0.72)';
      ctx.strokeStyle = rgba(l.color, 0.8);
      ctx.lineWidth = 1;
      roundRect(ctx, l.x - w / 2, y - 15, w, l.sub ? 42 : 30, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = l.color;
      ctx.shadowColor = l.color;
      ctx.shadowBlur = 10;
      ctx.fillText(l.text, l.x, y);
      ctx.shadowBlur = 0;
      if (l.sub) {
        ctx.font = '500 11px "JetBrains Mono", monospace';
        ctx.fillStyle = 'rgba(200, 230, 255, 0.75)';
        ctx.fillText(l.sub, l.x, y + 17);
      }
    }
    ctx.restore();
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
