// video / animation / audio compression via ffmpeg compiled to webassembly.
// single-threaded core, so it needs no cross-origin isolation headers.

// the wrapper and the core loader are served from this origin, because browsers refuse
// to start a worker from a cross-origin script.
const FFMPEG_JS = './vendor/ffmpeg/index.js';
const CORE_JS = new URL('./vendor/core/ffmpeg-core.js', import.meta.url).href;

// the core binary is 32 mb, which is over the per-file limit on several static hosts
// (cloudflare pages allows 25 mb), so it is not always deployed with the rest of the
// site. prefer the local copy when it is really there, and otherwise fetch the same
// version from the cdn it was downloaded from. getting this wrong gives an empty
// download and a compileerror about an empty buffersource, so the check is explicit.
const CORE_WASM_LOCAL = new URL('./vendor/core/ffmpeg-core.wasm', import.meta.url).href;
const CORE_WASM_CDN =
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm';

let wasmSource = 'unknown';
export function wasmOrigin() { return wasmSource; }

async function resolveWasmURL() {
  try {
    const res = await fetch(CORE_WASM_LOCAL, { method: 'HEAD' });
    const type = res.headers.get('content-type') || '';
    const size = Number(res.headers.get('content-length') || 0);
    // a missing file can still answer 200 with an html page on some hosts, and a real
    // core is tens of megabytes, so a small or html answer means it is not there.
    const plausible = res.ok && !type.includes('text/html') && (size === 0 || size > 1000000);
    if (plausible) { wasmSource = 'local'; return CORE_WASM_LOCAL; }
  } catch { /* offline, blocked, or no such file: fall through to the CDN */ }
  wasmSource = 'cdn';
  return CORE_WASM_CDN;
}

let loading = null;
let ff = null;
const logLines = [];
let progressSink = null;

export function onProgress(fn) { progressSink = fn; }
export function engineLoaded() { return !!ff; }
export function lastLog(n = 60) { return logLines.slice(-n).join('\n'); }

export async function getFFmpeg(onState) {
  if (ff) return ff;
  if (loading) return loading;
  loading = (async () => {
    onState?.('loading engine (~32 mb, cached after this)');
    const wasmURL = await resolveWasmURL();
    const { FFmpeg } = await import(FFMPEG_JS);
    const inst = new FFmpeg();
    inst.on('log', ({ message }) => {
      logLines.push(message);
      if (logLines.length > 1200) logLines.shift();
    });
    inst.on('progress', ({ progress }) => progressSink?.(progress));
    try {
      await inst.load({ coreURL: CORE_JS, wasmURL });
    } catch (e) {
      loading = null; // let the next attempt start over rather than reuse a dead load
      throw new Error(wasmSource === 'cdn'
        ? 'could not load the compression engine. the 32 mb core is not on this site, ' +
          'and the copy on cdn.jsdelivr.net could not be fetched either.'
        : 'could not load the compression engine from this site: ' + (e.message || e));
    }
    onState?.('ready');
    ff = inst;
    return inst;
  })();
  return loading;
}

const clean = s => s.replace(/[^\w.-]/g, '_');

// ffmpeg's heap grows a little with every run and never fully gives it back, so a long
// queue eventually traps. reloading costs about a tenth of a second locally, so the
// engine is retired well before it gets there.
let execCount = 0;
let bytesSinceLoad = 0;
// kept deliberately high. recycling allocates a new 32 mb instance while the old one
// waits to be collected, so retiring the engine too eagerly costs more memory than it
// saves. a crash is caught and retried instead, which is cheaper than churning.
const MAX_RUNS_PER_ENGINE = 40;
const MAX_BYTES_PER_ENGINE = 512 * 1024 * 1024;

async function freshFFmpeg(onState) {
  if (ff && (execCount >= MAX_RUNS_PER_ENGINE || bytesSinceLoad >= MAX_BYTES_PER_ENGINE)) {
    try { ff.terminate(); } catch {}
    ff = null;
    loading = null;
    execCount = 0;
    bytesSinceLoad = 0;
    onState?.('recycling engine');
  }
  return getFFmpeg(onState);
}

async function write(f, file, name) {
  bytesSinceLoad += file.size || 0;
  await f.writeFile(name, new Uint8Array(await file.arrayBuffer()));
}

