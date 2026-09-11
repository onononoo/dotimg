import { compressImage, decodeImage, fitImageVia, supportsEncode } from './image-engine.js';
import { compressVideo, compressGif, compressAudio, decodeStillViaFFmpeg, encodeStillViaFFmpeg,
         onProgress, engineLoaded, FFMPEG_STILL_FORMATS } from './media-engine.js';
import { compressMidi } from './midi-engine.js';

const $ = id => document.getElementById(id);

/** The one file being worked on. */
let current = null;
let busy = false;

/* ---------- formats ---------- */

// Every extension the app handles, mapped to the engine family that takes it.
const EXT_KIND = {
  // audio
  mp3: 'audio', wav: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio',
  m4a: 'audio', wma: 'audio', alac: 'audio', aiff: 'audio', aif: 'audio', aifc: 'audio',
  opus: 'audio', caf: 'audio', amr: 'audio', ac3: 'audio', m4b: 'audio',
  mid: 'midi', midi: 'midi', rmi: 'midi',
  // video
  mp4: 'video', m4v: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video',
  flv: 'video', wmv: 'video', '3gp': 'video', '3g2': 'video', mpeg: 'video', mpg: 'video',
  ogv: 'video', ts: 'video', mts: 'video', m2ts: 'video', asf: 'video', vob: 'video',
  // still images
  jpg: 'image', jpeg: 'image', jfif: 'image', png: 'image', bmp: 'image', tiff: 'image',
  tif: 'image', svg: 'image', ico: 'image', heic: 'image', heif: 'image', raw: 'image',
  dng: 'image', cr2: 'image', nef: 'image', arw: 'image', orf: 'image', rw2: 'image',
  avif: 'image', jxl: 'image',
  // animation, or a still pretending to be one
  gif: 'anim', webp: 'maybe-anim', apng: 'maybe-anim',
};

// Still formats the canvas itself can write.
const CANVAS_IMAGE = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

// What each family may be converted into. A file only ever offers its own family,
// so music stays music, video stays video, and a picture stays a picture.
const FAMILY = {
  audio: ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'wma', 'alac', 'aiff', 'opus'],
  midi: ['mid'],
  image: ['jpg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'ico'],
  anim: ['gif', 'mp4', 'webm', 'mkv', 'mov', 'avi'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'avi'],
};

const LABELS = {
  mp3: 'MP3', wav: 'WAV', aac: 'AAC', flac: 'FLAC (lossless)', ogg: 'OGG Vorbis',
  m4a: 'M4A (AAC)', wma: 'WMA', alac: 'ALAC (lossless)', aiff: 'AIFF', opus: 'Opus',
  mid: 'MIDI',
  jpg: 'JPEG', png: 'PNG (lossless)', webp: 'WebP', avif: 'AVIF',
  gif: 'GIF', bmp: 'BMP', tiff: 'TIFF', ico: 'ICO (icon, 256px max)',
  mp4: 'MP4 (H.264)', webm: 'WebM (VP9)', mkv: 'MKV (H.264)', mov: 'MOV (H.264)',
  avi: 'AVI (MPEG-4)',
};

// Extensions that mean the same format under a different spelling.
const SAME_AS = {
  jpeg: 'jpg', jfif: 'jpg', tif: 'tiff', midi: 'mid', rmi: 'mid',
  aif: 'aiff', aifc: 'aiff', m4v: 'mp4', oga: 'ogg', mpg: 'mpeg',
};

const KIND_NAME = {
  audio: 'music or audio', midi: 'MIDI score', image: 'still picture',
  anim: 'animation', video: 'video',
};

/* ---------- helpers ---------- */

const UNITS = [['GB', 1e9], ['MB', 1e6], ['KB', 1e3]];

function fmtBytes(n) {
  if (n == null) return '-';
  for (const [label, mult] of UNITS) {
    if (n >= mult) return (n / mult).toFixed(n / mult >= 100 ? 0 : n / mult >= 10 ? 1 : 2) + ' ' + label;
  }
  return n + ' bytes';
}

function extOf(file) {
  const name = (file.name || '').toLowerCase();
  return name.slice(name.lastIndexOf('.') + 1);
}

function normalExt(file) {
  const ext = extOf(file);
  return SAME_AS[ext] || ext;
}

