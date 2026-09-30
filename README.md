# midimidi

Map every tempo change in an audio file and export it as a MIDI tempo map, or as a Clone Hero
song with Expert pro drums. Everything runs in the browser: no upload, no server, no dependencies.

Drop in a WAV, FLAC, OGG or MP3. midimidi finds the beats, turns them into a tempo map, and
gives you a `.mid` file. Import that file into your DAW and its grid follows the recording:
sudden tempo jumps, gradual speed-ups and slow-downs, and live drift.

## Run it

It's a static page made of plain ES modules, so any static file server works:

```sh
npm run serve        # http-server on http://localhost:8080
# or: python3 -m http.server 8080
```

Opening `index.html` straight from disk won't work, because browsers block module scripts on
`file://`.

## Using it

1. **Load audio.** An example groove is analysed on first load so you can see what the output
   looks like.
2. **Check the chart.** Dots are the tempo between each pair of detected beats. The blue step
   line is the tempo map that goes into the MIDI file. Press **Play** with **Click on map
   beats** on to hear the grid against the music.
3. **Adjust if needed.**
   - **÷2 / ×2:** use these when the map is at half or double the tempo you hear. Beat trackers
     can't always tell 70 from 140.
   - **Tempo range:** limits which tempos the detector will consider.
   - **Grid tolerance:** how far a detected beat may sit from the MIDI grid before a new tempo
     event is added.
     - Higher values give fewer, steadier tempo events.
     - Lower values follow the performance more closely.
     - 0 puts a tempo event on every beat.
4. **Download.** You get `<name>.tempo.mid`: a format 1 file at 960 PPQ with a conductor track
   holding the time signature and tempo events. It can also carry a click track (GM wood blocks
   on channel 10) if you tick the option. When the page runs as a claude.ai artifact, the host
   only allows certain file types, so the `.mid` comes inside a `.zip`.
5. **In your DAW:** put the audio at 0:00 and import the MIDI file's tempo track at bar 1.

## Pro drums for Clone Hero

Choose where the drum notes come from in the **Drums** panel.

**Songsterr (recommended when a tab exists).** Load the song, then drop the `.mid` exported from
songsterr.com.
- The drum track is the one on MIDI channel 10; the guitar and bass tracks are ignored.
- The tab is timed in beats at its own tempo, so midimidi places it by musical position. It finds
  which detected beat the tab's first beat falls on (the **offset**), then shifts every note onto
  the detected tempo map. That lines the notes up with the recording even where the band speeds up
  or slows down.
- Bar lines and time signatures come from the tab. A pickup bar fills any gap at the start.
- The offset is found automatically. A steady groove shifted by a whole bar can match almost as
  well, so check it:
  1. Press **Play** with **Play chart drums** on.
  2. If it's off, nudge by a beat or a bar, or click one of the listed close matches.
- If the tab's tempo is about twice or half the detected tempo, a button appears to fix the
  detected tempo.
- **Drum mapping** lists every drum sound in the tab and lets you choose its lane. Changes are
  remembered in your browser. The defaults:

  | Tab sound (GM note) | Chart lane |
  |---|---|
  | Kick (35, 36) | Kick |
  | Snare, side stick, clap (37–40) | Red |
  | Hi-hat (42, 44, 46) | Yellow cymbal |
  | Ride (51, 53, 59) | Blue cymbal |
  | Crash, china, splash (49, 52, 55, 57) | Green cymbal |
  | High toms (48, 50) | Yellow tom |
  | Mid toms (45, 47) | Blue tom |
  | Floor toms (41, 43) | Green tom |

  A cymbal and a tom can't share a lane at the same moment. When that happens, the tom moves to the
  next free tom lane.

**Detect (a draft to edit).** midimidi transcribes the drums itself.
- It can work from the song itself, or from a drum stem you split first (for example with Demucs).
  A stem gives cleaner results.