async function safeDelete(f, name) { try { await f.deleteFile(name); } catch {} }

/**
 * run ffmpeg and survive a hard crash. a wasm trap leaves the heap unusable, so the
 * instance is thrown away and the next file starts a fresh one instead of failing
 * for the rest of the session.
 */
async function execChecked(f, args) {
  execCount++;
  try {
    return await f.exec(args);
  } catch (e) {
    try { f.terminate(); } catch {}
    if (ff === f) { ff = null; loading = null; }
    // any throw out of exec means the wasm heap is gone and the instance above was
    // just discarded, so every one of these is a restart. the core reports a hard
    // abort as a typeerror from its own error handling, which is why the text is
    // not matched on: the terminate already happened either way.
    throw new Error('the engine hit its memory limit on this file and has been restarted');
  }
}

function toBlob(data, type) {
  const buf = data.buffer ? data.buffer : data;
  return new Blob([buf], { type });
}

// probe duration, resolution, fps and stream layout from ffmpeg's own log output.
async function probe(f, inName) {
  logLines.length = 0;
  try { await execChecked(f, ['-hide_banner', '-i', inName]); } catch (e) {
    if (/restarted/.test(e.message)) throw e; // a crashed engine is not a probe result
  }
  const text = logLines.join('\n');

  let duration = 0;
  const d = text.match(/Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  if (d) duration = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);

  let width = 0, height = 0;
  const v = text.match(/Video:.*?[,\s](\d{2,5})x(\d{2,5})/);
  if (v) { width = +v[1]; height = +v[2]; }

  let fps = 0;
  const r = text.match(/(\d+(?:\.\d+)?)\s*fps/);
  if (r) fps = parseFloat(r[1]);

  return {
    duration,
    width, height,
    fps: fps || 0,
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(text),
    hasVideo: /Stream #\d+:\d+.*: Video:/.test(text),
    log: text,
  };
}

function evenDims(w, h, scale) {
  return [
    Math.max(2, Math.round(w * scale / 2) * 2),
    Math.max(2, Math.round(h * scale / 2) * 2),
  ];
}

// each video container with the codecs that belong in it. only these four fields
// differ between them; the bitrate budgeting below is shared.
export const VIDEO_FORMATS = {
  mp4:  { ext: 'mp4',  mime: 'video/mp4',      video: 'libx264',     audio: 'aac' },
  mkv:  { ext: 'mkv',  mime: 'video/x-matroska', video: 'libx264',   audio: 'aac' },
  mov:  { ext: 'mov',  mime: 'video/quicktime', video: 'libx264',    audio: 'aac' },
  webm: { ext: 'webm', mime: 'video/webm',     video: 'libvpx-vp9',  audio: 'libopus' },
  avi:  { ext: 'avi',  mime: 'video/x-msvideo', video: 'mpeg4',      audio: 'libmp3lame' },
};

/**
 * encode video (or audio-only) to a byte target: budget a bitrate from the real
 * duration, then correct that bitrate over repeated passes until it lands under.
 */
