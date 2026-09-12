// midi compression.
//
// a .mid file holds a score, not audio, so there is no codec to turn down and
// ffmpeg cannot read it at all. size comes from the number of events and how many
// bytes each one costs, so this parses the file and rewrites it: throwing away
// text and padding first, then re-encoding what is left as compactly as the
// format allows, and only then dropping musical detail.

const HEADER = [0x4d, 0x54, 0x68, 0x64]; // "MThd"
const TRACK = [0x4d, 0x54, 0x72, 0x6b];  // "MTrk"

// meta events that change how the file sounds. everything else is names,
// lyrics, copyright text and cue markers, which cost bytes and sound like nothing.
const KEEP_META = new Set([0x2f, 0x51, 0x58, 0x59]); // end of track, tempo, time sig, key sig

class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  byte() { return this.b[this.i++]; }
  u16() { return (this.byte() << 8) | this.byte(); }
  u32() { return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0; }
  bytes(n) { const s = this.b.subarray(this.i, this.i + n); this.i += n; return s; }
  varlen() {
    let v = 0, c;
    do { c = this.byte(); v = (v << 7) | (c & 0x7f); } while (c & 0x80);
    return v;
  }
  tag(expected) {
    for (const e of expected) if (this.byte() !== e) return false;
    return true;
  }
}

function writeVarlen(out, value) {
  let v = value >>> 0;
  const stack = [v & 0x7f];
  v >>>= 7;
  while (v > 0) { stack.push((v & 0x7f) | 0x80); v >>>= 7; }
  for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]);
}

/** parse a standard midi file into absolute-tick events. */
export function parseMidi(bytes) {
  const r = new Reader(bytes);
  if (!r.tag(HEADER)) throw new Error('not a midi file (no mthd header)');
  const headerLen = r.u32();
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  r.i += Math.max(0, headerLen - 6); // skip any extra header bytes, never seek backwards

  const tracks = [];
  for (let t = 0; t < trackCount && r.i < bytes.length; t++) {
    if (!r.tag(TRACK)) break;
    const len = r.u32();
    const end = r.i + len;
    const events = [];
    let tick = 0;
    let status = 0;

    while (r.i < end) {
      tick += r.varlen();
      let b = r.byte();
      if (b < 0x80) {
        // running status: reuse the last status byte. there not being one means the
        // track opened mid-message, so the bytes from here on are meaningless.
        if (!status) throw new Error('this midi file is corrupt (a track starts mid-message)');
        r.i--;
        b = status;
      } else if (b < 0xf0) {
        status = b;
      }

      if (b === 0xff) {
        const type = r.byte();
        const len2 = r.varlen();
        events.push({ tick, kind: 'meta', type, data: r.bytes(len2).slice() });
      } else if (b === 0xf0 || b === 0xf7) {
        const len2 = r.varlen();
        events.push({ tick, kind: 'sysex', status: b, data: r.bytes(len2).slice() });
      } else {
        const hi = b & 0xf0;
        const channel = b & 0x0f;
        const a = r.byte();
        const c = (hi === 0xc0 || hi === 0xd0) ? 0 : r.byte();
        events.push({ tick, kind: 'channel', hi, channel, a, b: c });
      }
    }
    r.i = end;
    tracks.push(events);
  }
  if (!tracks.length) throw new Error('this midi file has no tracks');
  return { format, division, tracks };
}