- It finds kick, snare, hi-hat and crash. It doesn't find toms or ride.
- Hits are snapped to the grid you choose (1/16 by default).
- Raise **Sensitivity** to catch quieter hits, or lower it to drop false ones.
- How it works: harmonic/percussive separation, then semi-adaptive NMF with kick, snare and cymbal
  templates.

**Download Clone Hero song (.zip)** gives you a folder with:
- `notes.mid`: 480 PPQ.
  - Track 1 holds the tempo map and time signatures.
  - Track 2 is `PART DRUMS`, Expert only: notes 96–100, with tom markers 110–112. Pads are cymbals
    unless a tom marker covers them.
  - Drum notes are 1/16 of a beat long so Clone Hero doesn't treat them as sustains.
- `song.ini`: sets `pro_drums = True`.
- The audio as `song.ogg`, `.mp3`, `.wav` or `.opus`. FLAC isn't included; convert it yourself.

Unzip the folder into your Clone Hero songs folder, or open `notes.mid` in Moonscraper (File ›
Import) to edit it and save a `.chart`.

## How it works

| Stage | File | What it does |
|---|---|---|
| Decode | `src/audio.js` | Web Audio `decodeAudioData`, then a mono mixdown resampled to 22,050 Hz |
| Onset strength | `src/dsp/onset.js`, `src/dsp/fft.js` | Spectral flux over 40 mel bands with log compression, at 11.6 ms per frame |
| Local tempo | `src/dsp/tempo.js` | Autocorrelation over 8 s windows every 0.5 s. A Viterbi pass lets the tempo drift or jump but heavily penalises octave flips |
| Beats | `src/dsp/beats.js` | Dynamic-programming beat tracker (Ellis 2007) that follows the time-varying tempo, with sub-frame peak refinement |
| Tempo map | `src/tempomap.js` | Splits the beats into constant-tempo segments that keep every beat within the grid tolerance |
| MIDI | `src/midi.js` | Standard MIDI File writer |

Each segment's tempo is set so that its beats span exactly the time between its first detected
beat and the first detected beat of the next segment. Tempos are whole microseconds per beat,
and the rounding error is carried forward. Together these mean the MIDI grid lands on a detected
beat at every tempo change and never drifts.

If the first beat isn't at 0:00, a short lead-in (one or more beats) is added so the first
detected beat still lands on a grid line.

The analysis runs in a Web Worker (`src/worker.js`) and falls back to the main thread when a
worker can't start (`src/engine.js`).

## Limits

- The music needs audible rhythm. Beat tracking on ambient or free-time material is unreliable.
  Play it back with the click to check.
- Half-time and double-time readings are genuinely ambiguous. Use ÷2 / ×2.
- Without a Songsterr tab, downbeats aren't detected: bar 1 starts at 0:00, so bar lines may not
  match the song's downbeats. Slide the audio in your DAW, or edit the first bar.
- The Songsterr merge assumes the tab and the recording have the same structure. Extra or missing
  bars (a different intro, a repeat the tab doesn't have) put the notes out of line after that point.
- Detected drums are a starting point. Toms, ride, ghost notes and flams need fixing by hand.
- Charts are Expert only. Make the lower difficulties in Moonscraper.
- Only quarter-note beats (`n/4` time signatures) are written.

## Tests

```sh
npm test             # unit and pipeline tests (Node 22+, no dependencies)
npm run e2e          # browser test: needs Playwright with Chromium
```

The pipeline tests render synthetic drum grooves with a known beat grid (`src/synth.js`): a steady
tempo, a sudden jump and a gradual ramp. They check the detected beats, the tempo map, and the
beat times read back out of the written MIDI file.

The drum tests use a synthetic drum part that changes tempo, played alone and with a bass and chord
backing. They check two things:
- A constant-tempo tab of that part, with a 2-bar count-in, aligns to the right beat, and its kicks
  in `notes.mid` land within 25 ms of the real hits.
- Transcription finds kick, snare, hi-hat and crash hits.