export async function compressVideo(file, targetBytes, opts, report) {
  const f = await freshFFmpeg(s => report?.state?.(s));
  const inName = 'in_' + clean(file.name || 'input');
  await write(f, file, inName);

  try {
    const info = await probe(f, inName);
    if (!info.duration || !isFinite(info.duration)) {
      throw new Error('could not read a duration from this file, it may be unsupported or corrupt');
    }

    const spec = VIDEO_FORMATS[opts.container] || VIDEO_FORMATS.mp4;
    const container = spec.ext;
    const outName = 'out.' + container;
    const mime = spec.mime;

    // muxer overhead grows with duration, so hold back a safety margin.
    const overhead = Math.min(0.1, 0.02 + info.duration * 0.00015);
    const budgetBits = targetBytes * 8 * (1 - overhead);
    const totalBudgetBps = budgetBits / info.duration;

    let audioBps = 0;
    if (opts.keepAudio && info.hasAudio) {
      audioBps = Math.max(16000, Math.min(64000, Math.floor(totalBudgetBps * 0.25)));
      if (totalBudgetBps < 40000) audioBps = 0; // too tight for sound at all
    }

    let videoBps = Math.max(1000, Math.floor(totalBudgetBps) - audioBps);

    // never spend more bits than the source already has; re-encoding must not inflate.
    const sourceBps = file.size * 8 / info.duration;
    if (videoBps + audioBps > sourceBps) {
      videoBps = Math.max(1000, Math.floor(sourceBps * 0.9) - audioBps);
    }

    if (!info.hasVideo) {
      audioBps = Math.max(8000, Math.floor(totalBudgetBps));
      videoBps = 0;
    }

    const srcW = info.width || 1280;
    const srcH = info.height || 720;
    const srcFps = info.fps > 0 && info.fps < 480 ? info.fps : 30;

    let best = null;
    let lastOver = null;
    const MAX_PASSES = 4;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const args = ['-hide_banner', '-y', '-i', inName];

      if (info.hasVideo) {
        // keep bits-per-pixel sane: drop frame rate then frame size when the budget is thin.
        let fps = srcFps;
        if (videoBps < 150000 && fps > 24) fps = 24;
        if (videoBps < 60000 && fps > 15) fps = 15;
        if (videoBps < 25000 && fps > 10) fps = 10;

        const bpp = spec.video === 'libvpx-vp9' ? 0.045 : 0.06;
        let scale = Math.sqrt(videoBps / (bpp * fps * srcW * srcH));
        scale = Math.max(0.05, Math.min(1, scale));
        const [w, h] = evenDims(srcW, srcH, scale);

        args.push('-vf', 'fps=' + fps.toFixed(3) + ',scale=' + w + ':' + h + ':flags=lanczos');
        if (spec.video === 'libvpx-vp9') {
          args.push('-c:v', 'libvpx-vp9', '-b:v', String(videoBps), '-deadline', 'realtime',
            '-cpu-used', '5', '-row-mt', '1', '-pix_fmt', 'yuv420p');
        } else if (spec.video === 'mpeg4') {
          args.push('-c:v', 'mpeg4', '-vtag', 'DIVX', '-b:v', String(videoBps), '-pix_fmt', 'yuv420p');
        } else {
          args.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', String(videoBps),
            '-maxrate', String(Math.round(videoBps * 1.35)),
            '-bufsize', String(Math.round(videoBps * 2)), '-pix_fmt', 'yuv420p');
          // faststart only means anything in an mp4-family container.
          if (spec.ext === 'mp4' || spec.ext === 'mov') args.push('-movflags', '+faststart');
        }
      } else {
        args.push('-vn');
      }

      if (audioBps > 0) {
        args.push('-c:a', spec.audio, '-b:a', String(audioBps),
          '-ac', audioBps < 48000 ? '1' : '2');
        // mp3 in avi cannot use arbitrary sample rates the way aac can.
        if (spec.audio === 'libmp3lame') args.push('-ar', '44100');
      } else {
        args.push('-an');
      }
      args.push(outName);

      report?.step?.(pass, MAX_PASSES,
        'pass ' + (pass + 1) + ' at ' + Math.round((videoBps + audioBps) / 1000) + ' kbps');

      await safeDelete(f, outName);

      let code;
      try {
        code = await execChecked(f, args);
      } catch (e) {
        // libvpx wants more heap than this single-threaded core can grow to, and gives
        // up somewhere above a very small frame. say that plainly instead of blaming
        // the file, and point at the containers that do work.
        if (spec.video.startsWith('libvpx') && /memory limit/.test(e.message)) {
          throw new Error('the bundled vp9 encoder runs out of memory above tiny frame sizes, ' +
            'so webm is unreliable in this browser. mp4, mkv, mov or avi will work.');
        }
        throw e;
      }
      if (code !== 0) throw new Error('ffmpeg could not encode this file (exit ' + code + ')');

      const data = await f.readFile(outName);
      const size = data.length ?? data.byteLength;
      const blob = toBlob(data, mime);

      if (size <= targetBytes) {
        if (!best || size > best.size) best = { blob, size };
        if (size >= targetBytes * 0.86 || pass === MAX_PASSES - 1) break;
        const total = Math.floor((videoBps + audioBps) * Math.min(1.6, (targetBytes * 0.94) / size));
        videoBps = Math.max(1000, total - audioBps);
      } else {
        lastOver = { blob, size };
        let total = Math.floor((videoBps + audioBps) * ((targetBytes * 0.9) / size));
        if (audioBps > 0 && total - audioBps < 8000) audioBps = 0;
        videoBps = Math.max(800, total - audioBps);
      }
    }

    if (!best) {
      const err = new Error('could not reach that size, the encoder bottoms out above it');
      err.smallest = lastOver;
      throw err;
    }
    await safeDelete(f, outName);
    return { blob: best.blob, size: best.size, container, duration: info.duration };
  } finally {
    await safeDelete(f, inName);
  }
}

