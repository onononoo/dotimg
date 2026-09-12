// Still-image compression: decode with the browser, then search for the highest
// quality re-encode that fits under a byte budget.

const LOSSY = new Set(['image/jpeg', 'image/webp', 'image/avif']);
const QUALITY_FLOOR = 0.62; // below this, shrinking the image beats adding artifacts
const MIN_SCALE = 0.002;

const supportCache = new Map();

export async function supportsEncode(mime) {
  if (supportCache.has(mime)) return supportCache.get(mime);
  const p = (async () => {
    try {
      const c = makeCanvas(8, 8);
      c.getContext('2d').fillRect(0, 0, 8, 8);
      const blob = await encode(c, mime, 0.5);
      return !!blob && blob.type === mime;
    } catch { return false; }
  })();
  supportCache.set(mime, p);
  return p;
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function encode(canvas, mime, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: mime, quality });
  return new Promise(res => canvas.toBlob(res, mime, quality));
}

/** Hand a canvas's pixels back now rather than waiting for the collector. A full frame
 *  is several megabytes and a search allocates a fresh one per attempt, which is enough
 *  memory to matter on a large picture. */
function release(canvas) {
  if (canvas) { canvas.width = 0; canvas.height = 0; }
}

/** Yield to the event loop between encodes so the page stays responsive.
 *  A message channel rather than a timer: browsers clamp setTimeout to one second
 *  in a background tab, which would stall a search behind a dozen idle seconds. */
const tick = () => new Promise(resolve => {
  if (typeof MessageChannel === 'undefined') return setTimeout(resolve, 0);
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
  ch.port2.postMessage(0);
});

/** Decode any still image the browser understands; falls back to <img> for SVG and oddities. */
export async function decodeImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    if (bmp.width && bmp.height) return bmp;
  } catch { /* fall through */ }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('this browser cannot decode ' + (file.type || 'that format')));
      img.src = url;
    });
    const w = img.naturalWidth || img.width || 1024;
    const h = img.naturalHeight || img.height || 1024;
    const c = makeCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.transferToImageBitmap ? c.transferToImageBitmap() : await createImageBitmap(c);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawScaled(bitmap, scale, mime) {
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (mime === 'image/jpeg') { // JPEG has no alpha, so composite on white rather than black
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  return c;
}

/**
 * Largest scale that fits under `targetBytes`, where `measure(canvas)` produces the
 * bytes. File size tracks pixel count, so each measurement predicts the next scale
 * directly; the fit and miss found so far bracket the search and end it early.
 * The measurement is a callback so formats the canvas cannot write, which go out to
 * FFmpeg instead, reuse this same search.
 */
async function findScale(bitmap, mime, targetBytes, measure, state, onStep) {
  const big = bitmap.width * bitmap.height > 160000;
  let scale = big ? 0.3 : 1;   // calibrate on a cheap probe before touching full resolution
  let lo = 0;                  // largest scale known to fit
  let hi = Infinity;           // smallest scale known to overshoot
  let best = null;

  for (let i = 0; i < 7; i++) {
    scale = Math.min(1, Math.max(MIN_SCALE, scale));
    const canvas = drawScaled(bitmap, scale, mime);
    onStep?.(Math.min(0.9, 0.2 + i * 0.11), `${canvas.width}×${canvas.height}`);

    const blob = await measure(canvas);
    state.attempts++;
    if (!state.smallest || blob.size < state.smallest.size) {
      state.smallest = { size: blob.size, blob, width: canvas.width, height: canvas.height };
    }

    if (blob.size <= targetBytes) {
      if (!best || scale > best.scale) {
        release(best?.canvas);        // the previous best is now dead weight
        best = { canvas, blob, scale };
      } else {
        release(canvas);
      }
      lo = Math.max(lo, scale);
      if (scale >= 1 || blob.size >= targetBytes * 0.75) break;
      let next = scale * Math.min(2.5, Math.sqrt(targetBytes * 0.93 / blob.size));
      if (hi < Infinity) next = Math.min(next, (scale + hi) / 2);
      if (next <= scale * 1.05) break;
      scale = next;
    } else {
      hi = Math.min(hi, scale);
      // Every format has a header floor; at one pixel there is nothing left to remove.
      const atFloor = canvas.width <= 1 && canvas.height <= 1;
      release(canvas);                // too big, so this frame is never coming back
      if (atFloor) break;
      let next = scale * Math.sqrt(targetBytes / blob.size) * 0.92;
      if (lo > 0) next = Math.max(next, (lo + scale) / 2);
      if (next < MIN_SCALE) break;
      scale = next;
    }

    if (lo > 0 && hi < Infinity && hi / lo < 1.06) break;
    await tick();
  }
  return best;
}

/**
 * Best encode of `bitmap` under `targetBytes`.
 * Returns { blob, width, height, quality, scale } or throws carrying the closest miss.
 */
export async function fitImage(bitmap, mime, targetBytes, onStep) {
  const lossy = LOSSY.has(mime);
  const state = { attempts: 0, smallest: null };

  if (!lossy) {
    const fit = await findScale(bitmap, mime, targetBytes,
      canvas => encode(canvas, mime), state, onStep);
    if (fit) {
      return { blob: fit.blob, width: fit.canvas.width, height: fit.canvas.height,
               quality: null, scale: fit.scale, attempts: state.attempts };
    }
    throw missed(state);
  }

  // Pass one: hold a decent quality floor and shrink the frame to fit.
  let fit = await findScale(bitmap, mime, targetBytes,
    canvas => encode(canvas, mime, QUALITY_FLOOR), state, onStep);
  let lowQuality = false;

  // Pass two: the target is brutal, so give up the floor and take what fits.
  if (!fit) {
    onStep?.(0.9, 'dropping quality');
    fit = await findScale(bitmap, mime, targetBytes,
      canvas => encode(canvas, mime, 0.02), state, onStep);
    lowQuality = true;
  }
  if (!fit) throw missed(state);

  const { canvas } = fit;
  const lowBound = lowQuality ? 0.02 : QUALITY_FLOOR;
  let best = fit.blob, bestQ = lowBound;

  // Spend whatever budget is left on quality at the chosen frame size.
  const top = await encode(canvas, mime, lowQuality ? QUALITY_FLOOR : 0.95);
  state.attempts++;
  if (top.size <= targetBytes) {
    best = top; bestQ = lowQuality ? QUALITY_FLOOR : 0.95;
  } else {
    let lo = lowBound, hi = lowQuality ? QUALITY_FLOOR : 0.95;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      const blob = await encode(canvas, mime, mid);
      state.attempts++;
      if (blob.size <= targetBytes) { best = blob; bestQ = mid; lo = mid; } else { hi = mid; }
      if (hi - lo < 0.02 || best.size >= targetBytes * 0.96) break;
      await tick();
    }
  }

  return { blob: best, width: canvas.width, height: canvas.height,
           quality: bestQ, scale: fit.scale, attempts: state.attempts };
}

