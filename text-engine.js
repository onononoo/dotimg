// text, code and data.
//
// all of these are lossless: nothing can be dropped without changing what the file means,
// so each one has a floor, and the job is to reach it. every format with real syntax goes
// through an established minifier, because hand-rolled whitespace stripping breaks code in
// ways that only show up later. only the strict, simple formats are written by hand.

import { loadModule, loadScript } from './lib-loader.js';

const YAML = './vendor/text/js-yaml.mjs';
const PAPA = './vendor/text/papaparse.mjs';
const TERSER = './vendor/text/terser.umd.js';
const CSSO = './vendor/text/csso.mjs';
const HTMLMIN = './vendor/text/html-minifier.mjs';
const SVGO = './vendor/text/svgo.mjs';

const MIME = {
  json: 'application/json', yaml: 'application/yaml', csv: 'text/csv',
  tsv: 'text/tab-separated-values', srt: 'application/x-subrip', vtt: 'text/vtt',
  js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', html: 'text/html',
  xml: 'application/xml', txt: 'text/plain', md: 'text/markdown', svg: 'image/svg+xml',
};

const BOM = '\ufeff';

/**
 * read a file as utf-8, refusing anything that is not. decoding a latin-1 csv as utf-8
 * would quietly swap accented letters for replacement characters and then save that,
 * which is exactly the kind of damage a compressor must never do.
 */
async function readUtf8(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('this file is not utf-8 text. dotimg only rewrites utf-8, so that nothing ' +
      'in another encoding gets silently corrupted.');
  }
  if (hasBom) text = text.slice(1);
  return { text, hasBom };
}

/* ---------- data: json and yaml ---------- */

async function convertData(text, from, to) {
  const yaml = await loadModule(YAML);
  let docs;
  if (from === 'json') {
    try { docs = [JSON.parse(text)]; }
    catch (e) { throw new Error('this json does not parse: ' + e.message); }
  } else {
    try { docs = yaml.loadAll(text); }
    catch (e) { throw new Error('this yaml does not parse: ' + (e.reason || e.message)); }
  }

  if (to === 'json') {
    if (docs.length !== 1) {
      throw new Error('this yaml holds ' + docs.length + ' documents, and json can only hold one.');
    }
    return { text: JSON.stringify(docs[0]), notes: [] };
  }

  // yaml has two valid layouts for the same data. try both and keep whichever is smaller.
  const layouts = [
    (d) => yaml.dump(d, { lineWidth: -1, noRefs: true }),
    (d) => yaml.dump(d, { lineWidth: -1, noRefs: true, flowLevel: 0 }),
  ];
  let best = null;
  for (const layout of layouts) {
    const out = docs.map(layout).join('---\n');
    if (best === null || out.length < best.length) best = out;
  }
  const notes = [];
  if (from === 'yaml' && /^\s*#/m.test(text)) notes.push('yaml comments are not kept');
  return { text: best, notes };
}

/* ---------- table: csv and tsv ---------- */

async function convertTable(text, from, to) {
  const Papa = (await loadModule(PAPA)).default;
  const parsed = Papa.parse(text, {
    delimiter: from === 'tsv' ? '\t' : ',',
    skipEmptyLines: false,
    dynamicTyping: false, // keep every cell a string, so 007 stays 007
  });
  if (parsed.errors.some((e) => e.type === 'Quotes')) {
    throw new Error('this ' + from + ' has unbalanced quotes near row ' +
      (parsed.errors[0].row + 1) + ', so it cannot be rewritten safely.');
  }
  // drop only the trailing empty line a final newline creates, never an empty row in the data
  let rows = parsed.data;
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();

  const out = Papa.unparse(rows, {
    delimiter: to === 'tsv' ? '\t' : ',',
    newline: '\n',
    quotes: false, // quote only the cells that need it
  });
  // keep a final newline if there was one. it costs a byte, but without it, joining two
  // tables end to end glues the last row of one onto the header of the next.
  return { text: /\r?\n$/.test(text) ? out + '\n' : out, notes: [], rows };
}

/* ---------- subtitles: srt and vtt ---------- */

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/;

function toMs(stamp) {
  const m = stamp.match(TIME);
  if (!m) return null;
  return ((+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4]);
}

function fromMs(ms, style) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const t = ms % 1000;
  const p = (n, w) => String(n).padStart(w, '0');
  if (style === 'srt') return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(t, 3);
  // webvtt allows the hours to be left off when they are zero, saving three bytes a stamp
  return (h ? p(h, 2) + ':' : '') + p(m, 2) + ':' + p(s, 2) + '.' + p(t, 3);
}