/* ---------- audio ---------- */

// container and encoder for each audio output. every one of these is present in
// this ffmpeg build, checked with -encoders and -formats.
export const AUDIO_FORMATS = {
  mp3:  { ext: 'mp3',  mime: 'audio/mpeg',  codec: 'libmp3lame', lossy: true },
  aac:  { ext: 'aac',  mime: 'audio/aac',   codec: 'aac',        lossy: true, muxer: 'adts' },
  m4a:  { ext: 'm4a',  mime: 'audio/mp4',   codec: 'aac',        lossy: true, muxer: 'ipod' },
  opus: { ext: 'opus', mime: 'audio/opus',  codec: 'libopus',    lossy: true },
  ogg:  { ext: 'ogg',  mime: 'audio/ogg',   codec: 'libvorbis',  lossy: true },
  wma:  { ext: 'wma',  mime: 'audio/x-ms-wma', codec: 'wmav2',   lossy: true, muxer: 'asf' },
  flac: { ext: 'flac', mime: 'audio/flac',  codec: 'flac',       lossy: false },
  alac: { ext: 'm4a',  mime: 'audio/mp4',   codec: 'alac',       lossy: false, muxer: 'ipod' },
  wav:  { ext: 'wav',  mime: 'audio/wav',   codec: 'pcm_s16le',  lossy: false },
  aiff: { ext: 'aiff', mime: 'audio/aiff',  codec: 'pcm_s16be',  lossy: false },
};

// each lossy encoder refuses to go below its own floor; asking for less than this
// wastes a pass, so the search clamps here instead.
const MIN_BITRATE = { libmp3lame: 8000, aac: 8000, libopus: 6000, libvorbis: 32000, wmav2: 24000 };

// encoders accept only their own sample rates, and libopus is the strict one:
// hand it 32 khz and it refuses the whole job.
const RATES = {
  libopus: [8000, 12000, 16000, 24000, 48000],
  libmp3lame: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
  libvorbis: [8000, 11025, 16000, 22050, 32000, 44100, 48000],
  aac: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
  wmav2: [8000, 11025, 16000, 22050, 32000, 44100, 48000],
};

/** nearest rate at or above what we asked for, falling back to the codec's best. */
function pickRate(codec, desired) {
  const allowed = RATES[codec];
  if (!allowed) return desired;
  return allowed.find(r => r >= desired) ?? allowed[allowed.length - 1];
}

/**
 * encode audio to a byte target. lossy formats get a bitrate budgeted from the
 * duration and corrected against the real output; lossless formats have no
 * bitrate knob, so sample rate, channels and bit depth are searched instead.
 */
