// Clone Hero / Rock Band style notes.mid: a conductor track (tempo map and
// time signatures) plus a PART DRUMS track with Expert pro drums.
import { writeSmf, metaEvent, ascii, tempoEvent, timeSigEvent } from './midi.js';
import { EXPERT_NOTE, TOM_MARKER } from './drums/lanes.js';

export const CHART_PPQ = 480;

// map: from buildTempoMap. notes: [{ beat, lane, cymbal }] on grid beats.
// timeSigs: [{ beat, num, den }].
export function chartToMidi(map, notes, timeSigs, { name = 'Song', ppq = CHART_PPQ } = {}) {
  const conductor = [{ tick: 0, data: metaEvent(0x03, ascii(name)) }];
  for (const s of timeSigs) conductor.push(timeSigEvent(Math.round(s.beat * ppq), s.num, s.den));
  for (const e of map.events) conductor.push(tempoEvent(e.beat * ppq, e.microsPerBeat));

  const drums = [{ tick: 0, data: metaEvent(0x03, ascii('PART DRUMS')) }];
  // Short notes: sustained drum notes would make Clone Hero read the track as 5-lane.
  const len = Math.round(ppq / 16);
  const sorted = [...notes].sort((a, b) => a.beat - b.beat);
  const ticks = sorted.map((n) => Math.round(n.beat * ppq));
  const nextInLane = new Array(sorted.length).fill(Infinity);
  const seen = {};
  for (let i = sorted.length - 1; i >= 0; i--) {
    nextInLane[i] = seen[sorted[i].lane] ?? Infinity;
    seen[sorted[i].lane] = ticks[i];
  }
  sorted.forEach((n, i) => {
    const tick = ticks[i];
    const end = Math.max(tick + 1, Math.min(tick + len, nextInLane[i]));
    const key = EXPERT_NOTE[n.lane];
    drums.push({ tick, data: [0x90, key, 100] }, { tick: end, data: [0x80, key, 0], order: -1 });
    if (!n.cymbal && TOM_MARKER[n.lane]) {
      const marker = TOM_MARKER[n.lane];
      drums.push({ tick, data: [0x90, marker, 100] }, { tick: end, data: [0x80, marker, 0], order: -1 });
    }
  });
  return writeSmf([conductor, drums], ppq);
}
