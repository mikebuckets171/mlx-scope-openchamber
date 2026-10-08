import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const TTL_MS = 15_000;
export const MAX_ENTRIES = 16;
export const DIRECTORY = join(homedir(), '.cache', 'mlx-scope', 'prompt-progress');
export const key = (kind, value) => createHash('sha256').update(`mlx-scope-${kind}-v1\0${value}`).digest('hex');

// Each process writes its own bounded snapshot. A crashed writer is harmless once
// its timestamps expire; other OpenCode processes never replace this file.
export function createStore({ directory = DIRECTORY, now = Date.now, warn = () => {}, intervalMs = 200 } = {}) {
  const writerID = randomUUID(), entries = new Map();
  const file = join(directory, `${writerID}.json`);
  let pending = Promise.resolve(), timer, closed = false, lastWrite = -Infinity, warned = false, writing = false, dirty = false;
  const prune = () => {
    const at = now();
    for (const [id, entry] of entries) if (entry.expiresAtMs <= at || entry.observedAtMs > at) entries.delete(id);
  };
  const failure = () => {
    if (!warned) { warned = true; warn('MLX Scope prompt progress is unavailable: local cache could not be written.'); }
  };
  const write = () => {
    clearTimeout(timer); timer = undefined;
    if (writing) { dirty = true; return pending; }
    writing = true; dirty = false;
    pending = pending.catch(() => {}).then(async () => {
      prune();
      if (closed || !entries.size) { await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); return; }
      // Check existing ancestors before creation so a symlink cannot redirect mkdir.
      const parents = [];
      for (let parent = directory; parent !== dirname(parent); parent = dirname(parent)) parents.push(parent);
      for (const parent of parents.reverse()) {
        const parentInfo = await lstat(parent).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (parentInfo && (parentInfo.isSymbolicLink() || !parentInfo.isDirectory())) throw new Error('Unsafe cache directory');
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (info.uid !== process.getuid?.()) throw new Error('Unsafe cache owner');
      await chmod(directory, 0o700);
      const at = now(), temp = join(directory, `.${writerID}-${randomUUID()}.tmp`);
      const body = JSON.stringify({ schemaVersion: 1, writerID, updatedAtMs: at, expiresAtMs: at + TTL_MS, entries: [...entries.values()] });
      let handle;
      try {
        handle = await open(temp, 'wx', 0o600);
        await handle.writeFile(body, 'utf8'); await handle.close(); handle = undefined;
        await rename(temp, file); lastWrite = now();
      } finally {
        await handle?.close().catch(() => {});
        await unlink(temp).catch(() => {});
      }
    }).catch(failure).finally(() => { writing = false; if (dirty && !closed) schedule(); });
    return pending;
  };
  const schedule = () => {
    dirty = true;
    if (closed || timer || writing) return;
    const delay = Math.max(0, intervalMs - (now() - lastWrite));
    if (!delay) { void write(); return; }
    timer = setTimeout(() => void write(), delay); timer.unref?.();
  };
  const reaper = setInterval(() => {
    const size = entries.size; prune();
    if (size !== entries.size) schedule();
  }, 1000); reaper.unref?.();
  return {
    writerID, file,
    update(entry) {
      if (closed) return;
      prune();
      if (!entries.has(entry.requestID) && entries.size >= MAX_ENTRIES) return;
      const at = now();
      entries.set(entry.requestID, { ...entry, observedAtMs: at, expiresAtMs: at + TTL_MS });
      schedule();
    },
    remove(requestID) { if (entries.delete(requestID)) schedule(); },
    snapshot() { prune(); return [...entries.values()]; },
    async flush() {
      while (writing) await pending;
      await write();
      while (writing || dirty || timer) { if (writing) await pending; else await write(); }
    },
    async close() {
      closed = true; clearInterval(reaper); clearTimeout(timer); entries.clear();
      while (writing) await pending;
      await write();
    },
  };
}
