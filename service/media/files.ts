import { constants } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';

/** Never follow a telemetry-file symlink or block on FIFOs; cap bytes even during concurrent writes. */
export const readBounded = async (file: string, limit = 256_000, privateOnly = false): Promise<{ text: string; modifiedAtMs: number } | null> => {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit || privateOnly && ((info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid())) return null;
      const bytes = Buffer.alloc(limit + 1), result = await handle.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > limit) return null;
      return { text: bytes.subarray(0, result.bytesRead).toString('utf8'), modifiedAtMs: info.mtimeMs };
    } finally { await handle.close(); }
  } catch { return null; }
};
export const directoryExists = async (directory: string): Promise<boolean> => { try { return (await stat(directory)).isDirectory(); } catch { return false; } };
/** Reading a finite directory prefix bounds work even if an external producer forgets retention. */
export const jsonFiles = async (directory: string, limit = 128): Promise<string[]> => {
  const names: string[] = [];
  try {
    const handle = await opendir(directory);
    let inspected = 0;
    try { for await (const entry of handle) { if (++inspected > limit) break; if (entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9_.:-]*\.json$/.test(entry.name)) names.push(entry.name); } }
    finally { try { await handle.close(); } catch { /* async iteration already closed it */ } }
  } catch { /* unavailable source */ }
  return names;
};
