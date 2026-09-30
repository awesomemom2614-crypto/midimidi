// Tempo-over-time chart on a canvas: the beat-to-beat tempo the tracker
// measured (dots) and the tempo map that goes into the MIDI file (steps).

export class TempoChart {
  constructor(root, tooltip) {
    this.root = root;
    this.tooltip = tooltip;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.root.append(this.canvas);
    this.data = null;
    this.playhead = null;
    this.hoverX = null;
    this.onSeek = null;

    new ResizeObserver(() => this.draw()).observe(this.root);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
    new MutationObserver(() => this.draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    this.canvas.addEventListener('pointermove', (e) => { this.hoverX = e.offsetX; this.draw(); this.showTooltip(e.offsetX, e.offsetY); });
    this.canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.tooltip.hidden = true; this.draw(); });
    this.canvas.addEventListener('click', (e) => {
      if (!this.data || !this.onSeek) return;
      this.onSeek(this.xToTime(e.offsetX));
    });
  }

  setData(data) {
    this.data = data;
    const bpms = data.perBeat.map((p) => p.bpm).sort((a, b) => a - b);
    const mapBpms = data.events.filter((e) => !e.leadIn).map((e) => e.bpm);
    const q = (p) => bpms[Math.min(bpms.length - 1, Math.floor(p * bpms.length))];
    let lo = Math.min(...mapBpms, bpms.length ? q(0.02) : Infinity);
    let hi = Math.max(...mapBpms, bpms.length ? q(0.98) : -Infinity);
    if (!Number.isFinite(lo)) { lo = 60; hi = 180; }
    const pad = Math.max(4, (hi - lo) * 0.12);
    this.yMin = Math.max(0, lo - pad);
    this.yMax = hi + pad;
    this.canvas.setAttribute('aria-label', describe(data));
    this.draw();
  }

  setPlayhead(t) {
    this.playhead = t;
    this.draw();
  }

  layout() {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    return { w, h, left: 44, right: w - 12, top: 14, bottom: h - 26 };
  }

  xToTime(x) {
    const { left, right } = this.layout();
    return Math.max(0, Math.min(1, (x - left) / (right - left))) * this.data.duration;
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
    if (!this.data) return;

    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim();
    const { duration, perBeat, events, gridTimes } = this.data;
    const x = (t) => left + (t / duration) * (right - left);
    const y = (b) => bottom - ((b - this.yMin) / (this.yMax - this.yMin)) * (bottom - top);

    // Grid and axes
    ctx.font = `11px ${color('--font-mono')}`;
    ctx.lineWidth = 1;
    ctx.fillStyle = color('--muted');
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const b of niceTicks(this.yMin, this.yMax, 6)) {
      ctx.strokeStyle = color('--grid');
      ctx.beginPath(); ctx.moveTo(left, Math.round(y(b)) + 0.5); ctx.lineTo(right, Math.round(y(b)) + 0.5); ctx.stroke();
      ctx.fillText(String(b), left - 8, y(b));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of niceTicks(0, duration, Math.max(2, Math.floor((right - left) / 90)))) {
      if (t > duration) continue;
      ctx.fillText(formatTime(t, false), x(t), bottom + 8);
    }
    ctx.strokeStyle = color('--axis');
    ctx.beginPath(); ctx.moveTo(left, bottom + 0.5); ctx.lineTo(right, bottom + 0.5); ctx.stroke();

    ctx.save();
    ctx.beginPath(); ctx.rect(left, top - 4, right - left, bottom - top + 8); ctx.clip();

    // Detected beat-to-beat tempo
    ctx.fillStyle = color('--series-beats');
    ctx.globalAlpha = 0.55;
    for (const p of perBeat) {
      ctx.beginPath(); ctx.arc(x(p.time), y(p.bpm), 2.25, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Tempo map steps
    const end = gridTimes[gridTimes.length - 1] ?? duration;
    ctx.strokeStyle = color('--series-map');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (let k = 0; k < events.length; k++) {
      const e = events[k];
      const t1 = events[k + 1]?.time ?? end;
      ctx.setLineDash(e.leadIn ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x(e.time), y(e.bpm));
      ctx.lineTo(x(t1), y(e.bpm));
      if (events[k + 1]) ctx.lineTo(x(t1), y(events[k + 1].bpm));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    // Change markers along the top edge
    ctx.fillStyle = color('--series-map');
    for (const e of events) if (!e.leadIn) ctx.fillRect(Math.round(x(e.time)) - 1, top - 10, 2, 6);

    if (this.playhead != null) {
      ctx.strokeStyle = color('--fg');
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x(this.playhead), top - 4); ctx.lineTo(x(this.playhead), bottom); ctx.stroke();
    }
    if (this.hoverX != null && this.hoverX >= left && this.hoverX <= right) {
      ctx.strokeStyle = color('--axis');
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(this.hoverX + 0.5, top); ctx.lineTo(this.hoverX + 0.5, bottom); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  showTooltip(px, py) {
    const { left, right } = this.layout();
    if (!this.data || px < left || px > right) { this.tooltip.hidden = true; return; }
    const t = this.xToTime(px);
    const { events, perBeat, gridTimes, beatsPerBar } = this.data;
    let ev = events[0];
    for (const e of events) if (e.time <= t) ev = e;
    let nearest = null;
    for (const p of perBeat) if (!nearest || Math.abs(p.time - t) < Math.abs(nearest.time - t)) nearest = p;
    let g = 0;
    while (g + 1 < gridTimes.length && gridTimes[g + 1] <= t) g++;
    const rows = [`<b>${formatTime(t, true)}</b> · bar ${Math.floor(g / beatsPerBar) + 1}.${(g % beatsPerBar) + 1}`];
    if (ev) rows.push(`<span class="k map"></span>Map ${ev.bpm.toFixed(2)} BPM${ev.leadIn ? ' (lead-in)' : ''}`);
    if (nearest) rows.push(`<span class="k beat"></span>Beat ${nearest.bpm.toFixed(1)} BPM`);
    this.tooltip.innerHTML = rows.join('<br>');
    this.tooltip.hidden = false;
    const box = this.root.getBoundingClientRect();
    const tw = this.tooltip.offsetWidth;
    const left2 = px + 14 + tw > box.width ? px - 14 - tw : px + 14;
    this.tooltip.style.left = `${Math.max(0, left2)}px`;
    this.tooltip.style.top = `${Math.max(0, py - 20)}px`;
  }
}

function niceTicks(lo, hi, count) {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function formatTime(t, precise) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return precise ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

function describe({ events, duration }) {
  const changes = events.filter((e) => !e.leadIn);
  if (!changes.length) return 'No tempo detected';
  const bpms = changes.map((e) => e.bpm);
  return `Tempo over ${formatTime(duration, false)}: ${changes.length} tempo events from ${Math.min(...bpms).toFixed(1)} to ${Math.max(...bpms).toFixed(1)} BPM`;
}
