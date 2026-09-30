// Pro drums lanes (Rock Band / Clone Hero 4-lane pro) and the default mapping
// from General MIDI drum notes.

export const LANES = ['kick', 'red', 'yellow', 'blue', 'green'];

// Targets a GM note can map to.
export const TARGETS = [
  { id: 'kick', label: 'Kick', lane: 'kick', cymbal: false },
  { id: 'red', label: 'Red (snare)', lane: 'red', cymbal: false },
  { id: 'yellow-cymbal', label: 'Yellow cymbal', lane: 'yellow', cymbal: true },
  { id: 'blue-cymbal', label: 'Blue cymbal', lane: 'blue', cymbal: true },
  { id: 'green-cymbal', label: 'Green cymbal', lane: 'green', cymbal: true },
  { id: 'yellow-tom', label: 'Yellow tom', lane: 'yellow', cymbal: false },
  { id: 'blue-tom', label: 'Blue tom', lane: 'blue', cymbal: false },
  { id: 'green-tom', label: 'Green tom', lane: 'green', cymbal: false },
  { id: 'ignore', label: 'Ignore', lane: null, cymbal: false },
];
export const TARGET_BY_ID = Object.fromEntries(TARGETS.map((t) => [t.id, t]));

export const DEFAULT_GM_MAP = {
  35: 'kick', 36: 'kick',
  37: 'red', 38: 'red', 39: 'red', 40: 'red',
  42: 'yellow-cymbal', 44: 'yellow-cymbal', 46: 'yellow-cymbal',
  51: 'blue-cymbal', 53: 'blue-cymbal', 59: 'blue-cymbal',
  49: 'green-cymbal', 52: 'green-cymbal', 55: 'green-cymbal', 57: 'green-cymbal',
  48: 'yellow-tom', 50: 'yellow-tom',
  45: 'blue-tom', 47: 'blue-tom',
  41: 'green-tom', 43: 'green-tom',
};

export const GM_NAMES = {
  35: 'Acoustic bass drum', 36: 'Bass drum', 37: 'Side stick', 38: 'Snare', 39: 'Hand clap', 40: 'Electric snare',
  41: 'Low floor tom', 42: 'Closed hi-hat', 43: 'High floor tom', 44: 'Pedal hi-hat', 45: 'Low tom', 46: 'Open hi-hat',
  47: 'Low-mid tom', 48: 'Hi-mid tom', 49: 'Crash 1', 50: 'High tom', 51: 'Ride', 52: 'China', 53: 'Ride bell',
  54: 'Tambourine', 55: 'Splash', 56: 'Cowbell', 57: 'Crash 2', 59: 'Ride 2',
};

// Clone Hero .mid note numbers (Expert) and tom markers.
export const EXPERT_NOTE = { kick: 96, red: 97, yellow: 98, blue: 99, green: 100 };
export const TOM_MARKER = { yellow: 110, blue: 111, green: 112 };

// Collapses a list of { beat, lane, cymbal } notes into something playable:
// one note per lane per instant, and never a cymbal and a tom sharing a lane
// at the same time (the tom moves to the next free tom lane, or is dropped).
export function resolveConflicts(notes, ppq = 480) {
  const groups = new Map();
  for (const n of notes) {
    if (!n.lane) continue;
    const key = Math.round(n.beat * ppq);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const out = [];
  let moved = 0;
  let dropped = 0;
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    const taken = new Map(); // lane -> note
    const group = groups.get(key);
    // Cymbals and kick/red first so toms are the ones that move.
    group.sort((a, b) => Number(isTom(a)) - Number(isTom(b)));
    for (const n of group) {
      const beat = key / ppq;
      if (!taken.has(n.lane)) { taken.set(n.lane, { ...n, beat }); continue; }
      const existing = taken.get(n.lane);
      if (existing.cymbal === n.cymbal) { dropped++; continue; }
      if (isTom(n)) {
        const free = ['yellow', 'blue', 'green'].slice(['yellow', 'blue', 'green'].indexOf(n.lane) + 1).find((l) => !taken.has(l));
        if (free) { taken.set(free, { ...n, lane: free, beat }); moved++; } else { dropped++; }
      } else {
        dropped++;
      }
    }
    for (const lane of LANES) if (taken.has(lane)) out.push(taken.get(lane));
  }
  return { notes: out, moved, dropped };
}

const isTom = (n) => ['yellow', 'blue', 'green'].includes(n.lane) && !n.cymbal;
