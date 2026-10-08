import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { version as companionVersion } from '../package.json';
import { parseChatMeasurement, type ChatMeasurement } from '../src/contract/chat.ts';

const TTL = 15_000, MAX_BYTES = 65_536, HEX = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const object = (v: unknown): Record<string, any> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null;
export interface ChatTarget { sessionKey: string; providerKey: string; modelKey: string; endpointKey: string }
export interface CompanionProbe {
  companionVersion: string; protocol: string; runtimeVersion: string; supported: boolean;
  loadedAtMs: number; updatedAtMs?: number; expiresAtMs?: number;
}
/** Small, private transport. No timer and no runtime IO: a visible frame renews demand when it polls. */
export class ChatTelemetry {
  private readonly directory: string;
  private readonly frames = new Map<string, { target: ChatTarget; until: number }>();
  private queue: Promise<void> = Promise.resolve();
  private lastWrite = -Infinity;
  private signature = '';
  private readonly owner = randomUUID();
  constructor(home: string, private readonly now: () => number = Date.now) {
    this.directory = join(home, '.cache', 'mlx-scope', 'chat-telemetry');
  }
  private async safeDirectory(create = false): Promise<boolean> {
    // Refuse symlink ancestors before creating files. Missing children are safe to create beneath checked parents.
    const parents: string[] = [];
    for (let path = this.directory; path !== dirname(path); path = dirname(path)) parents.push(path);
    try {
      for (const path of parents.reverse()) {
        const info = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (info && (!info.isDirectory() || info.isSymbolicLink())) return false;
      }
      if (create) { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700); }
      const info = await lstat(this.directory);
      return info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
    } catch { return false; }
  }
  private async json(name: string): Promise<Record<string, any> | null> {
    let handle;
    try {
      handle = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return null;
      const bytes = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      return bytesRead > MAX_BYTES ? null : object(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
    } catch { return null; } finally { await handle?.close(); }
  }
  async probe(): Promise<CompanionProbe | null> {
    if (!await this.safeDirectory()) return null;
    const value = await this.json('heartbeat.json');
    if (!value || value.schemaVersion !== 1 || typeof value.companionVersion !== 'string'
      || typeof value.protocol !== 'string' || typeof value.runtimeVersion !== 'string' || typeof value.supported !== 'boolean'
      || !Number.isSafeInteger(value.loadedAtMs) || value.loadedAtMs > this.now()) return null;
    return { companionVersion: value.companionVersion.slice(0,32), protocol: value.protocol.slice(0,64), runtimeVersion: value.runtimeVersion.slice(0,32),
      supported: value.supported, loadedAtMs: value.loadedAtMs,
      ...Number.isSafeInteger(value.updatedAtMs) && value.updatedAtMs <= this.now() ? { updatedAtMs: value.updatedAtMs } : {},
      ...Number.isSafeInteger(value.expiresAtMs) ? { expiresAtMs: value.expiresAtMs } : {} };
  }
  async observe(frame: string, target: ChatTarget | null): Promise<ChatMeasurement | null> {
    const now = this.now();
    for (const [id, item] of this.frames) if (item.until <= now) this.frames.delete(id);
    if (target && Object.values(target).every(value => HEX.test(value))) {
      if (this.frames.has(frame) || this.frames.size < 16) this.frames.set(frame, { target, until: now + TTL });
    } else this.frames.delete(frame);
    // Do not create caches for users who have never enabled the companion. Its startup creates the directory.
    if (!await this.safeDirectory()) return null;
    const watched = [...new Map([...this.frames.values()].map(item => [JSON.stringify(item.target), item.target])).values()];
    const signature = JSON.stringify(watched);
    if (signature !== this.signature || watched.length && now - this.lastWrite >= 1_000) {
      this.signature = signature; this.lastWrite = now;
      const body = { schemaVersion: 1, owner: this.owner, updatedAtMs: now, expiresAtMs: now + TTL, watched };
      this.queue = this.queue.catch(() => {}).then(async () => {
        if (!await this.safeDirectory()) return;
        if (!watched.length) { await unlink(join(this.directory, 'demand.json')).catch(() => {}); return; }
        const temp = `.${this.owner}-${randomUUID()}.tmp`, path = join(this.directory, temp);
        let handle;
        try {
          handle = await open(path, 'wx', 0o600); await handle.writeFile(JSON.stringify(body)); await handle.close(); handle = undefined;
          await rename(path, join(this.directory, 'demand.json'));
        } finally { await handle?.close(); await unlink(path).catch(() => {}); }
      }).catch(() => {});
      await this.queue;
    }
    if (!target) return null;
    const found: ChatMeasurement[] = [];
    try {
      const directory = await opendir(this.directory);
      let scanned = 0, count = 0;
      for await (const file of directory) {
        if (++scanned > 256) return null;
        if (!file.isFile() || !file.name.endsWith('.json') || !UUID.test(file.name.slice(0,-5))) continue;
        const value = await this.json(file.name);
        const checkedAt = this.now();
        if (!value || value.schemaVersion !== 1 || value.companionVersion !== companionVersion || value.writerID !== file.name.slice(0,-5) || value.protocol !== 'opencode-2.0.25'
          || value.runtimeVersion !== '2.0.25' || !Number.isSafeInteger(value.updatedAtMs) || !Number.isSafeInteger(value.expiresAtMs)
          || value.updatedAtMs > checkedAt || value.expiresAtMs <= checkedAt || value.expiresAtMs - value.updatedAtMs > TTL
          || !Array.isArray(value.entries) || value.entries.length > 16) continue;
        if (++count > 16) return null;
        for (const raw of value.entries) {
          const entry = object(raw);
          if (!entry || Object.entries(target).some(([key,val]) => entry[key] !== val)) continue;
          const measurement = parseChatMeasurement(entry.measurement, checkedAt);
          if (measurement) found.push(measurement);
        }
      }
    } catch { return null; }
    // Multiple writers for the same target are ambiguous, never aggregate their rates.
    return found.length === 1 ? parseChatMeasurement(found[0], this.now()) : null;
  }
  async dispose(): Promise<void> {
    this.frames.clear(); await this.queue;
    if (await this.safeDirectory() && (await this.json('demand.json'))?.owner === this.owner)
      await unlink(join(this.directory, 'demand.json')).catch(() => {});
  }
}
