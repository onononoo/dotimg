// archives, from the page's side.
//
// the real work happens in archive-worker.js, so a large archive never freezes the page. this
// file hands the job over, relays progress, and applies the rules that decide what the person
// gets back.

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./archive-worker.js', import.meta.url), { type: 'module' });

  worker.onmessage = (event) => {
    const { id, type } = event.data;
    const job = pending.get(id);
    if (!job) return;
    if (type === 'progress') {
      const { label, pct } = event.data;
      job.report?.step?.(0, 1, pct > 0 && pct < 100 ? label + ' ' + pct + '%' : label);
      return;
    }
    pending.delete(id);
    if (type === 'done') job.resolve(event.data.result);
    else job.reject(new Error(event.data.message));
  };

  // a crash inside the engine takes the worker with it. fail whatever was running, and let the
  // next job start a fresh one rather than talk to a dead worker.
  worker.onerror = (event) => {
    event.preventDefault?.();
    const message = 'the archive engine stopped unexpectedly' +
      (event.message ? ': ' + event.message.toLowerCase() : '') +
      '. very large archives can run out of memory in a browser tab.';
    for (const job of pending.values()) job.reject(new Error(message));
    pending.clear();
    try { worker.terminate(); } catch {}
    worker = null;
  };
  return worker;
}

function send(job, report) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, report });
    getWorker().postMessage({ id, job }, [job.buffer]);
  });
}

const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

/**
 * repack an archive as `to`. lossless, so this is one attempt: the result either fits the
 * target or is as small as that format gets.
 */
export async function compressArchive(file, targetBytes, from, to, base, report, innerName) {
  report?.step?.(0, 1, 'loading the archive engine');
  // a copy, so the original file stays usable. past a couple of gigabytes the browser cannot
  // hand over one buffer that large, which fails here on the page before the worker ever sees it
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Error('this archive is too large to handle inside a browser tab: it ran out of memory. ' +
      'archives up to 1 gb have been tested and work.');
  }
  const result = await send({
    buffer, from, to, base, innerName,
    name: file.name, lastModified: file.lastModified,
  }, report);

  const blob = new Blob([result.buffer], { type: result.mime });
  const detail = plural(result.files, 'file') +
    (result.folders ? ' in ' + plural(result.folders, 'folder') : '') + ', repacked as ' + to;

  // never hand back something worse than what came in. an archive already built by a stronger
  // tool can beat 7-zip's own output, and repacking it into the same format would only make it
  // bigger. the engine only runs a same-format job when the target is below the original's
  // size, so the original cannot fit either: say that plainly, and offer the original.
  if (from === to && blob.size >= file.size) {
    const err = new Error('this archive is already smaller than anything dotimg can repack it into as ' +
      to + ', so it cannot get under your target without losing something');
    err.smallest = { size: file.size, blob: file };
    throw err;
  }

  if (blob.size > targetBytes) {
    const err = new Error('this is as small as it can losslessly get, and it is still over your target');
    err.smallest = { size: blob.size, blob };
    throw err;
  }
  return { blob, ext: to, detail };
}
