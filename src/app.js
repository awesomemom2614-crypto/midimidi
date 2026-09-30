import { createEngine } from './engine.js';
import { decodeFile, bufferFromSamples, Player } from './audio.js';
import { buildTempoMap } from './tempomap.js';
import { tempoMapToMidi } from './midi.js';
import { zipSingle } from './zip.js';
import { TempoChart, formatTime } from './chart.js';
import { tempoBeats, renderDrums } from './synth.js';
import { ANALYSIS_SR } from './dsp/onset.js';

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), name: $('source-name'), example: $('example-tag'), status: $('status'),
  minBpm: $('min-bpm'), maxBpm: $('max-bpm'), halve: $('halve'), double: $('double'), scale: $('scale-label'),
  tolerance: $('tolerance'), toleranceLabel: $('tolerance-label'), bpb: $('bpb'), click: $('click-track'),
  download: $('download'), downloadHint: $('download-hint'), play: $('play'), metronome: $('metronome'), time: $('time'),
  rows: $('rows'), sLength: $('s-length'), sBeats: $('s-beats'), sEvents: $('s-events'), sRange: $('s-range'),
};

const state = {
  name: '', duration: 0, beats: [], map: null, busy: false,
  tracking: { minBpm: 60, maxBpm: 200, tempoScale: 1 },
};

const chart = new TempoChart($('chart'), $('tooltip'));
const player = new Player();
const enginePromise = createEngine({ allowWorker: new URLSearchParams(location.search).get('worker') !== '0' });
// Inside a claude.ai artifact, files are saved through the host.
const downloadsPromise = window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);

function setStatus(text, error = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', error);
}

function setBusy(busy) {
  state.busy = busy;
  document.body.dataset.state = busy ? 'busy' : state.map ? 'done' : 'idle';
  for (const el of [els.halve, els.double, els.minBpm, els.maxBpm]) el.disabled = busy;
  els.download.disabled = busy || !state.map?.events.length;
  els.play.disabled = busy || !player.buffer;
}