function kindOf(file) {
  const ext = extOf(file);
  if (EXT_KIND[ext]) return EXT_KIND[ext];

  const type = file.type || '';
  if (type === 'audio/midi' || type === 'audio/x-midi') return 'midi';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type === 'image/gif') return 'anim';
  return 'image';
}

/** WebP and PNG can be animated; sniff the bytes rather than trusting the extension. */
async function isAnimated(file) {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const ascii = String.fromCharCode(...head.slice(0, 64));
  if (ascii.startsWith('RIFF') && ascii.includes('WEBP')) {
    for (let i = 12; i < head.length - 4; i++) {
      if (head[i] === 0x41 && head[i+1] === 0x4E && head[i+2] === 0x49 && head[i+3] === 0x4D) return true;
    }
    return false;
  }
  if (head[0] === 0x89 && head[1] === 0x50) { // PNG: look for acTL
    for (let i = 8; i < head.length - 4; i++) {
      if (head[i] === 0x61 && head[i+1] === 0x63 && head[i+2] === 0x54 && head[i+3] === 0x4C) return true;
    }
    return false;
  }
  return false;
}

/** Say why a picture could not be opened, in terms the person can act on. */
function undecodableReason(file) {
  const ext = extOf(file);
  if (['heic', 'heif'].includes(ext)) {
    return 'HEIC needs Apple’s decoder. It works in Safari, but no other browser can read ' +
           'it and the bundled FFmpeg has no HEIF support. Export it as JPEG first.';
  }
  if (['raw', 'dng', 'cr2', 'nef', 'arw', 'orf', 'rw2'].includes(ext)) {
    return 'camera RAW is laid out differently by every manufacturer, and neither this browser ' +
           'nor the bundled FFmpeg can develop it. Export a JPEG or TIFF from your photo app first.';
  }
  return 'neither this browser nor the bundled FFmpeg can decode ' + (ext ? '.' + ext : 'this file');
}

function setStatus(text) { $('status').textContent = text; }

/* ---------- picking a file ---------- */

async function pick(file, extraNote) {
  if (busy) return;
  current = null;
  $('output').hidden = true;
  setStatus('');
  $('result').textContent = '';

  let kind = kindOf(file);
  if (kind === 'maybe-anim') kind = (await isAnimated(file)) ? 'anim' : 'image';

  current = { file, kind, decodable: null };

  $('dName').textContent = file.name || 'untitled';
  $('dKind').textContent = KIND_NAME[kind] + (file.type ? ' (' + file.type + ')' : '');
  $('dSize').textContent = fmtBytes(file.size);
  $('dExtraLabel').textContent = 'Details';
  $('dExtra').textContent = 'reading...';

  buildFormatList(kind, normalExt(file), extOf(file));
  suggestTarget(file);
  $('details').hidden = false;
  if (extraNote) { $('output').hidden = false; setStatus(extraNote); }

  describe(current);
}

// Whether this browser can write AVIF. The probe is slow enough to notice, so it runs
// once at load and the dropdown is built from whatever the answer is by then; if it
// arrives late, the option is added to the list already on screen.
let avifOK = false;
supportsEncode('image/avif').then(ok => {
  avifOK = ok;
  if (ok && current && current.kind === 'image') {
    buildFormatList(current.kind, normalExt(current.file), extOf(current.file), true);
  }
});

/** Fill the dropdown with this family only, defaulting to what the file already is.
 *  `keepChoice` is for rebuilding the list under a file already on screen, where the
 *  person may have chosen something already. */
function buildFormatList(kind, same, rawExt, keepChoice) {
  const sel = $('outFormat');
  const previous = sel.value;
  sel.innerHTML = '';

  for (const key of FAMILY[kind] || FAMILY.image) {
    if (key === 'avif' && !avifOK) continue; // this browser has no AVIF encoder
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = LABELS[key] || key.toUpperCase();
    sel.append(opt);
  }

  const has = v => [...sel.options].some(o => o.value === v);
  if (keepChoice && previous && has(previous)) sel.value = previous;
  else if (has(same)) sel.value = same;

  const note = $('formatNote');
  if (kind === 'midi') {
    note.textContent = 'A MIDI file stores notes rather than sound, so it can only stay MIDI. ' +
      'Turning it into MP3 would need a synthesiser.';
  } else if (rawExt === 'svg') {
    note.textContent = 'SVG can be read but not written back: a drawing cannot be rebuilt once ' +
      'it has been flattened into pixels.';
  } else if (kind === 'anim') {
    note.textContent = 'Converting an animation to MP4 or WebM is usually many times smaller ' +
      'than keeping it a GIF.';
  } else {
    note.textContent = '';
  }
}

