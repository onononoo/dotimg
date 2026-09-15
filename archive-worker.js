// 7-zip, running in a background worker.
//
// 7-zip compiled to webassembly is synchronous: a 24 mb folder froze the whole page for four
// seconds when it ran on the main thread. here it can take as long as it needs while the page
// keeps updating. every job extracts the archive completely and packs it again, so nothing
// inside is ever altered: only the container around it changes.

import SevenZip from './vendor/archive/7zz.es6.js';

let engine = null;
let lines = [];
let onProgress = null;

async function load() {
  if (!engine) {
    engine = await SevenZip({
      print: (text) => capture(text),
      printErr: (text) => capture(text),
    });
  }
  return engine;
}

function capture(text) {
  lines.push(text);
  // 7-zip draws its progress as a percentage redrawn with backspaces
  const found = text.match(/(\d{1,3})%/g);
  if (found && onProgress) onProgress(Math.min(100, parseInt(found[found.length - 1], 10)));
}

/** run one 7-zip command and return its exit code and everything it printed. */
function run(args) {
  lines = [];
  let code;
  try {
    code = engine.callMain(args);
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 2;
    lines.push(String(e.message || e));
  }
  return { code, log: lines.join('\n') };
}

/* ---------- in-memory filesystem helpers ---------- */

function removeTree(path) {
  const FS = engine.FS;
  let stat;
  try { stat = FS.lstat(path); } catch { return; }
  if (FS.isDir(stat.mode)) {
    for (const name of FS.readdir(path)) {
      if (name !== '.' && name !== '..') removeTree(path + '/' + name);
    }
    FS.rmdir(path);
  } else {
    FS.unlink(path);
  }
}

function freshDir(path) {
  removeTree(path);
  engine.FS.mkdir(path);
}

/** every file and folder under a directory, as relative paths. */
function entriesUnder(root) {
  const FS = engine.FS;
  const files = [];
  const folders = [];
  const walk = (dir, rel) => {
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const full = dir + '/' + name;
      const path = rel ? rel + '/' + name : name;
      if (FS.isDir(FS.stat(full).mode)) { folders.push(path); walk(full, path); }
      else files.push(path);
    }
  };
  walk(root, '');
  return { files, folders };
}

/* ---------- what can go wrong, said plainly ---------- */

const TOO_BIG = 'this archive is too large to handle inside a browser tab: it ran out of memory. ' +
  'archives up to 1 gb have been tested and work.';

function isMemoryError(text) {
  return /can'?t allocate|cannot enlarge memory|out of memory|memory access out of bounds|allocation failed|array buffer allocation/i.test(text);
}

function explainFailure(log, stage) {
  if (isMemoryError(log)) return TOO_BIG;
  if (/encrypted archive|wrong password|data error in encrypted/i.test(log)) {
    return 'this archive is password protected, and dotimg does not open locked archives.';
  }
  if (/missing volume|unexpected end of (archive|data)|there are some data after the end/i.test(log)) {
    return 'this looks like one part of a split archive, or a download that did not finish. ' +
      'dotimg can only open a complete archive in a single file.';
  }
  if (/can ?not open the file as archive|is not archive/i.test(log)) {
    return 'this file does not open as an archive. it may be damaged, or not really the type its name says.';
  }
  const reason = (log.match(/ERROR:\s*([^\n]+)/i) || [])[1];
  return 'could not ' + stage + ' this archive' + (reason ? ': ' + reason.trim().toLowerCase() : '.');
}

/* ---------- the job ---------- */

const WRAPPER = { 'tar.gz': 'gzip', 'tar.bz2': 'bzip2', 'tar.xz': 'xz' };
const STREAM = { gz: 'gzip', bz2: 'bzip2', xz: 'xz' };
const MIME = {
  zip: 'application/zip', '7z': 'application/x-7z-compressed', tar: 'application/x-tar',
  'tar.gz': 'application/gzip', 'tar.bz2': 'application/x-bzip2', 'tar.xz': 'application/x-xz',
  gz: 'application/gzip', bz2: 'application/x-bzip2', xz: 'application/x-xz',
};

// how many names travel back to the page for the preview list.
const NAME_SAMPLE = 100;

/** a name 7-zip can write into its filesystem. slashes and the like would be read as folders. */
const safeName = (name) => (name || 'archive').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');

