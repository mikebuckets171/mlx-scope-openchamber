import { expect, test } from 'bun:test';
import { FakeRing, T0 } from '../testing/completions.ts';
import { createFakeStorage } from '../testing/storage.ts';
import { HEADROOM_BYTES, LEDGER_CAP_BYTES, STORAGE_LIMITS } from './accounting.ts';
import { HIDE_FLUSH_GAP_MS, Ledger, type FlushReason } from './ledger.ts';
import { CHUNK_KEY, CHUNK_MAX_CHARS, CHUNK_TARGET_CHARS, KEYS, parseChunk, verdictAttr, type ReplyRow } from './ledger-schema.ts';

/** mulberry32: a seeded, repeatable stream. */
const random = (seed: number) => () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4_294_967_296; };
const MODELS = ['Example-27B-4bit', 'Example-35B-A3B-4bit', 'Example-8B-8bit'];

test('20k-row simulation: 45 days of bursts, handovers and restarts stay inside every host limit with exact accounting', async () => {
  const next = random(20_260_929);
  const other: Record<string, unknown> = { 'view.compact': true, 'connection.selection': 'lmstudio',
    [KEYS.pref]: { v: 2, history: true, retentionDays: 30, toasts: 'critical', autoLabel: true, tipDismissed: false, noticeDismissed: false } };
  for (let index = 0; index < 12; index++) other[`capture.v2.${index.toString(36)}.c0de`] = { v: 2, savedAt: T0, kind: 'window', runtime: 'omlx', label: 'server-wide',
    measurements: Object.fromEntries(Array.from({ length: 40 }, (_, key) => [`k${key}Ms`, key * 1_000])), state: 'finished' };
  const storage = createFakeStorage({ initial: other });
  const clock = { now: T0 }, now = () => clock.now;
  const sources = [{ connection: 'lmstudio', rt: 'lmstudio' as const }, { connection: 'omlx', rt: 'omlx' as const }];
  let rings = [new FakeRing('0a0b0c0d'), new FakeRing('1a1b1c1d')];
  let ledger = new Ledger({ storage, now });
  await ledger.start();
  const produced = new Map<string, number>();   // id → finishedAt
  let completions = 0, handovers = 0, restarts = 0, flushes = 0, idleSets = 0;
  const flush = async (reason: FlushReason) => {
    const before = storage.stats();
    await ledger.flush(reason);
    const after = storage.stats(), sets = after.setKeys.slice(before.setKeys.length);
    if (!sets.length) return;
    flushes += 1;
    expect(ledger.state === 'idle' || ledger.state === 'paused').toBe(true);
    // One chunk set per flush; the dictionary only when it changed; baselines at most every 10 min.
    expect(sets.filter(key => CHUNK_KEY.test(key))).toHaveLength(1);
    expect(sets.filter(key => key !== KEYS.models && key !== KEYS.baseline && !CHUNK_KEY.test(key))).toEqual([]);
    const view = ledger.accounting()!;
    expect(view.totalBytes).toBe(after.fileBytes);
    expect(view.ledgerBytes).toBeLessThanOrEqual(LEDGER_CAP_BYTES);
    expect(view.totalBytes).toBeLessThanOrEqual(STORAGE_LIMITS.totalBytes - HEADROOM_BYTES);
    expect(after.entries).toBeLessThan(STORAGE_LIMITS.keys);
  };
  const poll = async (index: number) => {
    const ring = rings[index]!, source = sources[index]!;
    ledger.append(ring.response(ledger.since(source.connection)), verdictAttr, source);
    for (const reason of ['rows', 'timer'] as const) if (ledger.due(reason, clock.now)) { await flush(reason); break; }
  };
  for (let day = 0; day < 45; day++) {
    // Overnight: the view closes (hide flush), then polls keep coming for an hour with nothing new, and nothing is written.
    clock.now += HIDE_FLUSH_GAP_MS;
    if (ledger.due('hidden', clock.now)) await flush('hidden');
    const quiet = storage.stats().sets;
    for (let tick = 0; tick < 60; tick++) { clock.now += 60_000; await poll(tick % 2); }
    idleSets += storage.stats().sets - quiet;
    for (let burst = 0; burst < 12; burst++) {
      clock.now += Math.floor(next() * 3_600_000);
      if (next() < 0.08) {
        // Leader handover, sometimes without the old leader's hide flush (lease lost): the ring holds its rows.
        if (next() < 0.5 && ledger.due('hidden', clock.now)) await flush('hidden');
        ledger.dispose();
        ledger = new Ledger({ storage, now });
        await ledger.start();
        handovers += 1;
      }
      if (next() < 0.03) { rings = rings.map((ring, index) => index === 0 ? new FakeRing(`${(restarts + 2).toString(16).padStart(8, '0')}`) : ring); restarts += 1; }
      const size = 20 + Math.floor(next() * 40);
      for (let reply = 0; reply < size; reply++) {
        clock.now += 2_000 + Math.floor(next() * 20_000);
        const index = next() < 0.7 ? 0 : 1, ring = rings[index]!, model = MODELS[Math.floor(next() * MODELS.length)]!;
        const item = ring.add(clock.now, { model, basis: index === 0 ? 'reported' : 'last-observed', overlapped: next() < 0.1,
          ...next() < 0.3 ? { verdict: next() < 0.5 ? { attr: 'inferred', at: clock.now } : { attr: 'withheld', reason: 'outside-turn', at: clock.now } } : {} });
        produced.set(`${ring.instance}.${item.seq}`, item.finishedAt);
        completions += 1;
        if (reply % 2 === 0) await poll(index);
      }
      await poll(0); await poll(1);
      if (next() < 0.3 && ledger.due('hidden', clock.now)) await flush('hidden');
    }
  }
  await poll(0); await poll(1);
  clock.now += 10_000;
  if (ledger.due('hidden', clock.now)) await flush('hidden');

  expect(completions).toBeGreaterThan(20_000);
  expect(handovers).toBeGreaterThan(20);
  expect(restarts).toBeGreaterThan(5);
  expect(idleSets).toBe(0);
  const dump = storage.dump(), chunkValues = Object.entries(dump).filter(([key]) => CHUNK_KEY.test(key));
  for (const [, value] of chunkValues) expect(JSON.stringify(value).length).toBeLessThan(CHUNK_MAX_CHARS);
  expect(Math.max(...chunkValues.map(([, value]) => JSON.stringify(value).length))).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
  // No reply is stored twice, even across handovers and adopted chunks.
  const rows = chunkValues.flatMap(([, value]) => parseChunk(value)!.r);
  const replies = rows.filter((row): row is ReplyRow => row[0] === 'r'), stored = replies.map(row => row[17]);
  expect(new Set(stored).size).toBe(stored.length);
  // Everything after the oldest stored reply is present, except what a restart's gap row covers (the ring lost it).
  const oldest = Math.min(...replies.map(row => row[1])), gaps = rows.filter(row => row[0] === 'g');
  const inGap = (atS: number) => gaps.some(gap => atS >= gap[1] && atS <= gap[2]);
  const missing = [...produced].filter(([id, at]) => at / 1000 > oldest + 1 && !stored.includes(id) && !inGap(Math.floor(at / 1000)));
  expect(missing).toEqual([]);
  expect(ledger.accounting()!.totalBytes).toBe(storage.stats().fileBytes);
  // The other extensions' keys were never touched.
  for (const [key, value] of Object.entries(other)) expect(dump[key]).toEqual(value);
  const models = dump[KEYS.models] as string[];
  expect(new Set(models).size).toBe(models.length);
  expect(flushes).toBeGreaterThan(300);
  // The cap, not retention, bounded this run: eviction by size happened and kept the newest days.
  expect(storage.stats().deletes).toBeGreaterThan(10);
  expect(ledger.accounting()!.ledgerBytes).toBeGreaterThan(LEDGER_CAP_BYTES - 2 * CHUNK_TARGET_CHARS);
}, 120_000);
