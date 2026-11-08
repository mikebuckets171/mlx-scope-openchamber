// Owner: svc-host. 5.5 Memory thief: the processes holding the most memory, from one `top -l 1 -o mem` read (`mem` is the
// physical footprint, Activity Monitor's figure; no admin rights). Names never reach a log; PIDs never leave this file.

export interface TopRow { pid: number; name: string; bytes: number }
export interface AppMemory { name: string; bytes: number }

const UNIT: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
const HEADER = /^\s*PID\s+COMMAND\s+MEM\s*$/;
// `top` marks a changed value with a trailing + or - between samples; one sample has none, but tolerate it.
const ROW = /^\s*(\d{1,7})\s+(\S(?:.{0,15}?\S)?)\s+(\d{1,6}(?:\.\d{1,3})?)([BKMGT])[+-]?\s*$/;

/** The rows under top's `PID COMMAND MEM` header; anything unparseable is skipped, a missing header yields none. */
export const parseTop = (output: string | null): TopRow[] => {
  if (!output) return [];
  const lines = output.split('\n'), start = lines.findIndex(line => HEADER.test(line));
  if (start < 0) return [];
  return lines.slice(start + 1).flatMap(line => {
    const match = ROW.exec(line);
    if (!match) return [];
    const pid = Number(match[1]), bytes = Math.round(Number(match[3]) * UNIT[match[4]!]!);
    return pid > 0 && Number.isSafeInteger(bytes) ? [{ pid, name: match[2]!, bytes }] : [];
  });
};

/** top cuts COMMAND to 16 characters: "OpenChamber Helper (Renderer)" arrives as "OpenChamber Help". */
const TOP_WIDTH = 16;
const HELPER = /^(.+?) (?:Helper\b.*|Helpe|Help|Hel|He|H)$/;
/** The app a process belongs to: a helper process counts toward its app; other names stay as top shows them. */
export const appName = (name: string): string => {
  const helper = name.includes(' Helper') || name.length >= TOP_WIDTH ? HELPER.exec(name) : null;
  return helper?.[1]?.trim() || name;
};

/** Not an app the user can act on: the engine being measured, and the kernel. */
const SKIP = new Set(['splash', 'kernel_task']);

/** Processes grouped by app, biggest first; the engine itself and the kernel left out. */
export const groupApps = (rows: readonly TopRow[], limit: number): AppMemory[] => {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (SKIP.has(row.name)) continue;
    const name = appName(row.name);
    totals.set(name, (totals.get(name) ?? 0) + row.bytes);
  }
  return [...totals].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, limit);
};