async function repack({ buffer, from, to, base, name, lastModified, innerName }, progress) {
  await load();
  const FS = engine.FS;
  freshDir('/job');
  FS.mkdir('/job/in');
  FS.mkdir('/job/x');
  FS.mkdir('/job/out');

  // the upload keeps its real name and date. bz2 and xz store neither, so unpacking one names the
  // file after the archive and dates it from the archive, exactly as bunzip2 and unxz do. naming
  // the upload anything else would rename and redate what is inside.
  const input = '/job/in/' + safeName(name);
  FS.writeFile(input, new Uint8Array(buffer));
  if (lastModified) FS.utime(input, lastModified, lastModified);

  // 1. refuse locked archives. an empty -p means 7-zip never waits for someone to type one
  progress('checking the archive', 0);
  const listing = run(['l', '-slt', '-p', '-bsp0', input]);
  if (listing.code !== 0) throw new Error(explainFailure(listing.log, 'open'));
  if (/^Encrypted = \+/m.test(listing.log)) {
    throw new Error('this archive is password protected, and dotimg does not open locked archives.');
  }

  // 2. extract everything
  progress('unpacking', 0);
  onProgress = (pct) => progress('unpacking', pct);
  const unpacked = run(['x', input, '-o/job/x', '-y', '-p', '-bsp1']);
  if (unpacked.code >= 2) throw new Error(explainFailure(unpacked.log, 'unpack'));

  // 3. a .tar.gz is a tar inside gzip, so the tar has to be opened as well
  let root = '/job/x';
  const outer = entriesUnder('/job/x');
  const isTarWrapper = from.startsWith('tar.');
  if (isTarWrapper && outer.files.length === 1 && outer.folders.length === 0 && /\.tar$/i.test(outer.files[0])) {
    FS.mkdir('/job/x2');
    progress('unpacking the tar inside', 0);
    onProgress = (pct) => progress('unpacking the tar inside', pct);
    const inner = run(['x', '/job/x/' + outer.files[0], '-o/job/x2', '-y', '-bsp1']);
    if (inner.code >= 2) throw new Error(explainFailure(inner.log, 'unpack'));
    root = '/job/x2';
  }

  const { files, folders } = entriesUnder(root);
  if (!files.length && !folders.length) throw new Error('this archive is empty, so there is nothing to repack.');

  // 4. pack it again, at maximum settings, from inside the content so paths stay relative
  FS.chdir(root);
  progress('packing as ' + to + ', which can take a while for a large archive', 0);
  onProgress = (pct) => progress('packing as ' + to, pct);
  const safeBase = (base || 'archive').replace(/[\\/:*?"<>|]/g, '_');
  let outPath;
  let packed;

  try {
    if (to === 'zip') {
      // plain deflate, because windows explorer and macos cannot open deflate64 or lzma zips.
      // -mcu=on writes names as flagged utf-8 so unicode names open everywhere.
      outPath = '/job/out/out.zip';
      packed = run(['a', '-tzip', '-mx9', '-mm=Deflate', '-mcu=on', '-bsp1', outPath, '*']);
    } else if (to === '7z') {
      outPath = '/job/out/out.7z';
      packed = run(['a', '-t7z', '-mx9', '-ms=on', '-bsp1', outPath, '*']); // solid: similar files share one dictionary
    } else if (to === 'tar') {
      outPath = '/job/out/out.tar';
      packed = run(['a', '-ttar', '-bsp1', outPath, '*']);
    } else if (WRAPPER[to]) {
      // the tar is named after the download, since gzip and friends remember the name they wrapped
      const tarPath = '/job/out/' + safeBase + '.tar';
      packed = run(['a', '-ttar', '-bsp1', tarPath, '*']);
      if (packed.code < 2) {
        outPath = '/job/out/out.' + to;
        FS.chdir('/job/out');
        packed = run(['a', '-t' + WRAPPER[to], '-mx9', '-bsp1', outPath, safeBase + '.tar']);
      }
    } else if (STREAM[to]) {
      if (files.length !== 1 || folders.length) {
        throw new Error(to + ' holds exactly one file, and this holds ' + files.length + '. choose zip or 7z instead.');
      }
      // gz stores the name of the file it wraps, and bz2 and xz take it from the download's name
      // when unpacked. naming the file to match the download keeps all three in agreement.
      let wrapped = files[0];
      if (innerName && safeName(innerName) !== files[0]) {
        wrapped = safeName(innerName);
        FS.rename(root + '/' + files[0], root + '/' + wrapped);
      }
      outPath = '/job/out/out.' + to;
      packed = run(['a', '-t' + STREAM[to], '-mx9', '-bsp1', outPath, wrapped]);
    } else {
      throw new Error('dotimg cannot write ' + to + ' archives.');
    }
  } finally {
    FS.chdir('/');
  }

  if (!packed || packed.code >= 2) throw new Error(explainFailure(packed ? packed.log : '', 'pack'));

  const bytes = FS.readFile(outPath);
  freshDir('/job'); // hand the memory back before the next file
  return {
    buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    mime: MIME[to] || 'application/octet-stream',
    files: files.length,
    folders: folders.length,
    // enough names for the page to show what is inside. an archive of a hundred thousand
    // files must not post a hundred thousand strings back to fill a preview box.
    names: files.slice(0, NAME_SAMPLE),
  };
}

self.onmessage = async (event) => {
  const { id, job } = event.data;
  const progress = (label, pct) => self.postMessage({ id, type: 'progress', label, pct });
  try {
    const result = await repack(job, progress);
    self.postMessage({ id, type: 'done', result }, [result.buffer]);
  } catch (err) {
    // a failed job must not keep its files in memory until the next one arrives
    try { if (engine) { engine.FS.chdir('/'); freshDir('/job'); } } catch {}
    const message = err.message || String(err);
    self.postMessage({ id, type: 'error', message: isMemoryError(message) ? TOO_BIG : message });
  } finally {
    onProgress = null;
  }
};