export async function compressAudio(file, targetBytes, opts, report) {
  const f = await freshFFmpeg(s => report?.state?.(s));
  const inName = 'in_' + clean(file.name || 'input');
  await write(f, file, inName);

  try {
    const info = await probe(f, inName);
    if (!info.hasAudio) throw new Error('no audio stream found in this file');
    if (!info.duration) throw new Error('could not read a duration from this file');

    const fmt = AUDIO_FORMATS[opts.format] || AUDIO_FORMATS.mp3;
    const outName = 'out.' + fmt.ext;
    const mux = fmt.muxer ? ['-f', fmt.muxer] : [];

    const run = async (args) => {
      await safeDelete(f, outName);
      const code = await execChecked(f, ['-hide_banner', '-y', '-i', inName, '-vn', ...args, ...mux, outName]);
      if (code !== 0) throw new Error('ffmpeg could not encode this audio (exit ' + code + ')');
      const data = await f.readFile(outName);
      const size = data.length ?? data.byteLength;
      return { size, blob: toBlob(data, fmt.mime) };
    };

    let best = null, smallest = null;
    const keep = out => {
      if (!smallest || out.size < smallest.size) smallest = out;
      if (out.size <= targetBytes && (!best || out.size > best.size)) best = out;
    };

    if (fmt.lossy) {
      const overhead = Math.min(0.08, 0.015 + info.duration * 0.0001);
      let bps = Math.floor(targetBytes * 8 * (1 - overhead) / info.duration);
      const floor = MIN_BITRATE[fmt.codec] || 8000;
      const MAX_PASSES = 4;

      for (let pass = 0; pass < MAX_PASSES; pass++) {
        // stereo and full sample rate stop being worth their bits at low bitrates.
        const channels = bps < 48000 ? 1 : 2;
        const wanted = bps < 16000 ? 16000 : bps < 32000 ? 24000 : bps < 64000 ? 32000 : 44100;
        const rate = pickRate(fmt.codec, wanted);
        const clamped = Math.max(floor, bps);

        report?.step?.(pass, MAX_PASSES,
          'pass ' + (pass + 1) + ' at ' + Math.round(clamped / 1000) + ' kbps, ' +
          (channels === 1 ? 'mono' : 'stereo'));

        const out = await run(['-c:a', fmt.codec, '-b:a', String(clamped),
                               '-ac', String(channels), '-ar', String(rate)]);
        keep(out);

        if (out.size <= targetBytes) {
          if (out.size >= targetBytes * 0.85 || clamped === floor || pass === MAX_PASSES - 1) break;
          bps = Math.floor(clamped * Math.min(1.7, targetBytes * 0.93 / out.size));
        } else {
          if (clamped === floor) break; // already at the encoder's floor
          bps = Math.floor(clamped * (targetBytes * 0.9 / out.size));
        }
      }
    } else {
      // lossless: rank the quality settings and binary search the ranking.
      const rungs = [];
      for (const rate of [48000, 44100, 32000, 22050, 16000, 11025, 8000]) {
        for (const channels of [2, 1]) {
          for (const depth of [24, 16, 8]) {
            rungs.push({ rate, channels, depth,
              score: Math.log2(rate) * channels * depth });
          }
        }
      }
      rungs.sort((a, b) => b.score - a.score);

      // bit depth is expressed differently per encoder: pcm picks a codec, flac takes
      // packed sample formats, and alac only accepts planar ones.
      const sampleFmt = (depth) => {
        if (fmt.codec === 'pcm_s16le') return ['-c:a', depth <= 8 ? 'pcm_u8' : 'pcm_s16le'];
        if (fmt.codec === 'pcm_s16be') return ['-c:a', depth <= 8 ? 'pcm_s8' : 'pcm_s16be'];
        if (fmt.codec === 'alac') return ['-c:a', 'alac', '-sample_fmt', depth <= 16 ? 's16p' : 's32p'];
        return ['-c:a', fmt.codec, '-sample_fmt', depth <= 16 ? 's16' : 's32'];
      };

      let lo = 0, hi = rungs.length - 1, step = 0;
      const STEPS = Math.ceil(Math.log2(rungs.length)) + 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = rungs[mid];
        report?.step?.(step++, STEPS, r.rate + ' Hz, ' + (r.channels === 1 ? 'mono' : 'stereo') +
          ', ' + r.depth + '-bit');
        const out = await run([...sampleFmt(r.depth),
          '-ar', String(pickRate(fmt.codec, r.rate)), '-ac', String(r.channels)]);
        keep(out);
        if (out.size <= targetBytes) hi = mid - 1; else lo = mid + 1;
      }
    }

    await safeDelete(f, outName);
    if (!best) {
      const err = new Error('below what this audio format can produce for this duration');
      err.smallest = smallest;
      throw err;
    }
    return { blob: best.blob, size: best.size, container: fmt.ext, duration: info.duration };
  } finally {
    await safeDelete(f, inName);
  }
}

// still formats the canvas cannot write, so ffmpeg does it. gif needs a generated
// palette to look like anything, and ico has a hard 256 pixel limit of its own.
export const FFMPEG_STILL_FORMATS = {
  gif:  { ext: 'gif',  mime: 'image/gif' },
  bmp:  { ext: 'bmp',  mime: 'image/bmp' },
  tiff: { ext: 'tiff', mime: 'image/tiff' },
  ico:  { ext: 'ico',  mime: 'image/x-icon', maxSide: 256 },
};