async function analyze(samples, buffer, name, isExample, fileName = name) {
  player.setBuffer(buffer);
  state.name = fileName;
  state.duration = buffer.duration;
  els.name.textContent = name;
  els.example.hidden = !isExample;
  setBusy(true);
  setStatus('Finding beats…');
  const started = performance.now();
  try {
    const engine = await enginePromise;
    const result = await engine.analyze(samples, ANALYSIS_SR, state.tracking);
    state.beats = Array.from(result.beats);
    rebuild();
    setStatus(`Analysed in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
  } catch (err) {
    state.beats = [];
    rebuild();
    setStatus(`Analysis failed: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function retrack() {
  if (!player.buffer || state.busy) return;
  setBusy(true);
  setStatus('Re-tracking beats…');
  try {
    const result = await (await enginePromise).retrack(state.tracking);
    state.beats = Array.from(result.beats);
    rebuild();
    setStatus('Updated.');
  } catch (err) {
    setStatus(`Analysis failed: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

function rebuild() {
  const beatsPerBar = Number(els.bpb.value);
  state.map = buildTempoMap(state.beats, { toleranceMs: Number(els.tolerance.value), beatsPerBar });
  const map = state.map;
  player.setClicks(map.gridTimes, beatsPerBar);
  chart.setData({ ...map, duration: state.duration });
  renderSummary(map);
  renderRows(map);
  els.download.disabled = state.busy || !map.events.length;
  if (state.beats.length < 2 && !state.busy) setStatus('No steady beat found. Try a wider tempo range, or a section with clear drums or rhythm.', true);
}

function renderSummary(map) {
  const changes = map.events.filter((e) => !e.leadIn);
  els.sLength.textContent = formatTime(state.duration, false);
  els.sBeats.textContent = String(state.beats.length);
  els.sEvents.textContent = String(changes.length);
  if (changes.length) {
    const bpms = changes.map((e) => e.bpm);
    const lo = Math.min(...bpms);
    const hi = Math.max(...bpms);
    els.sRange.textContent = hi - lo < 0.05 ? lo.toFixed(1) : `${lo.toFixed(0)}–${hi.toFixed(0)}`;
  } else {
    els.sRange.textContent = '—';
  }
}

function renderRows(map) {
  const frag = document.createDocumentFragment();
  let prev = null;
  for (const e of map.events) {
    const tr = document.createElement('tr');
    if (e.leadIn) tr.className = 'lead';
    const delta = prev == null || e.leadIn ? '' : e.bpm - prev;
    const cells = [
      e.leadIn ? `${e.bar}.${e.beatInBar} lead-in` : `${e.bar}.${e.beatInBar}`,
      formatTime(e.time, true),
      e.bpm.toFixed(2),
      delta === '' ? '' : `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta).toFixed(2)}`,
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i === 3 && delta !== '') td.className = `delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`;
      tr.append(td);
    });
    tr.addEventListener('click', () => { player.seek(e.time); tick(); });
    frag.append(tr);
    if (!e.leadIn) prev = e.bpm;
  }
  els.rows.replaceChildren(frag);
}

async function download() {
  if (!state.map?.events.length) return;
  const base = (state.name || 'audio').replace(/\.[^.]+$/, '');
  const filename = `${base}.tempo.mid`;
  const bytes = tempoMapToMidi(state.map, { name: base, click: els.click.checked });
  const downloads = await downloadsPromise;
  if (downloads) {
    try {
      await downloads.save({ filename: `${base}.tempo.zip`, data: zipSingle(filename, bytes) });
      setStatus(`Saved ${base}.tempo.zip (contains ${filename}).`);
    } catch (err) {
      setStatus(err?.code === 'declined' ? 'Download cancelled.' : `Couldn't save the file: ${err?.message ?? err}`, err?.code !== 'declined');
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Saved ${filename}.`);
}

function tick() {
  const t = player.position();
  els.time.textContent = formatTime(t, true);
  chart.setPlayhead(player.playing || t > 0 ? t : null);
}

function loop() {
  tick();
  if (player.playing) requestAnimationFrame(loop);
}

// --- wiring ---

els.file.addEventListener('change', () => { if (els.file.files[0]) openFile(els.file.files[0]); els.file.value = ''; });
for (const type of ['dragenter', 'dragover']) {
  els.drop.addEventListener(type, (e) => { e.preventDefault(); els.drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  els.drop.addEventListener(type, () => els.drop.classList.remove('over'));
}
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) openFile(file);
});

async function openFile(file) {
  if (state.busy) return;
  player.stop();
  els.play.textContent = 'Play';
  setBusy(true);
  setStatus(`Decoding ${file.name}…`);
  try {
    const { buffer, samples } = await decodeFile(file);
    await analyze(samples, buffer, file.name, false);
  } catch (err) {
    setBusy(false);
    setStatus(err.message, true);
  }
}

function readRange() {
  let lo = Math.round(Number(els.minBpm.value));
  let hi = Math.round(Number(els.maxBpm.value));
  if (!(lo >= 30)) lo = 30;
  if (!(hi <= 400)) hi = 400;
  if (hi < lo * 1.25) hi = Math.round(lo * 1.25);
  els.minBpm.value = lo;
  els.maxBpm.value = hi;
  if (lo === state.tracking.minBpm && hi === state.tracking.maxBpm) return;
  state.tracking = { ...state.tracking, minBpm: lo, maxBpm: hi };
  retrack();
}
els.minBpm.addEventListener('change', readRange);
els.maxBpm.addEventListener('change', readRange);

function setScale(scale) {
  if (scale < 0.25 || scale > 4) return;
  state.tracking = { ...state.tracking, tempoScale: scale };
  els.scale.textContent = scale >= 1 ? `×${scale}` : `÷${1 / scale}`;
  retrack();
}
els.halve.addEventListener('click', () => setScale(state.tracking.tempoScale / 2));
els.double.addEventListener('click', () => setScale(state.tracking.tempoScale * 2));

els.tolerance.addEventListener('input', () => {
  const v = Number(els.tolerance.value);
  els.toleranceLabel.textContent = v === 0 ? 'every beat' : `±${v} ms`;
  if (state.beats.length) rebuild();
});
els.bpb.addEventListener('change', () => { if (state.beats.length) rebuild(); });
els.download.addEventListener('click', download);
els.metronome.addEventListener('change', () => { player.clickOn = els.metronome.checked; });

els.play.addEventListener('click', async () => {
  if (player.playing) {
    player.pause();
    els.play.textContent = 'Play';
    tick();
  } else {
    await player.play();
    els.play.textContent = 'Pause';
    loop();
  }
});
player.onEnd = () => { els.play.textContent = 'Play'; tick(); };
chart.onSeek = (t) => { player.seek(t); tick(); if (player.playing) loop(); };

downloadsPromise.then((downloads) => {
  if (downloads) {
    els.download.textContent = 'Download tempo map (.zip)';
    els.downloadHint.textContent = 'The .zip holds the .mid file. Import it into your DAW at bar 1 with the audio starting at 0:00.';
  }
});

// Open on a worked example: a synthetic drum groove that jumps from 96 to
// 128 BPM, then slows down to 108.
function exampleTempo(t) {
  if (t < 16) return 96;
  if (t < 30) return 128;
  if (t < 42) return 128 - (20 * (t - 30)) / 12;
  return 108;
}
const exampleDuration = 48;
const exampleSamples = renderDrums(tempoBeats(exampleTempo, exampleDuration, 0.6), exampleDuration, { sr: ANALYSIS_SR });
analyze(exampleSamples, bufferFromSamples(exampleSamples, ANALYSIS_SR), 'Example groove: 96 → 128 BPM, then slowing to 108', true, 'example-groove.wav');