export function parseSubtitles(text) {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  const header = []; // webvtt style and region blocks, which change how cues look
  for (const raw of blocks) {
    const lines = raw.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
    if (!lines.length || !lines.join('').trim()) continue;
    if (/^WEBVTT/.test(lines[0])) continue;
    if (/^NOTE(\s|$)/.test(lines[0])) continue; // notes are comments
    if (/^(STYLE|REGION)(\s|$)/.test(lines[0])) { header.push(lines.join('\n')); continue; }

    const timingAt = lines.findIndex((l) => l.includes('-->'));
    if (timingAt < 0) continue;
    const [left, right = ''] = lines[timingAt].split('-->');
    const start = toMs(left);
    const endMatch = right.trim().match(/^(\S+)(.*)$/);
    const end = endMatch ? toMs(endMatch[1]) : null;
    if (start === null || end === null) continue;
    cues.push({
      id: timingAt > 0 && !/^\d+$/.test(lines[0].trim()) ? lines.slice(0, timingAt).join(' ') : null,
      start, end,
      settings: endMatch ? endMatch[2].trim() : '',
      text: lines.slice(timingAt + 1).map((l) => l.replace(/\s+$/, '')).join('\n'),
    });
  }
  return { cues, header };
}

function convertSubtitles(text, from, to) {
  const { cues, header } = parseSubtitles(text);
  if (!cues.length) throw new Error('no subtitle cues were found in this file.');
  const notes = [];
  let out;
  if (to === 'srt') {
    out = cues.map((c, i) => (i + 1) + '\n' + fromMs(c.start, 'srt') + ' --> ' +
      fromMs(c.end, 'srt') + '\n' + c.text).join('\n\n') + '\n';
    if (cues.some((c) => c.settings)) notes.push('webvtt cue positioning is not kept, srt has none');
    if (header.length) notes.push('webvtt styling is not kept, srt has none');
  } else {
    const parts = ['WEBVTT', ...header];
    for (const c of cues) {
      parts.push((c.id ? c.id + '\n' : '') + fromMs(c.start, 'vtt') + ' --> ' +
        fromMs(c.end, 'vtt') + (c.settings ? ' ' + c.settings : '') + '\n' + c.text);
    }
    out = parts.join('\n\n') + '\n';
  }
  return { text: out, notes, cues };
}

/* ---------- code ---------- */

async function minifyJs(text, ext) {
  const Terser = await loadScript(TERSER, 'Terser');
  const looksLikeModule = ext === 'mjs' || /^\s*(import|export)\b/m.test(text);
  const result = await Terser.minify(text, {
    module: looksLikeModule,
    sourceMap: false,
    compress: true,
    mangle: true, // local names only: top-level names other scripts may rely on are kept
    // licence headers survive, since stripping them from someone's code is not ours to do
    format: { comments: /^!|@license|@preserve|@cc_on/i },
  }).catch((e) => { throw new Error('this javascript does not parse: ' + e.message); });
  return { text: result.code, notes: [] };
}

async function minifyCss(text) {
  const csso = await loadModule(CSSO);
  let out;
  try { out = csso.minify(text, { restructure: true, comments: 'exclamation' }).css; }
  catch (e) { throw new Error('this css does not parse: ' + e.message); }
  return { text: out, notes: [] };
}

async function minifyHtml(text) {
  const htmlmin = await loadModule(HTMLMIN);
  const out = await htmlmin.minify(text, {
    collapseWhitespace: true,
    conservativeCollapse: true, // keep one space where there was space, so inline text still reads
    removeComments: true,
    minifyCSS: true,
    minifyJS: true,
    useShortDoctype: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    collapseBooleanAttributes: true,
  });
  return { text: out, notes: [] };
}

/**
 * remove comments, and the indentation between elements. xml on its own cannot say which
 * whitespace matters, so this errs towards keeping it: only whitespace spanning a line
 * break is removed, since that is what indentation looks like. a same-line space is kept,
 * because in <p><b>a</b> <i>b</i></p> it is the gap between two words. mixed content
 * and xml:space="preserve" are left entirely alone.
 */
function minifyXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('this xml does not parse, so it cannot be rewritten safely.');
  }
  const walk = (node, preserve) => {
    const kids = [...node.childNodes];
    const mixed = kids.some((k) => k.nodeType === Node.TEXT_NODE && k.nodeValue.trim());
    for (const k of kids) {
      if (k.nodeType === Node.COMMENT_NODE) { k.remove(); continue; }
      const indentation = k.nodeType === Node.TEXT_NODE && !k.nodeValue.trim() && /[\r\n]/.test(k.nodeValue);
      if (indentation && !preserve && !mixed) { k.remove(); continue; }
      if (k.nodeType === Node.ELEMENT_NODE) {
        const space = k.getAttribute('xml:space');
        walk(k, space === 'preserve' ? true : space === 'default' ? false : preserve);
      }
    }
  };
  walk(doc, false);
  let out = new XMLSerializer().serializeToString(doc);
  const declaration = text.match(/^\s*(<\?xml[^?]*\?>)/);
  if (declaration && !out.startsWith('<?xml')) out = declaration[1] + out;
  return { text: out, notes: [] };
}

async function minifySvg(text) {
  const svgo = await loadModule(SVGO);
  let out;
  try { out = svgo.optimize(text, { multipass: true }).data; }
  catch (e) { throw new Error('this svg does not parse: ' + e.message); }
  return { text: out, notes: [] };
}

/**
 * prose has nothing to minify. the only safe savings are line endings and trailing
 * blank lines. in markdown, two spaces at the end of a line are a hard line break, so
 * line-end spaces there are left alone.
 */
function tidyText(text, ext) {
  const notes = [];
  let out = text;
  if (out.includes('\r\n')) { out = out.replace(/\r\n/g, '\n'); notes.push('line endings changed to lf'); }
  if (ext !== 'md') out = out.replace(/[ \t]+$/gm, '');
  const hadFinalNewline = out.endsWith('\n');
  out = out.replace(/\n+$/, '') + (hadFinalNewline ? '\n' : '');
  return { text: out, notes };
}

/* ---------- entry point ---------- */

/** every text format this engine can write, and which input formats each accepts. */
export const TEXT_FORMATS = {
  json: ['json', 'yaml'], yaml: ['json', 'yaml'],
  csv: ['csv', 'tsv'], tsv: ['csv', 'tsv'],
  srt: ['srt', 'vtt'], vtt: ['srt', 'vtt'],
  js: ['js'], mjs: ['mjs'], css: ['css'], html: ['html'], xml: ['xml'],
  txt: ['txt'], md: ['md'], svg: ['svg'],
};

async function transform(text, from, to) {
  if (from === 'json' || from === 'yaml') return convertData(text, from, to);
  if (from === 'csv' || from === 'tsv') return convertTable(text, from, to);
  if (from === 'srt' || from === 'vtt') return convertSubtitles(text, from, to);
  if (from === 'js' || from === 'mjs') return minifyJs(text, from);
  if (from === 'css') return minifyCss(text);
  if (from === 'html') return minifyHtml(text);
  if (from === 'xml') return minifyXml(text);
  if (from === 'svg') return minifySvg(text);
  return tidyText(text, from);
}

/**
 * rewrite a text file into `to`, as small as it losslessly gets. there is nothing to trade
 * for size, so this is one attempt, not a search: if the result is still over the target,
 * that is the floor, and the caller is told so with the smallest file attached.
 */
export async function compressText(file, targetBytes, from, to, report) {
  if (!(TEXT_FORMATS[from] || []).includes(to)) {
    throw new Error(from + ' cannot be turned into ' + to + '.');
  }
  report?.step?.(0, 2, 'reading');
  const { text, hasBom } = await readUtf8(file);

  report?.step?.(1, 2, from === to ? 'minifying' : 'converting to ' + to);
  const result = await transform(text, from, to);

  // a byte order mark tells some programs, excel above all, that the file is utf-8.
  // it costs three bytes, so it is kept exactly when the original had one.
  const body = (hasBom ? BOM : '') + result.text;
  const blob = new Blob([body], { type: MIME[to] || 'text/plain' });

  const detail = (from === to ? 'minified' : 'converted to ' + to) +
    (result.notes.length ? ' (' + result.notes.join(', ') + ')' : '');

  if (blob.size > targetBytes) {
    const err = new Error('this is as small as it can losslessly get, and it is still over your target');
    err.smallest = { size: blob.size, blob };
    throw err;
  }
  return { blob, ext: to, detail };
}
