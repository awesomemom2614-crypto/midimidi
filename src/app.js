import { createEngine } from './engine.js';
import { decodeFile, bufferFromSamples, Player } from './audio.js';
import { buildTempoMap } from './tempomap.js';
import { tempoMapToMidi } from './midi.js';
import { chartToMidi } from './chartmidi.js';
import { songIni } from './songini.js';
import { zipSingle, zipFiles } from './zip.js';
import { TempoChart, formatTime } from './chart.js';
import { LanesView } from './lanes-view.js';
import { tempoBeats, drumPart, renderHits, encodeWav } from './synth.js';
import { ANALYSIS_SR } from './dsp/onset.js';
import { TARGETS, DEFAULT_GM_MAP, GM_NAMES, resolveConflicts } from './drums/lanes.js';
import { readDrumPart, autoAlign, placePart, chartTimeSigs } from './drums/songsterr.js';
import { pickHits } from './drums/transcribe.js';
import { timeToBeat, beatToTime, snapBeat } from './drums/quantize.js';

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), name: $('source-name'), example: $('example-tag'), status: $('status'),
  minBpm: $('min-bpm'), maxBpm: $('max-bpm'), halve: $('halve'), double: $('double'), scale: $('scale-label'),
  tolerance: $('tolerance'), toleranceLabel: $('tolerance-label'), bpb: $('bpb'), bpbHint: $('bpb-hint'), click: $('click-track'),
  download: $('download'), downloadHint: $('download-hint'), downloadChart: $('download-chart'), chartHint: $('chart-hint'),
  play: $('play'), metronome: $('metronome'), playDrums: $('play-drums'), drumsToggle: $('drums-toggle'), time: $('time'),
  rows: $('rows'), sLength: $('s-length'), sBeats: $('s-beats'), sEvents: $('s-events'), sRange: $('s-range'),
  songsterrPanel: $('songsterr-panel'), detectPanel: $('detect-panel'), lanes: $('lanes'), drumStats: $('drum-stats'),
  partDrop: $('part-drop'), partFile: $('part-file'), partInfo: $('part-info'), tempoHint: $('tempo-hint'),
  alignField: $('align-field'), offsetValue: $('offset-value'), alignHint: $('align-hint'), alignAlternatives: $('align-alternatives'),
  mappingDetails: $('mapping-details'), mappingCount: $('mapping-count'), mappingRows: $('mapping-rows'),
  stemDrop: $('stem-drop'), stemFile: $('stem-file'), stemInfo: $('stem-info'),
  sensitivity: $('sensitivity'), sensitivityLabel: $('sensitivity-label'), snap: $('snap'), detectRun: $('detect-run'),
};

const state = {
  name: '', duration: 0, beats: [], map: null, onset: null, busy: false,
  audio: null, // { bytes, ext } of the loaded file, or { samples } for the example
  tracking: { minBpm: 60, maxBpm: 200, tempoScale: 1 },
  drums: {
    mode: 'none',
    part: null, offset: 0, manual: false, align: null, mapping: loadMapping(),
    source: 'main', stem: null, stemName: '', acts: null, actsFor: null,
    notes: [], timeSigs: [], stats: '',
  },
};

const chart = new TempoChart($('chart'), $('tooltip'));
const lanes = new LanesView(els.lanes, $('lanes-tooltip'), chart);
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
  for (const el of [els.halve, els.double, els.minBpm, els.maxBpm, els.detectRun]) el.disabled = busy;
  els.download.disabled = busy || !state.map?.events.length;
  els.downloadChart.disabled = busy || !state.drums.notes.length;
  els.play.disabled = busy || !player.buffer;
}

