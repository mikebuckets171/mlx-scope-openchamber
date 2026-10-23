import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';

/** Never follow a telemetry-file symlink or block on FIFOs; cap bytes even during concurrent writes. */
export const readBounded = async (file: string, limit = 256_000, privateOnly = false): Promise<{ text: string; modifiedAtMs: number } | null> => {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit || privateOnly && ((info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid())) return null;
      const bytes = Buffer.alloc(info.size + 1), result = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
      if (result.bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) return null;
      return { text: bytes.subarray(0, result.bytesRead).toString('utf8'), modifiedAtMs: info.mtimeMs };
    } finally { await handle.close(); }
  } catch { return null; }
};
export const directoryExists = async (directory: string): Promise<boolean> => { try { return (await stat(directory)).isDirectory(); } catch { return false; } };