/** re-encode a png blob as one of the still formats only ffmpeg can write. */
export async function encodeStillViaFFmpeg(pngBlob, format, report) {
  const spec = FFMPEG_STILL_FORMATS[format];
  if (!spec) throw new Error('unsupported still format: ' + format);

  const f = await freshFFmpeg(s => report?.state?.(s));
  const outName = 'still_out.' + spec.ext;
  await write(f, pngBlob, 'still_in.png');

  try {
    const args = ['-hide_banner', '-y', '-i', 'still_in.png'];
    if (spec.maxSide) {
      // shrink only if it is over the limit, and keep the aspect ratio.
      args.push('-vf', "scale='min(" + spec.maxSide + ",iw)':'min(" + spec.maxSide +
        ",ih)':force_original_aspect_ratio=decrease");
    }
    if (format === 'gif') {
      args.push('-vf', 'split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse');
    }
    args.push(outName);

    await safeDelete(f, outName);
    const code = await execChecked(f, args);
    if (code !== 0) throw new Error('ffmpeg could not write a ' + format + ' here');
    const data = await f.readFile(outName);
    const blob = toBlob(data, spec.mime);
    await safeDelete(f, outName);
    return blob;
  } finally {
    await safeDelete(f, 'still_in.png');
  }
}

/** decode a still image ffmpeg understands but the browser does not, such as tiff. */
/**
 * turn an animated webp into something this ffmpeg can read.
 *
 * the bundled ffmpeg can write animated webp but not read it: its decoder logs
 * "skipping unsupported chunk: ANMF" for every frame and gives up, and reading support
 * only arrived in ffmpeg 7.1. the browser's ImageDecoder reads these fine and hands
 * back fully composited frames, so it does the decoding, and ffmpeg only has to join
 * plain png frames into a lossless intermediate the normal compressors accept.
 */
export async function decodeAnimatedWebp(file, report) {
  if (typeof ImageDecoder === 'undefined' || !(await ImageDecoder.isTypeSupported('image/webp'))) {
    throw new Error('this browser cannot split an animated webp into frames, and the bundled ' +
      'ffmpeg cannot either. try chrome, edge or firefox, or save it as a gif first.');
  }

  const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/webp' });
  await decoder.tracks.ready;
  await decoder.completed;
  const count = decoder.tracks.selectedTrack.frameCount;

  const f = await freshFFmpeg(s => report?.state?.(s));
  const names = [];
  let list = '';
  let shortestMs = Infinity;
  let totalMs = 0;

  try {
    for (let i = 0; i < count; i++) {
      report?.step?.(i, count, 'reading frame ' + (i + 1) + ' of ' + count);
      const { image } = await decoder.decode({ frameIndex: i });

      // some encoders write frames with no duration; browsers play those at about
      // 100 ms, so match what people actually see rather than a zero-length flash
      const rawMs = image.duration != null ? image.duration / 1000 : 0;
      const ms = rawMs > 10 ? rawMs : 100;
      shortestMs = Math.min(shortestMs, ms);
      totalMs += ms;

      const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
      canvas.getContext('2d').drawImage(image, 0, 0);
      image.close();
      const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());

      const name = 'webp_' + String(i).padStart(5, '0') + '.png';
      await f.writeFile(name, png);
      names.push(name);
      list += "file '" + name + "'\nduration " + (ms / 1000).toFixed(4) + '\n';
    }
    // the concat demuxer ignores the last duration unless the final file is listed again
    list += "file '" + names[names.length - 1] + "'\n";
    await f.writeFile('webp_frames.txt', new TextEncoder().encode(list));

    // a constant rate fine enough for the shortest frame; the fps filter repeats frames
    // to fill longer ones, so a deliberate pause keeps its length. the rate is kept
    // exact rather than rounded, and the output is cut at the true total: rounding 33.3
    // down to 33, plus the extra frame the concat trailing entry contributes, made a
    // 0.9 second loop play back at 0.97 seconds.
    const rate = Math.max(1, Math.min(50, 1000 / shortestMs));
    await safeDelete(f, 'webp_intermediate.mkv');
    const code = await execChecked(f, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0',
      '-i', 'webp_frames.txt', '-vf', 'fps=' + rate.toFixed(4), '-t', (totalMs / 1000).toFixed(4),
      '-c:v', 'png', '-f', 'matroska', 'webp_intermediate.mkv']);
    if (code !== 0) throw new Error('could not rebuild the frames of this animated webp');

    const data = await f.readFile('webp_intermediate.mkv');
    await safeDelete(f, 'webp_intermediate.mkv');
    // returned as a file, not a path: the engine may be recycled before the compressor
    // runs, and a path would point into an instance that no longer exists
    return new File([toBlob(data, 'video/x-matroska')], 'animation.mkv', { type: 'video/x-matroska' });
  } finally {
    decoder.close();
    for (const name of names) await safeDelete(f, name);
    await safeDelete(f, 'webp_frames.txt');
  }
}

