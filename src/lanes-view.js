// Chart notes on the same time axis as the tempo chart: one row per pad,
// kick along the bottom. Cymbals are drawn as diamonds, pads and toms as bars.
import { formatTime } from './chart.js';

const ROWS = ['red', 'yellow', 'blue', 'green', 'kick'];
const LANE_LABEL = { kick: 'Kick', red: 'Red', yellow: 'Yellow', blue: 'Blue', green: 'Green' };

export class LanesView {
  constructor(root, tooltip, chart) {
    this.root = root;
    this.tooltip = tooltip;
    this.chart = chart; // shares its layout
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.root.append(this.canvas);
    this.notes = [];
    this.duration = 0;
    this.playhead = null;
    new ResizeObserver(() => this.draw()).observe(this.root);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
    new MutationObserver(() => this.draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.canvas.addEventListener('pointermove', (e) => this.hover(e.offsetX, e.offsetY));
    this.canvas.addEventListener('pointerleave', () => { this.tooltip.hidden = true; });
    this.canvas.addEventListener('click', (e) => {
      if (this.duration && this.chart.onSeek) this.chart.onSeek(this.xToTime(e.offsetX));
    });
  }

  // notes: [{ time, lane, cymbal, bar, beatInBar }]
  setNotes(notes, duration) {
    this.notes = notes;
    this.duration = duration;
    const counts = {};
    for (const n of notes) counts[n.lane] = (counts[n.lane] ?? 0) + 1;
    this.canvas.setAttribute('aria-label', notes.length
      ? `Drum chart: ${notes.length} notes. ${ROWS.map((l) => `${LANE_LABEL[l]} ${counts[l] ?? 0}`).join(', ')}`
      : 'No drum notes');
    this.draw();
  }

  setPlayhead(t) {
    this.playhead = t;
    this.draw();
  }

  layout() {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    return { w, h, left: 44, right: w - 12, top: 4, bottom: h - 4 };
  }

  xToTime(x) {
    const { left, right } = this.layout();
    return Math.max(0, Math.min(1, (x - left) / (right - left))) * this.duration;
  }

  draw() {
    const { w, h, left, right, top, bottom } = this.layout();
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim();
    const rowH = (bottom - top) / ROWS.length;
    const y = (lane) => top + rowH * (ROWS.indexOf(lane) + 0.5);

    ctx.font = `11px ${color('--font-mono')}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const lane of ROWS) {
      ctx.strokeStyle = color('--grid');
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, Math.round(y(lane)) + 0.5); ctx.lineTo(right, Math.round(y(lane)) + 0.5); ctx.stroke();
      ctx.fillStyle = color(`--lane-${lane}`);
      ctx.fillRect(left - 16, y(lane) - 3, 6, 6);
    }
    if (!this.duration) return;
    const x = (t) => left + (t / this.duration) * (right - left);
    for (const n of this.notes) {
      const cx = x(n.time);
      const cy = y(n.lane);
      ctx.fillStyle = color(`--lane-${n.lane}`);
      if (n.lane === 'kick') {
        ctx.fillRect(cx - 1, cy - rowH * 0.35, 2, rowH * 0.7);
      } else if (n.cymbal) {
        const r = Math.min(4, rowH * 0.35);
        ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); ctx.fill();
      } else {
        ctx.fillRect(cx - 1.5, cy - rowH * 0.3, 3, rowH * 0.6);
      }
    }
    if (this.playhead != null) {
      ctx.strokeStyle = color('--fg');
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x(this.playhead), top); ctx.lineTo(x(this.playhead), bottom); ctx.stroke();
    }
  }

  hover(px, py) {
    const { left, right } = this.layout();
    if (!this.notes.length || px < left || px > right) { this.tooltip.hidden = true; return; }
    const t = this.xToTime(px);
    const tol = (6 / (right - left)) * this.duration;
    const near = this.notes.filter((n) => Math.abs(n.time - t) <= tol);
    if (!near.length) { this.tooltip.hidden = true; return; }
    const first = near.reduce((a, b) => (Math.abs(b.time - t) < Math.abs(a.time - t) ? b : a));
    const same = near.filter((n) => Math.abs(n.time - first.time) < 1e-4);
    const names = same.map((n) => (n.lane === 'kick' || n.lane === 'red' ? LANE_LABEL[n.lane] : `${LANE_LABEL[n.lane]} ${n.cymbal ? 'cymbal' : 'tom'}`));
    this.tooltip.innerHTML = `<b>${formatTime(first.time, true)}</b> · bar ${first.bar}.${first.beatLabel}<br>${names.join(' + ')}`;
    this.tooltip.hidden = false;
    const box = this.root.getBoundingClientRect();
    const tw = this.tooltip.offsetWidth;
    this.tooltip.style.left = `${Math.max(0, px + 14 + tw > box.width ? px - 14 - tw : px + 14)}px`;
    this.tooltip.style.top = `${Math.max(0, py - 30)}px`;
  }
}