/** Start the target box at a tenth of the file rather than at 1 MB for everything. */
function suggestTarget(file) {
  const tenth = Math.max(1, Math.round(file.size / 10));
  let unit = 1000000, value = tenth / 1000000;
  if (tenth < 1000) { unit = 1; value = tenth; }
  else if (tenth < 1000000) { unit = 1000; value = tenth / 1000; }
  $('targetUnit').value = String(unit);
  $('targetValue').value = String(Math.max(1, Math.round(value * 10) / 10));
}

/** Fill in the details row: dimensions for pictures, a note for everything else. */
async function describe(item) {
  const cell = $('dExtra');
  if (item.kind === 'midi') {
    cell.textContent = 'a score, compressed by rewriting the notes themselves';
    return;
  }
  if (item.kind !== 'image' && item.kind !== 'anim') {
    cell.textContent = 'length is read when compressing starts';
    return;
  }
  try {
    $('dExtraLabel').textContent = 'Dimensions';
    const bmp = await decodeImage(item.file);
    item.decodable = true;
    cell.textContent = bmp.width + ' x ' + bmp.height + ' pixels';
    bmp.close?.();
  } catch {
    item.decodable = false;
    cell.textContent = 'no preview: this browser cannot read it, FFmpeg will be tried instead';
  }
}

/* ---------- compressing ---------- */

function readTarget() {
  const v = parseFloat($('targetValue').value);
  if (!isFinite(v) || v <= 0) return null;
  return Math.max(1, Math.floor(v * parseFloat($('targetUnit').value)));
}

async function run() {
  if (busy || !current) return;
  const target = readTarget();
  $('output').hidden = false;
  if (!target) { setStatus('Type a target size first.'); return; }

  const item = current;
  const out = $('outFormat').value;
  if (!out) { setStatus('Give the format list a moment to fill in, then try again.'); return; }
  busy = true;
  $('go').disabled = true;
  $('result').textContent = '';
  setStatus('Working...');
  const started = performance.now();

  try {
    try {
      await attempt(item, out, target, started);
    } catch (err) {
      // FFmpeg's heap can trap on a long session. It restarts itself, so the honest
      // thing is to quietly try the same job once more rather than blame the file.
      if (!/restarted/.test(err.message || '')) throw err;
      setStatus('The engine restarted itself. Trying once more...');
      await attempt(item, out, target, performance.now());
    }
  } catch (err) {
    failed(err);
  } finally {
    busy = false;
    $('go').disabled = false;
  }
}

async function attempt(item, out, target, started) {
  // A target is a ceiling, not a quota: leave a file alone when it already fits and
  // the format is not changing.
  if (item.file.size <= target && out === normalExt(item.file)) {
    finish(item, item.file, extOf(item.file) || 'bin', started, 'already under your target');
    return;
  }

  // Converting with room to spare should still shrink the file, never grow it.
  const budget = Math.min(target, item.file.size);

  const report = {
    state: s => setStatus('Engine: ' + s),
    step: (i, n, label) => setStatus('Working: ' + label),
  };
  onProgress(p => {
    if (busy && p > 0 && p < 1) setStatus('Working: ' + Math.round(p * 100) + '%');
  });

  if (item.kind === 'midi') {
    const r = await compressMidi(item.file, budget, report);
    finish(item, r.blob, 'mid', started, r.detail);
    return;
  }

  if (item.kind === 'audio') {
    if (!engineLoaded()) setStatus('Loading the audio engine. This happens once.');
    const r = await compressAudio(item.file, budget, { format: out }, report);
    finish(item, r.blob, r.container, started, Math.round(r.duration) +
      ' seconds at about ' + Math.round(r.size * 8 / r.duration / 1000) + ' kbps');
    return;
  }

  if (item.kind === 'image') {
    const r = await compressStill(item, out, budget, report);
    finish(item, r.blob, r.ext, started, r.detail);
    return;
  }

  // Animation or video from here on.
  if (!engineLoaded()) setStatus('Loading the video engine. This happens once.');

  if (out === 'gif') {
    const r = await compressGif(item.file, budget, {}, report);
    finish(item, r.blob, 'gif', started, r.width + ' pixels wide, ' + r.fps +
      ' frames a second, ' + r.colors + ' colours');
    return;
  }

  const r = await compressVideo(item.file, budget, { container: out, keepAudio: true }, report);
  finish(item, r.blob, r.container, started, Math.round(r.duration) +
    ' seconds at about ' + Math.round(r.size * 8 / r.duration / 1000) + ' kbps');
}