export async function decodeStillViaFFmpeg(file, report) {
  const f = await freshFFmpeg(s => report?.state?.(s));
  const inName = 'still_' + clean(file.name || 'input');
  await write(f, file, inName);
  try {
    await safeDelete(f, 'still.png');
    const code = await execChecked(f, ['-hide_banner', '-y', '-i', inName, '-frames:v', '1', 'still.png']);
    if (code !== 0) throw new Error('ffmpeg could not decode this image either');
    const data = await f.readFile('still.png');
    const blob = toBlob(data, 'image/png');
    await safeDelete(f, 'still.png');
    return new File([blob], 'decoded.png', { type: 'image/png' });
  } finally {
    await safeDelete(f, inName);
  }
}

/** rebuild an animation as a gif, trading size, frame rate and palette for bytes. */
export async function compressGif(file, targetBytes, opts, report) {
  const f = await freshFFmpeg(s => report?.state?.(s));
  const inName = 'in_' + clean(file.name || 'input');
  await write(f, file, inName);

  try {
    const info = await probe(f, inName);
    const srcW = info.width || 480;
    const srcFps = info.fps > 0 && info.fps < 120 ? info.fps : 15;

    // every combination of width, frame rate and palette, ranked by how good it
    // looks. width matters most, frame rate next, palette least.
    const rungs = [];
    for (const ws of [1, 0.85, 0.7, 0.6, 0.5, 0.42, 0.35, 0.3, 0.25, 0.2, 0.16, 0.12, 0.09, 0.07, 0.05]) {
      for (const fs of [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.22, 0.15]) {
        for (const colors of [256, 128, 64, 32, 16]) {
          const w = Math.max(8, Math.round(srcW * ws / 2) * 2);
          const fps = Math.max(2, Math.round(srcFps * fs));
          rungs.push({ w, fps, colors,
            score: ws * Math.pow(fs, 0.6) * Math.pow(colors / 256, 0.35) });
        }
      }
    }
    rungs.sort((x, y) => y.score - x.score);

    const build = async (rung, label) => {
      report?.step?.(label.i, label.n, rung.w + 'px, ' + rung.fps + ' fps, ' + rung.colors + ' colors');
      await safeDelete(f, 'out.gif');
      const vf = 'fps=' + rung.fps + ',scale=' + rung.w + ':-1:flags=lanczos,split[a][b];' +
        '[a]palettegen=max_colors=' + rung.colors + ':stats_mode=diff[p];' +
        '[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle';
      const code = await execChecked(f, ['-hide_banner', '-y', '-i', inName, '-vf', vf, '-loop', '0', 'out.gif']);
      if (code !== 0) throw new Error('ffmpeg could not build a gif from this file');
      const data = await f.readFile('out.gif');
      const size = data.length ?? data.byteLength;
      return { size, blob: toBlob(data, 'image/gif') };
    };

    // size falls as quality falls, so binary search the ranking for the best rung that fits.
    let lo = 0, hi = rungs.length - 1, best = null, smallest = null, step = 0;
    const STEPS = Math.ceil(Math.log2(rungs.length)) + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const out = await build(rungs[mid], { i: step++, n: STEPS });
      if (!smallest || out.size < smallest.size) smallest = out;
      if (out.size <= targetBytes) {
        best = { ...out, rung: rungs[mid] };
        hi = mid - 1;   // this fits, so reach for something better looking
      } else {
        lo = mid + 1;   // too big, accept a worse looking rung
      }
    }

    await safeDelete(f, 'out.gif');
    if (!best) {
      const err = new Error('even the smallest gif settings stay above that target');
      err.smallest = smallest;
      throw err;
    }
    return { blob: best.blob, size: best.size, container: 'gif',
             width: best.rung.w, fps: best.rung.fps, colors: best.rung.colors };
  } finally {
    await safeDelete(f, inName);
  }
}
