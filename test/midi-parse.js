// Minimal Standard MIDI File reader for checking the writer's output.

export function parseMidi(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (id(0) !== 'MThd') throw new Error('missing MThd');
  const format = v.getUint16(8);
  const ntrks = v.getUint16(10);
  const ppq = v.getUint16(12);
  let off = 8 + v.getUint32(4);
  const tracks = [];
  for (let t = 0; t < ntrks; t++) {
    if (id(off) !== 'MTrk') throw new Error(`missing MTrk at ${off}`);
    const len = v.getUint32(off + 4);
    const end = off + 8 + len;
    let p = off + 8;
    let tick = 0;
    let status = 0;
    const events = [];
    const readVlq = () => {
      let value = 0;
      for (;;) {
        const b = bytes[p++];
        value = (value << 7) | (b & 0x7f);
        if (!(b & 0x80)) return value;
      }
    };
    while (p < end) {
      tick += readVlq();
      if (bytes[p] & 0x80) status = bytes[p++];
      if (status === 0xff) {
        const type = bytes[p++];
        const n = readVlq();
        events.push({ tick, meta: type, data: Array.from(bytes.subarray(p, p + n)) });
        p += n;
      } else {
        const size = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
        events.push({ tick, status, data: Array.from(bytes.subarray(p, p + size)) });
        p += size;
      }
    }
    if (p !== end) throw new Error('track length mismatch');
    tracks.push(events);
    off = end;
  }
  return { format, ppq, tracks };
}

// Seconds at each whole beat 0..lastBeat implied by the tempo events.
export function beatTimesFromMidi(midi, lastBeat) {
  const tempos = midi.tracks[0]
    .filter((e) => e.meta === 0x51)
    .map((e) => ({ beat: e.tick / midi.ppq, us: (e.data[0] << 16) | (e.data[1] << 8) | e.data[2] }));
  const out = [];
  let us = 0;
  let k = 0;
  for (let beat = 0; beat <= lastBeat; beat++) {
    while (k + 1 < tempos.length && tempos[k + 1].beat <= beat) k++;
    out.push(us / 1e6);
    us += tempos[k].us;
  }
  return out;
}