/** Still pictures: the canvas writes most formats and FFmpeg writes the rest. */
async function compressStill(item, out, budget, report) {
  let source = item.file;

  if (item.decodable === false) {
    setStatus('This browser cannot read that picture. Trying FFmpeg instead...');
    try {
      source = await decodeStillViaFFmpeg(item.file, report);
    } catch {
      throw new Error(undecodableReason(item.file));
    }
  }

  const onStep = (p, label) => setStatus('Trying ' + label + '...');

  if (CANVAS_IMAGE[out]) {
    const r = await compressImage(source, budget, CANVAS_IMAGE[out], onStep);
    const detail = r.width + ' x ' + r.height +
      (r.quality != null ? ' at quality ' + Math.round(r.quality * 100) : ', lossless');
    return { blob: r.blob, ext: out, detail };
  }

  if (!FFMPEG_STILL_FORMATS[out]) throw new Error('unknown output format: ' + out);

  // GIF, BMP, TIFF and ICO: the canvas cannot write these, so every measurement in the
  // search goes out to FFmpeg as a PNG and comes back in the real format.
  const bitmap = await decodeImage(source);
  try {
    const r = await fitImageVia(bitmap, budget,
      png => encodeStillViaFFmpeg(png, out, report), onStep);
    return { blob: r.blob, ext: FFMPEG_STILL_FORMATS[out].ext,
             detail: r.width + ' x ' + r.height + ', lossless' };
  } finally {
    bitmap.close?.();
  }
}

function finish(item, blob, ext, started, detail) {
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  const pct = item.file.size ? Math.round((1 - blob.size / item.file.size) * 100) : 0;
  const change = blob === item.file ? 'left unchanged'
    : pct > 0 ? pct + '% smaller'
    : pct < 0 ? Math.abs(pct) + '% larger'
    : 'the same size';

  setStatus('Done in ' + secs + ' seconds.');

  const base = (item.file.name || 'output').replace(/\.[^.]+$/, '');
  const name = base + '.dotimg.' + ext;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.textContent = 'Download ' + name;

  const size = document.createElement('b');
  size.textContent = fmtBytes(blob.size);

  $('result').textContent = '';
  $('result').append(size, ' (' + change + '), ' + detail + '.',
    document.createElement('br'), link);
}

function failed(err) {
  setStatus('Could not do it: ' + (err.message || String(err)));
  $('result').textContent = '';

  const closest = err.smallest;
  if (!closest?.blob) return;

  const link = document.createElement('a');
  link.href = URL.createObjectURL(closest.blob);
  link.download = 'smallest-possible';
  link.textContent = 'Download that instead';
  $('result').append('The smallest this could get is ' + fmtBytes(closest.size) + '. ', link);
}

/* ---------- wiring ---------- */

$('picker').addEventListener('change', () => {
  const file = $('picker').files[0];
  if (file) pick(file);
});

$('go').addEventListener('click', run);

// Dropping and pasting still work. They simply fill the same file box.
function adopt(file, note) {
  const dt = new DataTransfer();
  dt.items.add(file);
  $('picker').files = dt.files;
  pick(file, note);
}

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  adopt(files[0], files.length > 1
    ? 'You dropped ' + files.length + ' files. This page works on one at a time, so it took the first.'
    : null);
});
document.addEventListener('paste', e => {
  const file = e.clipboardData?.files?.[0];
  if (file) adopt(file, null);
});