/** rewrite the score under a set of reductions and return the bytes. */
export function renderMidi(song, opts) {
  const smpte = (song.division & 0x8000) !== 0;
  const divScale = smpte ? 1 : (opts.divisionScale || 1);
  const division = smpte ? song.division : Math.max(1, Math.round(song.division / divScale));

  // one merged track is both smaller and lets running status run across the whole file.
  let events = [];
  for (const track of song.tracks) events = events.concat(track);
  events.sort((x, y) => x.tick - y.tick);

  const out = [];
  let lastTick = 0;
  let status = -1;
  let sounding = 0;
  let noteIndex = 0;
  let kept = 0;
  // pending count per pitch, so a note-off is dropped exactly when its note-on was.
  const dropped = new Map();

  for (const ev of events) {
    if (ev.kind === 'sysex') continue;                       // never audible on its own
    if (ev.kind === 'meta') {
      if (ev.type === 0x2f) continue;                        // end of track is re-added once
      if (!KEEP_META.has(ev.type)) continue;
    } else {
      const { hi, channel, a } = ev;
      if (opts.dropChannels?.has(channel)) continue;
      if (opts.dropAftertouch && (hi === 0xa0 || hi === 0xd0)) continue;
      if (opts.dropPitchBend && hi === 0xe0) continue;
      if (hi === 0xb0) {
        if (opts.dropAllControl) continue;
        if (opts.dropMinorControl && a !== 7 && a !== 10 && a !== 64 && a !== 11) continue;
      }
      // thin the notes themselves: a polyphony cap first, then a stride that keeps
      // one note in every n. both need the matching note-off dropped as well.
      const isOn = hi === 0x90 && ev.b > 0;
      const isOff = hi === 0x80 || (hi === 0x90 && ev.b === 0);
      if (isOn || isOff) {
        const id = channel * 128 + a;
        if (isOn) {
          const tooMany = opts.maxVoices && sounding >= opts.maxVoices;
          const offBeat = opts.noteStride && (noteIndex++ % opts.noteStride) !== 0;
          if (tooMany || offBeat) {
            dropped.set(id, (dropped.get(id) || 0) + 1);
            continue;
          }
          sounding++;
          kept++;
        } else {
          const pending = dropped.get(id) || 0;
          if (pending > 0) { dropped.set(id, pending - 1); continue; }
          sounding = Math.max(0, sounding - 1);
        }
      }
    }

    const tick = smpte ? ev.tick : Math.round(ev.tick / divScale);
    writeVarlen(out, Math.max(0, tick - lastTick));
    lastTick = tick;

    if (ev.kind === 'meta') {
      out.push(0xff, ev.type);
      writeVarlen(out, ev.data.length);
      for (const d of ev.data) out.push(d);
      status = -1; // meta events reset running status
    } else {
      let { hi, channel, a, b } = ev;
      // a note off is one byte cheaper as a note on with zero velocity, and it keeps
      // the running status chain unbroken through every note in the file.
      if (hi === 0x80) { hi = 0x90; b = 0; }
      const st = hi | channel;
      if (st !== status) { out.push(st); status = st; }
      out.push(a & 0x7f);
      if (hi !== 0xc0 && hi !== 0xd0) out.push(b & 0x7f);
    }
  }

  out.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const file = new Uint8Array(14 + 8 + out.length);
  file.set([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1], 0); // MThd, format 0, 1 track
  file[12] = (division >> 8) & 0xff;
  file[13] = division & 0xff;
  file.set(TRACK, 14);
  file[18] = (out.length >>> 24) & 0xff;
  file[19] = (out.length >>> 16) & 0xff;
  file[20] = (out.length >>> 8) & 0xff;
  file[21] = out.length & 0xff;
  file.set(out, 22);
  file.notes = kept;
  return file;
}

/** note count per channel, used to decide which parts to sacrifice first. */
function channelWeights(song) {
  const notes = new Map();
  for (const track of song.tracks) {
    for (const ev of track) {
      if (ev.kind === 'channel' && ev.hi === 0x90 && ev.b > 0) {
        notes.set(ev.channel, (notes.get(ev.channel) || 0) + 1);
      }
    }
  }
  return [...notes.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
}

/**
 * compress a midi file to a byte target by applying progressively harsher
 * reductions, stopping at the first one that fits.
 */
export async function compressMidi(file, targetBytes, report) {
  const song = parseMidi(new Uint8Array(await file.arrayBuffer()));
  const sparsest = channelWeights(song);

  // ordered least to most destructive. the first few change nothing audible.
  const levels = [
    { label: 'stripped text and re-packed', opts: {} },
    { label: 'without aftertouch', opts: { dropAftertouch: true } },
    { label: 'without pitch bend', opts: { dropAftertouch: true, dropPitchBend: true } },
    { label: 'core controllers only',
      opts: { dropAftertouch: true, dropPitchBend: true, dropMinorControl: true } },
    { label: 'no controllers',
      opts: { dropAftertouch: true, dropPitchBend: true, dropAllControl: true } },
  ];
  for (const scale of [2, 4, 8, 16]) {
    levels.push({ label: 'timing resolution / ' + scale,
      opts: { dropAftertouch: true, dropPitchBend: true, dropAllControl: true, divisionScale: scale } });
  }
  const bare = { dropAftertouch: true, dropPitchBend: true, dropAllControl: true, divisionScale: 8 };
  for (const voices of [16, 8, 4, 2, 1]) {
    levels.push({ label: voices === 1 ? 'one note at a time' : voices + ' voices at once',
      opts: { ...bare, maxVoices: voices } });
  }
  // thin the melody itself before giving up whole parts: one note in n still plays.
  for (const stride of [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]) {
    levels.push({ label: 'one note in every ' + stride,
      opts: { ...bare, maxVoices: 1, noteStride: stride } });
  }
  // last resort, and never the final part: a file with no notes is not music.
  for (let n = 1; n < sparsest.length; n++) {
    levels.push({ label: 'dropped ' + n + ' of ' + sparsest.length + ' parts',
      opts: { ...bare, maxVoices: 1, noteStride: 64, dropChannels: new Set(sparsest.slice(0, n)) } });
  }

  let smallest = null;
  for (let i = 0; i < levels.length; i++) {
    const { label, opts } = levels[i];
    report?.step?.(i, levels.length, label);
    const bytes = renderMidi(song, opts);
    if (!bytes.notes) continue; // a silent file is not an answer
    const blob = new Blob([bytes], { type: 'audio/midi' });
    if (!smallest || blob.size < smallest.size) smallest = { size: blob.size, blob };
    if (blob.size <= targetBytes) {
      return { blob, size: blob.size, container: 'mid', detail: label };
    }
  }

  const err = new Error('below the smallest version of this score that still plays notes');
  err.smallest = smallest;
  throw err;
}