/**
 * Fit a still format the canvas cannot write. The canvas produces a PNG at each
 * scale and `encodeBlob` turns it into the real format, so the same predictive
 * search applies. These formats have no quality dial, so scale is the only lever.
 */
export async function fitImageVia(bitmap, targetBytes, encodeBlob, onStep) {
  const state = { attempts: 0, smallest: null };
  const measure = async (canvas) => {
    const png = await encode(canvas, 'image/png');
    return encodeBlob(png, canvas);
  };

  const fit = await findScale(bitmap, 'image/png', targetBytes, measure, state, onStep);
  if (!fit) throw missed(state);
  return {
    blob: fit.blob,
    width: fit.canvas.width,
    height: fit.canvas.height,
    quality: null,
    scale: fit.scale,
    attempts: state.attempts,
  };
}

function missed(state) {
  const floor = state.smallest ? ' (floor is ' + state.smallest.size + ' bytes)' : '';
  const err = new Error('below the smallest file this format can produce' + floor);
  err.smallest = state.smallest;
  err.attempts = state.attempts;
  return err;
}

/** Try candidate formats and keep the one that preserves the most pixels. */
export async function compressImage(file, targetBytes, formatPref, onStep) {
  const bitmap = await decodeImage(file);
  let candidates;
  if (formatPref === 'auto') {
    candidates = [];
    if (await supportsEncode('image/avif')) candidates.push('image/avif');
    if (await supportsEncode('image/webp')) candidates.push('image/webp');
    candidates.push('image/jpeg');
    // Lossy formats carry a fixed header floor of several hundred bytes; PNG does not,
    // so it is the only way to reach genuinely tiny targets.
    if (targetBytes < 4096) candidates.push('image/png');
  } else {
    candidates = [formatPref];
    if (formatPref !== 'image/jpeg' && !(await supportsEncode(formatPref))) candidates = ['image/jpeg'];
  }

  let bestFit = null, lastErr = null;
  for (const mime of candidates) {
    try {
      const r = await fitImage(bitmap, mime, targetBytes, onStep);
      const q = r.quality ?? 1;
      const better = !bestFit || r.scale > bestFit.scale * 1.02 ||
        (r.scale >= bestFit.scale * 0.98 && q > (bestFit.quality ?? 1));
      if (better) bestFit = { ...r, mime };
      if (bestFit.scale >= 1 && (bestFit.quality ?? 1) >= 0.9) break;
    } catch (e) { lastErr = e; }
  }

  // Nothing fit: PNG has no header floor, so give it a last try before giving up.
  if (!bestFit && !candidates.includes('image/png')) {
    try {
      const r = await fitImage(bitmap, 'image/png', targetBytes, onStep);
      bestFit = { ...r, mime: 'image/png' };
    } catch (e) { lastErr = e; }
  }
  bitmapClose(bitmap);

  if (bestFit) return bestFit;
  throw lastErr || new Error('could not encode this image');
}

function bitmapClose(bitmap) { try { bitmap.close?.(); } catch {} }
