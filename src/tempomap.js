// Turns detected beat times into a tempo map: a list of tempo events on an
// integer beat grid, chosen so the grid never strays more than `toleranceMs`
// from a detected beat. Steady passages collapse to one event, jumps become a
// single change, and gradual drift becomes as many steps as the tolerance needs.

export function buildTempoMap(beats, { toleranceMs = 20, beatsPerBar = 4 } = {}) {
  const n = beats.length;
  const perBeat = [];
  for (let i = 0; i + 1 < n; i++) perBeat.push({ time: beats[i], bpm: 60 / (beats[i + 1] - beats[i]) });
  if (n < 2) return { events: [], gridTimes: [], perBeat, anchor: 0, leadInBeats: 0, beatsPerBar };

  // The first beat on the grid. A beat sitting very close to the start of the
  // file is skipped so the lead-in doesn't need an absurdly fast tempo.
  let anchor = 0;
  if (n >= 3 && beats[0] > 0.001 && beats[0] < 0.5 * (beats[1] - beats[0])) anchor = 1;

  const cuts = segmentByTolerance(beats, anchor, n - 1, toleranceMs / 1000);

  const events = [];
  let cumUs = 0;
  let leadInBeats = 0;
  const startUs = Math.round(beats[anchor] * 1e6);
  if (startUs > 1000) {
    const firstPeriod = (beats[cuts[1]] - beats[cuts[0]]) / (cuts[1] - cuts[0]);
    leadInBeats = Math.max(1, Math.round(beats[anchor] / firstPeriod));
    const us = Math.round(startUs / leadInBeats);
    events.push({ beat: 0, time: 0, microsPerBeat: us, leadIn: true });
    cumUs = us * leadInBeats;
  }

  // Integer microseconds per beat, with the rounding error carried forward so
  // the grid stays locked to the detected beat at every change.
  for (let s = 0; s + 1 < cuts.length; s++) {
    const i = cuts[s];
    const j = cuts[s + 1];
    const count = j - i;
    const us = Math.max(1, Math.min(0xffffff, Math.round((Math.round(beats[j] * 1e6) - cumUs) / count)));
    events.push({ beat: leadInBeats + (i - anchor), time: cumUs / 1e6, microsPerBeat: us, leadIn: false });
    cumUs += us * count;
  }

  // Drop events that don't actually change the tempo. A lead-in that runs
  // straight into the same tempo is just the start of the first section.
  const merged = [];
  for (const e of events) {
    const prev = merged[merged.length - 1];
    if (prev && prev.microsPerBeat === e.microsPerBeat) {
      prev.leadIn = prev.leadIn && e.leadIn;
      continue;
    }
    merged.push(e);
  }
  for (const e of merged) {
    e.bpm = 60e6 / e.microsPerBeat;
    e.bar = Math.floor(e.beat / beatsPerBar) + 1;
    e.beatInBar = (e.beat % beatsPerBar) + 1;
  }

  return {
    events: merged,
    gridTimes: gridTimes(merged, leadInBeats + (n - 1 - anchor)),
    perBeat,
    anchor,
    leadInBeats,
    beatsPerBar,
  };
}

// Greedy: extend each constant-tempo segment for as long as every beat inside
// stays within `tol` seconds of the evenly spaced grid between its endpoints.
function segmentByTolerance(t, from, to, tol) {
  const cuts = [from];
  let i = from;
  while (i < to) {
    let j = i + 1;
    while (j + 1 <= to && fits(t, i, j + 1, tol)) j++;
    cuts.push(j);
    i = j;
  }
  return cuts;
}

function fits(t, i, j, tol) {
  const p = (t[j] - t[i]) / (j - i);
  for (let k = i + 1; k < j; k++) {
    if (Math.abs(t[i] + (k - i) * p - t[k]) > tol) return false;
  }
  return true;
}

// Time of every grid beat from 0 through `lastBeat`, exactly as a MIDI player
// would place them from the integer tempos.
export function gridTimes(events, lastBeat) {
  const out = [];
  if (events.length === 0) return out;
  let us = 0;
  let k = 0;
  for (let beat = 0; beat <= lastBeat; beat++) {
    while (k + 1 < events.length && events[k + 1].beat <= beat) k++;
    out.push(us / 1e6);
    us += events[k].microsPerBeat;
  }
  return out;
}
