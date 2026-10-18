import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { COMPANION_VERSION, PROTOCOL } from './chat.js';

export const CHAT_DIRECTORY = join(homedir(), '.cache', 'mlx-scope', 'chat-telemetry');
export const TTL_MS = 15_000;
export const HASH = /^[a-f0-9]{64}$/;
export async function privateDirectory(directory, create = false) {
  const parents = [];
  for (let parent = directory; parent !== dirname(parent); parent = dirname(parent)) parents.push(parent);
  for (const parent of parents.reverse()) {
    const info = await lstat(parent).catch(error => error.code === 'ENOENT' && create ? null : Promise.reject(error));
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error('Unsafe cache directory');
  }
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.uid !== process.getuid?.()) throw new Error('Unsafe cache owner');
  if (create) await chmod(directory, 0o700);
  else if ((info.mode & 0o077) !== 0) throw new Error('Unsafe cache permissions');
}
export async function atomicPrivateJSON(directory, file, value) {
  await privateDirectory(directory, true);
  const temp = join(directory, `.${randomUUID()}.tmp`); let handle;
  try {
    handle = await open(temp, 'wx', 0o600); await handle.writeFile(JSON.stringify(value));
    await handle.close(); handle = undefined; await rename(temp, join(directory, file));
  } finally { await handle?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}
/** `rejected` hears why an existing file was refused, so a caller can tell "not private" apart from "absent". */
export async function readPrivateJSON(directory, file, maxBytes = 16_384, rejected = () => {}) {
  await privateDirectory(directory);
  const handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    const reason = !info.isFile() ? 'type' : info.uid !== process.getuid?.() ? 'owner' : (info.mode & 0o077) !== 0 ? 'permissions' : info.size > maxBytes ? 'size' : null;
    if (reason) { rejected(reason); return null; }
    // A fixed-size read also bounds memory if another process replaces/grows the file concurrently.
    const buffer = Buffer.alloc(maxBytes + 1), result = await handle.read(buffer, 0, buffer.length, 0);
    return result.bytesRead > maxBytes ? null : JSON.parse(buffer.subarray(0, result.bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

export function createChatStore({ directory = CHAT_DIRECTORY, now = Date.now, warn = () => {}, intervalMs = 200, runtimeVersion = 'unknown' } = {}) {
  const writerID = randomUUID(), entries = new Map();
  let closed = false, timer, writing = Promise.resolve(), dirty = false, warned = false, lastWrite = -Infinity;
  const failure = () => { if (!warned) { warned = true; warn('MLX Scope chat telemetry is unavailable: local cache could not be written.'); } };
  const prune = () => { for (const [id, entry] of entries) if (entry.measurement.expiresAtMs <= now() || entry.measurement.observedAtMs > now()) entries.delete(id); };
  const write = () => {
    clearTimeout(timer); timer = undefined; dirty = false;
    writing = writing.then(async () => {
      prune();
      if (closed || entries.size === 0) { await unlink(join(directory, `${writerID}.json`)).catch(e => { if (e.code !== 'ENOENT') throw e; }); return; }
      const at = now();
      await atomicPrivateJSON(directory, `${writerID}.json`, { schemaVersion: 1, writerID,
        companionVersion: COMPANION_VERSION, protocol: PROTOCOL, runtimeVersion,
        updatedAtMs: at, expiresAtMs: at + TTL_MS, entries: [...entries.values()] }); lastWrite = now();
    }).catch(failure);
    return writing;
  };
  const schedule = () => {
    dirty = true; if (timer || closed) return;
    timer = setTimeout(() => void write(), Math.max(0, intervalMs - (now() - lastWrite))); timer.unref?.();
  };
  return {
    writerID, file: join(directory, `${writerID}.json`),
    update(value) {
      if (closed || !HASH.test(value.sessionKey) || !HASH.test(value.providerKey) || !HASH.test(value.modelKey) || !HASH.test(value.endpointKey)) return;
      if (value.destination !== undefined && value.destination !== 'remote') return;
      prune(); if (!entries.has(value.sessionKey) && entries.size >= 16) return;
      // Only allowlisted metadata enters the local transport, regardless of caller extensions.
      const m = value.measurement;
      const measurement = { scope: m.scope, basis: m.basis, timingBasis: m.timingBasis, phase: m.phase,
        tokensPerSecond: m.tokensPerSecond, observedAtMs: m.observedAtMs, expiresAtMs: m.expiresAtMs,
        observation: { startedAtMs: m.observation.startedAtMs, endedAtMs: m.observation.endedAtMs },
        freshness: m.freshness, calibrationSteps: m.calibrationSteps };
      entries.set(value.sessionKey, { sessionKey: value.sessionKey, providerKey: value.providerKey, modelKey: value.modelKey,
        endpointKey: value.endpointKey, ...value.destination === 'remote' ? { destination: 'remote' } : {}, measurement }); schedule();
    },
    remove(sessionKey) { if (entries.delete(sessionKey)) schedule(); },
    async flush() { if (dirty || timer) await write(); await writing; },
    async clear() { entries.clear(); await write(); },
    async close() { closed = true; clearTimeout(timer); entries.clear(); await write(); },
  };
}