async function analyze(samples, buffer, name, isExample, fileName = name) {
  player.setBuffer(buffer);
  state.name = fileName;
  state.duration = buffer.duration;
  state.drums.acts = null;
  state.drums.actsFor = null;
  state.drums.manual = false;
  els.name.textContent = name;
  els.example.hidden = !isExample;
  setBusy(true);
  setStatus('Finding beats…');
  const started = performance.now();
  try {
    const engine = await enginePromise;
    const result = await engine.analyze(samples, ANALYSIS_SR, state.tracking);
    state.beats = Array.from(result.beats);
    state.onset = result.onset;
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
    state.onset = result.onset;
    state.drums.manual = false;
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
  updateDrums();
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
  const tabBars = state.drums.mode === 'songsterr' && state.drums.part && state.drums.timeSigs.length;
  $('rows-note').textContent = tabBars
    ? 'Click a row to jump there. Bars follow the Songsterr tab.'
    : "Click a row to jump there. Downbeats aren't detected: bar 1 starts at 0:00, so move the audio in your DAW if bar lines should fall elsewhere.";
  let prev = null;
  for (const e of map.events) {
    const pos = tabBars ? barBeat(e.beat, state.drums.timeSigs) : { bar: e.bar, beatLabel: e.beatInBar };
    const tr = document.createElement('tr');
    if (e.leadIn) tr.className = 'lead';
    const delta = prev == null || e.leadIn ? '' : e.bpm - prev;
    const cells = [
      e.leadIn ? `${pos.bar}.${pos.beatLabel} lead-in` : `${pos.bar}.${pos.beatLabel}`,
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

// --- drums ---

function loadMapping() {
  try {
    const saved = JSON.parse(localStorage.getItem('midimidi.gm-map') ?? 'null');
    if (saved && typeof saved === 'object') return { ...DEFAULT_GM_MAP, ...saved };
  } catch { /* storage unavailable */ }
  return { ...DEFAULT_GM_MAP };
}

function saveMapping() {
  try { localStorage.setItem('midimidi.gm-map', JSON.stringify(state.drums.mapping)); } catch { /* storage unavailable */ }
}

// Recomputes the chart notes for the current mode and tempo map.
function updateDrums() {
  const d = state.drums;
  const map = state.map;
  const lastBeat = map ? map.gridTimes.length - 1 : -1;
  d.notes = [];
  d.timeSigs = [{ beat: 0, num: Number(els.bpb.value), den: 4 }];
  d.stats = '';
  if (map && lastBeat > 0 && d.mode === 'songsterr' && d.part) {
    if (!d.manual && state.onset) {
      d.align = autoAlign(d.part, map.gridTimes, state.onset);
      d.offset = d.align.offset;
    }
    const placed = placePart(d.part, d.offset, d.mapping, lastBeat);
    d.notes = placed.notes;
    d.timeSigs = chartTimeSigs(d.part, d.offset, lastBeat);
    const dropped = [];
    if (placed.early) dropped.push(`${placed.early} before the song starts`);
    if (placed.late) dropped.push(`${placed.late} after it ends`);
    if (placed.ignored) dropped.push(`${placed.ignored} on ignored sounds`);
    if (placed.moved) dropped.push(`${placed.moved} toms moved to a free lane`);
    d.stats = dropped.length ? `Left out or changed: ${dropped.join(', ')}.` : '';
    renderAlign();
  } else if (map && lastBeat > 0 && d.mode === 'detect' && d.acts && d.actsFor === d.source) {
    const hits = pickHits(d.acts.acts, d.acts.fps, { sensitivity: Number(els.sensitivity.value) / 100 });
    const division = Number(els.snap.value);
    const lane = { kick: ['kick', false], snare: ['red', false], hat: ['yellow', true], crash: ['green', true] };
    const notes = [];
    for (const h of hits) {
      const beat = snapBeat(timeToBeat(map.gridTimes, h.time), division);
      if (beat < 0 || beat > lastBeat) continue;
      const [l, cymbal] = lane[h.drum];
      notes.push({ beat, lane: l, cymbal });
    }
    d.notes = resolveConflicts(notes).notes;
  }
  renderDrums();
}

function renderAlign() {
  const d = state.drums;
  els.alignField.hidden = !d.part;
  if (!d.part) return;
  els.offsetValue.textContent = `${d.offset > 0 ? '+' : d.offset < 0 ? '−' : ''}${Math.abs(d.offset)} beat${Math.abs(d.offset) === 1 ? '' : 's'}`;
  const lead = d.offset < 0 ? ' The tab starts before the recording (a count-in or intro that isn\'t in the audio).' : '';
  els.alignHint.textContent = (d.manual
    ? 'Set by hand. Press Auto to match the recording again.'
    : 'Matched to the recording. Play with chart drums on to check it by ear.') + lead;
  const alts = d.align?.alternatives ?? [];
  const chips = alts.map((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${a.offset > 0 ? '+' : a.offset < 0 ? '−' : ''}${Math.abs(a.offset)}`;
    b.addEventListener('click', () => setOffset(a.offset, true));
    return b;
  });
  if (chips.length) {
    const label = document.createElement('span');
    label.className = 'hint';
    label.textContent = 'Close matches:';
    chips.unshift(label);
  }
  els.alignAlternatives.replaceChildren(...chips);
}

function setOffset(offset, manual) {
  state.drums.offset = offset;
  state.drums.manual = manual;
  updateDrums();
}

function barBeat(beat, sigs) {
  let bar = 1;
  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    const end = sigs[i + 1]?.beat ?? Infinity;
    const len = (s.num * 4) / s.den;
    if (beat < end - 1e-9) {
      const into = beat - s.beat;
      const n = Math.floor(into / len + 1e-9);
      const within = (into - n * len) / (4 / s.den) + 1;
      return { bar: bar + n, beatLabel: Number(within.toFixed(2)) };
    }
    bar += Math.round((end - s.beat) / len);
  }
  return { bar, beatLabel: 1 };
}

function renderDrums() {
  const d = state.drums;
  els.songsterrPanel.hidden = d.mode !== 'songsterr';
  els.detectPanel.hidden = d.mode !== 'detect';
  els.lanes.hidden = d.mode === 'none';
  els.drumsToggle.hidden = !d.notes.length;
  const usesTabBars = d.mode === 'songsterr' && d.part;
  els.bpb.disabled = Boolean(usesTabBars);
  els.bpbHint.hidden = !usesTabBars;

  if (state.map) renderRows(state.map);
  const grid = state.map?.gridTimes ?? [];
  const timed = d.notes.map((n) => ({ ...n, time: beatToTime(grid, n.beat), ...barBeat(n.beat, d.timeSigs) }));
  lanes.setNotes(timed, state.duration);
  player.setDrums(timed);

  const counts = { kick: 0, red: 0, yellow: 0, blue: 0, green: 0 };
  for (const n of d.notes) counts[n.lane]++;
  if (d.notes.length) {
    els.drumStats.textContent = `${d.notes.length} notes: kick ${counts.kick} · red ${counts.red} · yellow ${counts.yellow} · blue ${counts.blue} · green ${counts.green}. ${d.stats}`;
    els.chartHint.textContent = 'Unzip into your Clone Hero songs folder, or import notes.mid into Moonscraper. Expert pro drums only.';
  } else {
    els.drumStats.textContent = d.mode === 'songsterr' && !d.part ? '' : d.mode === 'detect' && !d.acts ? '' : d.mode === 'none' ? '' : 'No drum notes.';
    els.chartHint.textContent = 'Pick a drum source above to add drum notes. The folder holds notes.mid, song.ini and the audio.';
  }
  els.downloadChart.disabled = state.busy || !d.notes.length;
}

function renderMapping() {
  const part = state.drums.part;
  els.mappingDetails.hidden = !part;
  if (!part) return;
  const notes = Object.keys(part.counts).map(Number).sort((a, b) => a - b);
  els.mappingCount.textContent = String(notes.length);
  const rows = notes.map((gm) => {
    const tr = document.createElement('tr');
    const sel = document.createElement('select');
    sel.id = `map-${gm}`;
    sel.setAttribute('aria-label', `Lane for MIDI note ${gm}`);
    for (const t of TARGETS) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.label;
      sel.append(o);
    }
    sel.value = state.drums.mapping[gm] ?? 'ignore';
    sel.addEventListener('change', () => {
      state.drums.mapping[gm] = sel.value;
      saveMapping();
      updateDrums();
    });
    const cells = [String(gm), GM_NAMES[gm] ?? 'Other', String(part.counts[gm])];
    for (const text of cells) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
    const td = document.createElement('td');
    td.append(sel);
    tr.append(td);
    return tr;
  });
  els.mappingRows.replaceChildren(...rows);
}

function renderTempoHint() {
  const part = state.drums.part;
  const changes = state.map?.events.filter((e) => !e.leadIn) ?? [];
  els.tempoHint.hidden = true;
  if (!part || !changes.length) return;
  const bpms = changes.map((e) => e.bpm).sort((a, b) => a - b);
  const detected = bpms[bpms.length >> 1];
  const ratio = part.bpm / detected;
  const fix = ratio > 1.75 && ratio < 2.3 ? 2 : ratio > 0.43 && ratio < 0.57 ? 0.5 : null;
  if (!fix) return;
  els.tempoHint.hidden = false;
  els.tempoHint.textContent = `The tab is at ${part.bpm.toFixed(0)} BPM but the recording was detected at about ${detected.toFixed(0)}. `;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = fix === 2 ? 'Double the detected tempo' : 'Halve the detected tempo';
  b.addEventListener('click', () => setScale(state.tracking.tempoScale * fix));
  els.tempoHint.append(b);
}

async function openPart(file) {
  try {
    const part = readDrumPart(new Uint8Array(await file.arrayBuffer()));
    state.drums.part = part;
    state.drums.manual = false;
    els.partInfo.textContent = `${file.name}: ${part.notes.length} drum notes${part.name ? ` on “${part.name}”` : ''}, tab tempo ${part.bpm.toFixed(0)} BPM.`;
    renderMapping();
    updateDrums();
    renderTempoHint();
    setStatus(`Loaded ${file.name}.`);
  } catch (err) {
    setStatus(`Couldn't read ${file.name}: ${err.message}`, true);
  }
}

async function openStem(file) {
  if (state.busy) return;
  setBusy(true);
  setStatus(`Decoding ${file.name}…`);
  try {
    const { samples, buffer } = await decodeFile(file);
    state.drums.stem = samples;
    state.drums.stemName = file.name;
    if (state.drums.actsFor === 'stem') { state.drums.acts = null; state.drums.actsFor = null; }
    const diff = Math.abs(buffer.duration - state.duration);
    els.stemInfo.hidden = false;
    els.stemInfo.textContent = diff > 1
      ? `${file.name} is ${formatTime(buffer.duration, false)} long but the song is ${formatTime(state.duration, false)}. Use a stem split from this exact file.`
      : `Stem: ${file.name}`;
    setStatus('Stem loaded. Press Detect drums.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
}

async function detectDrums() {
  const d = state.drums;
  if (state.busy || !player.buffer) return;
  if (d.source === 'stem' && !d.stem) { setStatus('Load a drum stem first, or detect from this audio.', true); return; }
  setBusy(true);
  setStatus('Detecting drums… this can take a few seconds per minute of audio.');
  const started = performance.now();
  try {
    const engine = await enginePromise;
    d.acts = await engine.transcribe(d.source === 'stem' ? d.stem : null, ANALYSIS_SR);
    d.actsFor = d.source;
    updateDrums();
    setStatus(`Drums detected in ${((performance.now() - started) / 1000).toFixed(1)} s. Adjust sensitivity to find more or fewer hits.`);
  } catch (err) {
    setStatus(`Drum detection failed: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

// --- files out ---

function baseName() {
  return (state.name || 'audio').replace(/\.[^.]+$/, '');
}

async function saveFile(filename, bytes, mime) {
  const downloads = await downloadsPromise;
  if (downloads) {
    try {
      await downloads.save({ filename, data: bytes });
      setStatus(`Saved ${filename}.`);
    } catch (err) {
      setStatus(err?.code === 'declined' ? 'Download cancelled.' : `Couldn't save the file: ${err?.message ?? err}`, err?.code !== 'declined');
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Saved ${filename}.`);
}

async function downloadTempoMap() {
  if (!state.map?.events.length) return;
  const base = baseName();
  const filename = `${base}.tempo.mid`;
  const bytes = tempoMapToMidi(state.map, { name: base, click: els.click.checked });
  if (await downloadsPromise) await saveFile(`${base}.tempo.zip`, zipSingle(filename, bytes), 'application/zip');
  else await saveFile(filename, bytes, 'audio/midi');
}

const CH_AUDIO = ['ogg', 'mp3', 'wav', 'opus'];

async function downloadChart() {
  const d = state.drums;
  if (!state.map || !d.notes.length) return;
  const base = baseName();
  const folder = base.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'song';
  const files = [
    { name: `${folder}/notes.mid`, data: chartToMidi(state.map, d.notes, d.timeSigs, { name: base }) },
    { name: `${folder}/song.ini`, data: new TextEncoder().encode(songIni({ name: base, lengthMs: state.duration * 1000 })) },
  ];
  let note = '';
  const audio = state.audio;
  if (audio?.samples) {
    files.push({ name: `${folder}/song.wav`, data: encodeWav(audio.samples, ANALYSIS_SR) });
  } else if (audio?.bytes && CH_AUDIO.includes(audio.ext)) {
    files.push({ name: `${folder}/song.${audio.ext}`, data: audio.bytes });
  } else {
    note = ` Add the audio yourself as song.ogg, song.mp3 or song.opus (Clone Hero may not play .${audio?.ext ?? 'this format'}).`;
  }
  await saveFile(`${folder}.zip`, zipFiles(files), 'application/zip');
  if (note) setStatus(els.status.textContent + note);
}

// --- playback ---

function tick() {
  const t = player.position();
  els.time.textContent = formatTime(t, true);
  const head = player.playing || t > 0 ? t : null;
  chart.setPlayhead(head);
  if (!els.lanes.hidden) lanes.setPlayhead(head);
}

function loop() {
  tick();
  if (player.playing) requestAnimationFrame(loop);
}

// --- wiring ---

function wireDrop(zone, input, onFile) {
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('over'); });
  for (const type of ['dragleave', 'drop']) zone.addEventListener(type, () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
}
wireDrop(els.drop, els.file, openFile);
wireDrop(els.partDrop, els.partFile, openPart);
wireDrop(els.stemDrop, els.stemFile, openStem);

async function openFile(file) {
  if (state.busy) return;
  player.stop();
  els.play.textContent = 'Play';
  setBusy(true);
  setStatus(`Decoding ${file.name}…`);
  try {
    const { buffer, samples, bytes } = await decodeFile(file);
    state.audio = { bytes, ext: (file.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase() };
    state.drums.stem = null;
    els.stemInfo.hidden = true;
    await analyze(samples, buffer, file.name, false);
    renderTempoHint();
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

async function setScale(scale) {
  if (scale < 0.25 || scale > 4) return;
  state.tracking = { ...state.tracking, tempoScale: scale };
  els.scale.textContent = scale >= 1 ? `×${scale}` : `÷${1 / scale}`;
  await retrack();
  renderTempoHint();
}
els.halve.addEventListener('click', () => setScale(state.tracking.tempoScale / 2));
els.double.addEventListener('click', () => setScale(state.tracking.tempoScale * 2));

els.tolerance.addEventListener('input', () => {
  const v = Number(els.tolerance.value);
  els.toleranceLabel.textContent = v === 0 ? 'every beat' : `±${v} ms`;
  if (state.beats.length) rebuild();
});
els.bpb.addEventListener('change', () => { if (state.beats.length) rebuild(); });
els.download.addEventListener('click', downloadTempoMap);
els.downloadChart.addEventListener('click', downloadChart);
els.metronome.addEventListener('change', () => { player.clickOn = els.metronome.checked; });
els.playDrums.addEventListener('change', () => { player.drumsOn = els.playDrums.checked; });
player.drumsOn = els.playDrums.checked;

for (const radio of document.querySelectorAll('input[name="drum-mode"]')) {
  radio.addEventListener('change', () => {
    state.drums.mode = radio.value;
    updateDrums();
    renderTempoHint();
  });
}
for (const radio of document.querySelectorAll('input[name="detect-source"]')) {
  radio.addEventListener('change', () => {
    state.drums.source = radio.value;
    els.stemDrop.hidden = radio.value !== 'stem';
    updateDrums();
  });
}
const barLen = () => {
  const s = state.drums.part?.timeSigs[0];
  return s ? Math.round((s.num * 4) / s.den) : 4;
};
$('nudge-bar-back').addEventListener('click', () => setOffset(state.drums.offset - barLen(), true));
$('nudge-back').addEventListener('click', () => setOffset(state.drums.offset - 1, true));
$('nudge-fwd').addEventListener('click', () => setOffset(state.drums.offset + 1, true));
$('nudge-bar-fwd').addEventListener('click', () => setOffset(state.drums.offset + barLen(), true));
$('auto-align').addEventListener('click', () => { state.drums.manual = false; updateDrums(); });
els.sensitivity.addEventListener('input', () => { els.sensitivityLabel.textContent = els.sensitivity.value; updateDrums(); });
els.snap.addEventListener('change', updateDrums);
els.detectRun.addEventListener('click', detectDrums);

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
    els.download.textContent = 'Tempo map only (.zip)';
    els.downloadHint.textContent = 'The .zip holds the .mid file. Import it into your DAW at bar 1 with the audio starting at 0:00.';
  }
});

// Open on a worked example: a synthetic band groove that jumps from 96 to
// 128 BPM, then slows down to 108, with crashes and tom fills.
function exampleTempo(t) {
  if (t < 16) return 96;
  if (t < 30) return 128;
  if (t < 42) return 128 - (20 * (t - 30)) / 12;
  return 108;
}
const exampleDuration = 48;
const exampleBeats = tempoBeats(exampleTempo, exampleDuration, 0.6);
const exampleHits = drumPart(Math.floor((exampleBeats.length - 1) / 4)).map((h) => {
  const i = Math.floor(h.beat);
  return { ...h, time: exampleBeats[i] + (h.beat - i) * (exampleBeats[i + 1] - exampleBeats[i]) };
});
const exampleSamples = renderHits(exampleHits, exampleDuration, { sr: ANALYSIS_SR, music: true });
state.audio = { samples: exampleSamples };
analyze(exampleSamples, bufferFromSamples(exampleSamples, ANALYSIS_SR), 'Example groove: 96 → 128 BPM, then slowing to 108', true, 'example-groove.wav');
