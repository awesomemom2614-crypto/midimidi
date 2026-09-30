// Standard MIDI File writer for a tempo map: a conductor track with the time
// signature and tempo events, plus an optional click track on every beat.

export const PPQ = 960;

export function tempoMapToMidi(map, { name = 'Tempo map', click = false, ppq = PPQ } = {}) {
  const conductor = [];
  conductor.push({ tick: 0, data: metaEvent(0x03, ascii(name)) });
  conductor.push(timeSigEvent(0, map.beatsPerBar, 4));
  for (const e of map.events) conductor.push(tempoEvent(e.beat * ppq, e.microsPerBeat));

  const tracks = [conductor];
  if (click) {
    const clickTrack = [{ tick: 0, data: metaEvent(0x03, ascii('Click')) }];
    const lastBeat = map.gridTimes.length - 1;
    const len = Math.round(ppq / 8);
    for (let beat = 0; beat <= lastBeat; beat++) {
      const accent = beat % map.beatsPerBar === 0;
      const note = accent ? 76 : 77; // GM hi / low wood block, channel 10
      clickTrack.push({ tick: beat * ppq, data: [0x99, note, accent ? 110 : 80] });
      clickTrack.push({ tick: beat * ppq + len, data: [0x89, note, 0] });
    }
    tracks.push(clickTrack);
  }

  return writeSmf(tracks, ppq);
}

// Format 1 file from a list of tracks (each a list of { tick, data }).
export function writeSmf(tracks, ppq) {
  const chunks = [chunk('MThd', [0, 1, 0, tracks.length, (ppq >> 8) & 0xff, ppq & 0xff])];
  for (const events of tracks) chunks.push(chunk('MTrk', encodeTrack(events)));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export function tempoEvent(tick, us) {
  return { tick, data: metaEvent(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]) };
}

export function timeSigEvent(tick, num, den) {
  return { tick, data: metaEvent(0x58, [num, Math.round(Math.log2(den)), 24, 8]) };
}

// events: [{ tick, data, order? }]. At equal ticks, lower `order` goes first
// (note-offs use -1 so they precede note-ons), then insertion order.
export function encodeTrack(events) {
  const sorted = events.map((e, i) => ({ ...e, i })).sort((a, b) => a.tick - b.tick || (a.order ?? 0) - (b.order ?? 0) || a.i - b.i);
  const bytes = [];
  let last = 0;
  for (const e of sorted) {
    bytes.push(...vlq(e.tick - last), ...e.data);
    last = e.tick;
  }
  bytes.push(0, 0xff, 0x2f, 0x00);
  return bytes;
}

export function metaEvent(type, payload) {
  return [0xff, type, ...vlq(payload.length), ...payload];
}

export function chunk(id, payload) {
  const out = new Uint8Array(8 + payload.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  const n = payload.length;
  out[4] = (n >>> 24) & 0xff; out[5] = (n >>> 16) & 0xff; out[6] = (n >>> 8) & 0xff; out[7] = n & 0xff;
  out.set(payload, 8);
  return out;
}

function vlq(value) {
  const out = [value & 0x7f];
  value >>>= 7;
  while (value > 0) {
    out.unshift((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  return out;
}

export function ascii(s) {
  return Array.from(s, (c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 63));
}
