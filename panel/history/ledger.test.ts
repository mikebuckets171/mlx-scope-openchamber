import { expect, test } from 'bun:test';
import { classAKeys } from '../../src/contract/guards.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { FakeRing, INSTANCE, T0 } from '../testing/completions.ts';
import { createFakeStorage, type FakeStorage } from '../testing/storage.ts';
import { HEADROOM_BYTES, LEDGER_CAP_BYTES, STORAGE_LIMITS } from './accounting.ts';
import { FLUSH_EVERY_MS, FLUSH_ROWS, HIDE_FLUSH_GAP_MS, Ledger, LedgerRecorder, VERDICT_HOLD_MS, type LedgerSource } from './ledger.ts';
import { CHUNK_KEY, CHUNK_MAX_CHARS, KEYS, parseChunk, verdictAttr, type ReplyRow } from './ledger-schema.ts';

const SOURCE: LedgerSource = { connection: 'lmstudio', rt: 'lmstudio' };
const clock = (start = T0) => { const state = { now: start }; return { state, now: () => state.now }; };
const setup = (storage: FakeStorage = createFakeStorage(), start = T0) => {
  const time = clock(start), ledger = new Ledger({ storage, now: time.now });
  return { storage, time, ledger };
};
/** One leader poll: the ledger's own `since`, then append. */
const poll = (ledger: Ledger, ring: FakeRing, source = SOURCE) => ledger.append(ring.response(ledger.since(source.connection)), verdictAttr, source);
const chunks = (storage: FakeStorage) => Object.entries(storage.dump()).filter(([key]) => CHUNK_KEY.test(key));
const storedReplies = (storage: FakeStorage): ReplyRow[] =>
  chunks(storage).flatMap(([, value]) => parseChunk(value)!.r).filter((row): row is ReplyRow => row[0] === 'r');
const ids = (storage: FakeStorage) => storedReplies(storage).map(row => row[17]).sort();

test('zero writes while idle: a start, hours of empty polls and a leader handover write nothing', async () => {
  const { storage, time, ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  expect(ledger.state).toBe('idle');
  expect(ledger.firstRun).toBe(true);
  for (let minute = 0; minute < 600; minute++) {
    time.state.now += 60_000;
    poll(ledger, ring);
    for (const reason of ['rows', 'timer', 'completed', 'hidden'] as const) expect(ledger.due(reason, time.state.now)).toBe(false);
  }
  await ledger.flush('hidden');
  expect(storage.stats().sets + storage.stats().deletes).toBe(0);
  // With history on disk, too: a new leader reads everything and writes nothing.
  ring.add(time.state.now);
  poll(ledger, ring);
  await ledger.flush('hidden');
  const before = storage.stats();
  ledger.dispose();
  const next = new Ledger({ storage, now: time.now });
  await next.start();
  for (let poll = 0; poll < 100; poll++) { time.state.now += 5_000; next.append(ring.response(next.since('lmstudio')), verdictAttr, SOURCE); }
  for (const reason of ['rows', 'timer', 'hidden'] as const) if (next.due(reason, time.state.now)) await next.flush(reason);
  expect(storage.stats().sets).toBe(before.sets);
  expect(storage.stats().deletes).toBe(before.deletes);
  expect(next.firstRun).toBe(false);
});

test('privacy: stored rows carry no class-A key or value; the dictionary keeps model names only, never paths', async () => {
  const { storage, ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  ring.add(T0 + 1_000, { model: '/Users/someone/models/Example-27B-4bit' });
  ring.add(T0 + 2_000, { model: '~/private/Example-8B-8bit', verdict: { attr: 'withheld', reason: 'overlap', at: T0 } });
  poll(ledger, ring);
  ledger.appendTurn(['t', 1_790_690_700, 1_790_690_702, 'lmstudio', 0, 2, 1_800, 510, 380, 1_000, 'inferred', 0]);
  await ledger.flush('hidden');
  const dump = storage.dump();
  expect(classAKeys(dump)).toEqual([]);
  expect(JSON.stringify(dump)).not.toMatch(/Users|someone|private|~/);
  expect(dump[KEYS.models]).toEqual(['Example-27B-4bit', 'Example-8B-8bit']);
  // Model names live only in the dictionary; rows hold refs.
  for (const [, value] of chunks(storage)) expect(JSON.stringify(value)).not.toContain('Example');
});

test('flush policy: at most every 5 min, at 50 rows, on hide ≥ 10 s apart; one set per flush plus the dictionary only when it changes', async () => {
  const { storage, time, ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  ring.add(T0 + 1_000);
  poll(ledger, ring);
  expect(ledger.due('timer', T0 + FLUSH_EVERY_MS - 1)).toBe(false);
  expect(ledger.due('completed', T0 + FLUSH_EVERY_MS - 1)).toBe(false);
  expect(ledger.due('rows', T0 + FLUSH_EVERY_MS)).toBe(false);
  expect(ledger.due('timer', T0 + FLUSH_EVERY_MS)).toBe(true);
  time.state.now = T0 + FLUSH_EVERY_MS;
  await ledger.flush('timer');
  expect(storage.stats().setKeys).toEqual([KEYS.models, expect.stringMatching(CHUNK_KEY)]);
  // Same model: one set per flush from now on.
  for (let index = 0; index < FLUSH_ROWS - 1; index++) ring.add(time.state.now + index);
  poll(ledger, ring);
  expect(ledger.due('rows', time.state.now)).toBe(false);
  ring.add(time.state.now + 60);
  poll(ledger, ring);
  expect(ledger.due('rows', time.state.now)).toBe(true);
  await ledger.flush('rows');
  expect(storage.stats().sets).toBe(3);
  // Hide: flushes at once, then not again within 10 s.
  ring.add(time.state.now + 100);
  poll(ledger, ring);
  expect(ledger.due('hidden', time.state.now)).toBe(true);
  await ledger.flush('hidden');
  expect(storage.stats().sets).toBe(4);
  ring.add(time.state.now + 200);
  poll(ledger, ring);
  expect(ledger.due('hidden', time.state.now + HIDE_FLUSH_GAP_MS - 1)).toBe(false);
  expect(ledger.due('hidden', time.state.now + HIDE_FLUSH_GAP_MS)).toBe(true);
  // A new model name: the dictionary is written once more, before the chunk.
  ring.add(time.state.now + 300, { model: 'Example-35B-A3B-4bit' });
  poll(ledger, ring);
  time.state.now += HIDE_FLUSH_GAP_MS;
  await ledger.flush('hidden');
  expect(storage.stats().setKeys.slice(-2)).toEqual([KEYS.models, expect.stringMatching(CHUNK_KEY)]);
  expect(storage.dump()[KEYS.models]).toEqual(['Example-27B-4bit', 'Example-35B-A3B-4bit']);
  expect(ids(storage)).toHaveLength(ring.seq);
  expect(ledger.firstRun).toBe(false);
});

test('idempotent replay: re-delivered completions never duplicate a row, before or after a flush', async () => {
  const { storage, ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  for (let index = 0; index < 5; index++) ring.add(T0 + index * 1_000);
  for (let replay = 0; replay < 3; replay++) ledger.append(ring.response(), verdictAttr, SOURCE);
  expect(ledger.pendingRows).toBe(5);
  await ledger.flush('hidden');
  ledger.append(ring.response(), verdictAttr, SOURCE);
  ledger.append(ring.response(0), verdictAttr, SOURCE);
  expect(ledger.pendingRows).toBe(0);
  expect(ids(storage)).toEqual([1, 2, 3, 4, 5].map(seq => `${INSTANCE}.${seq}`).sort());
});

test('handover with pending rows: the next leader re-reads them from the ring through the persisted cursor', async () => {
  const storage = createFakeStorage(), time = clock(), ring = new FakeRing();
  const a = new Ledger({ storage, now: time.now });
  await a.start();
  for (let index = 0; index < 8; index++) ring.add(T0 + index * 1_000);
  poll(a, ring);
  time.state.now += FLUSH_EVERY_MS;
  await a.flush('timer');
  for (let index = 8; index < 20; index++) ring.add(time.state.now + index * 1_000);
  poll(a, ring);
  expect(a.pendingRows).toBe(12);
  a.dispose();                               // lease lost: no flush, pending dropped
  time.state.now += 13_000;
  const b = new Ledger({ storage, now: time.now });
  await b.start();
  expect(b.since('lmstudio')).toBe(8);
  poll(b, ring);
  expect(b.pendingRows).toBe(12);
  await b.flush('hidden');
  expect(ids(storage)).toEqual(Array.from({ length: 20 }, (_, index) => `${INSTANCE}.${index + 1}`).sort());
  // B adopted A's small chunk instead of starting a second one.
  expect(chunks(storage)).toHaveLength(1);
});

test('an adopted chunk is re-read before its first rewrite, so the old leader\'s last flush survives', async () => {
  const storage = createFakeStorage(), time = clock(), ring = new FakeRing();
  const a = new Ledger({ storage, now: time.now }), b = new Ledger({ storage, now: time.now });
  await a.start();
  for (let index = 0; index < 5; index++) ring.add(T0 + index * 1_000);
  poll(a, ring);
  await a.flush('hidden');
  await b.start();                           // reads the chunk with rows 1–5
  for (let index = 5; index < 8; index++) ring.add(T0 + index * 1_000);
  poll(a, ring);
  a.appendTurn(['t', 1_790_690_700, 1_790_690_707, 'lmstudio', 0, 2, 1_800, 510, 380, 1_000, 'inferred', 0]);
  time.state.now += HIDE_FLUSH_GAP_MS;
  await a.flush('hidden');                   // the old leader's last write: rows 6–8 and a turn
  for (let index = 8; index < 10; index++) ring.add(T0 + index * 1_000);
  poll(b, ring);
  await b.flush('hidden');
  expect(ids(storage)).toEqual(Array.from({ length: 10 }, (_, index) => `${INSTANCE}.${index + 1}`).sort());
  expect(chunks(storage).flatMap(([, value]) => parseChunk(value)!.r).filter(row => row[0] === 't')).toHaveLength(1);
});

test('a service restart re-reads the new ring from its start and records a gap; an overflowed ring records one too', async () => {
  const { storage, time, ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  ring.add(T0 + 1_000);
  poll(ledger, ring);
  const restarted = new FakeRing('9e3779b9');
  restarted.add(T0 + 60_000); restarted.add(T0 + 61_000); restarted.add(T0 + 62_000);
  time.state.now = T0 + 70_000;
  ledger.append(restarted.response(2), verdictAttr, SOURCE);   // a cursor from the old instance
  expect(ledger.pendingRows).toBe(1);
  expect(ledger.since('lmstudio')).toBe(0);
  poll(ledger, restarted);
  const rows = await ledger.read();
  expect(rows.map(row => row[0])).toEqual(['r', 'g', 'r', 'r', 'r']);
  expect(rows[1]).toEqual(['g', 1_790_690_701, 1_790_690_760]);
  // Overflow: the ring dropped completions past the cursor.
  const small = new FakeRing(INSTANCE, 4), fresh = setup(storage, T0);
  await fresh.ledger.start();
  fresh.ledger.dispose();
  const overflow = new Ledger({ storage: createFakeStorage(), now: time.now });
  await overflow.start();
  small.add(T0 + 1_000);
  poll(overflow, small);
  for (let index = 0; index < 10; index++) small.add(T0 + 10_000 + index * 1_000);
  poll(overflow, small);
  const kinds = (await overflow.read()).map(row => row[0]);
  expect(kinds).toEqual(['r', 'g', 'r', 'r', 'r', 'r']);
});

test('verdicts from another frame still reach the row: since is held back 30 s and a re-delivery relabels', async () => {
  const { storage, time, ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  ring.add(T0 + 1_000); ring.add(T0 + 2_000);
  time.state.now = T0 + 3_000;
  poll(ledger, ring);
  expect(ledger.since('lmstudio', T0 + 3_000)).toBe(0);
  ring.verdict(2, { attr: 'armed', at: T0 + 2_500 });
  poll(ledger, ring);
  await ledger.flush('hidden');
  expect(storedReplies(storage).map(row => row[13])).toEqual(['not-observed', 'armed']);
  // Already stored in the open chunk: the relabel rides the next flush.
  ring.verdict(1, { attr: 'withheld', reason: 'outside-turn', at: T0 + 4_000 });
  poll(ledger, ring);
  expect(ledger.due('hidden', time.state.now + HIDE_FLUSH_GAP_MS)).toBe(true);
  time.state.now += HIDE_FLUSH_GAP_MS;
  await ledger.flush('hidden');
  expect(storedReplies(storage).map(row => row[13])).toEqual(['withheld:outside-turn', 'armed']);
  expect(ledger.since('lmstudio', T0 + 2_000 + VERDICT_HOLD_MS + 1)).toBe(2);
});

test('HOST_REJECTED: probe meta.v2; back off and retry when it reads, stop quietly when it does not; never evict on an error', async () => {
  let rejectSets = false, rejectAll = false;
  const storage = createFakeStorage({ reject: op => rejectAll || rejectSets && op !== 'get' && op !== 'keys' });
  const { time, ledger } = setup(storage), ring = new FakeRing();
  await ledger.start();
  for (let index = 0; index < 60; index++) ring.add(T0 + index * 1_000);
  poll(ledger, ring);
  rejectSets = true;
  await ledger.flush('rows');
  expect(ledger.state).toBe('backoff');
  expect(ledger.pendingRows).toBe(60);
  expect(ledger.due('rows', time.state.now + 29_999)).toBe(false);
  expect(ledger.due('rows', time.state.now + 30_000)).toBe(true);
  expect(storage.stats().deletes).toBe(0);
  rejectSets = false;
  time.state.now += 30_000;
  await ledger.flush('rows');
  expect(ledger.state).toBe('idle');
  expect(ids(storage)).toHaveLength(60);
  // Not approved or disabled: every call fails, the probe too.
  ring.add(time.state.now);
  poll(ledger, ring);
  rejectAll = true;
  const before = storage.stats();
  await ledger.flush('hidden');
  expect(ledger.state).toBe('stopped');
  expect(ledger.due('hidden', time.state.now + 60_000)).toBe(false);
  rejectAll = false;
  await ledger.flush('hidden');
  expect(storage.stats().sets).toBe(before.sets);
  expect(storage.stats().deletes).toBe(0);
});

test('eviction runs only after a flush: expired chunks first, then the oldest, keeping ≥ 128 KiB free and the ledger under its cap', async () => {
  const storage = createFakeStorage(), { time, ledger } = setup(storage), ring = new FakeRing();
  await ledger.start();
  // 40 days of history, one flush a day.
  for (let day = 0; day < 40; day++) {
    time.state.now = T0 + day * 86_400_000;
    for (let index = 0; index < 30; index++) ring.add(time.state.now - 60_000 + index * 1_000);
    poll(ledger, ring);
    await ledger.flush('hidden');
  }
  const oldest = Math.min(...storedReplies(storage).map(row => row[1]));
  expect(oldest).toBeGreaterThanOrEqual(Math.floor(time.state.now / 1000) - 32 * 86_400);
  expect(chunks(storage).length).toBeLessThanOrEqual(32);
  // Idle for 10 more days: nothing is deleted without a flush.
  const deletes = storage.stats().deletes;
  time.state.now += 10 * 86_400_000;
  for (let index = 0; index < 20; index++) poll(ledger, ring);
  expect(storage.stats().deletes).toBe(deletes);
  // Someone else fills the namespace: the next flush makes room from the oldest chunks.
  for (let index = 0; index < 12; index++) await storage.set(`capture.v2.fill${index}`, 'c'.repeat(60_000));
  ring.add(time.state.now);
  poll(ledger, ring);
  await ledger.flush('hidden');
  const view = ledger.accounting()!;
  expect(view.totalBytes).toBe(storage.stats().fileBytes);
  expect(view.totalBytes).toBeLessThanOrEqual(STORAGE_LIMITS.totalBytes - HEADROOM_BYTES);
  expect(view.ledgerBytes).toBeLessThanOrEqual(LEDGER_CAP_BYTES);
});

test('quota: a namespace other keys filled is never pushed past the host limit, and a flush that cannot fit waits without an error', async () => {
  const storage = createFakeStorage(), { time, ledger } = setup(storage), ring = new FakeRing();
  // 33 × 60 KB of captures and co: about 20 KiB short of 2 MiB, inside the ledger's headroom.
  for (let index = 0; index < 33; index++) await storage.set(`capture.v2.fill${index}`, 'c'.repeat(62_900));
  await ledger.start();
  for (let index = 0; index < 60; index++) ring.add(T0 + index * 1_000);
  poll(ledger, ring);
  await ledger.flush('rows');
  expect(ledger.state).toBe('idle');
  expect(ledger.pendingRows).toBe(0);
  expect(storage.stats().fileBytes).toBeLessThanOrEqual(STORAGE_LIMITS.totalBytes);
  // Now full to the byte: the next flush does not even try (no HOST_REJECTED), keeps its rows and retries later.
  const free = STORAGE_LIMITS.totalBytes - storage.stats().fileBytes;
  await storage.set('capture.v2.last', 'd'.repeat(free - 40));
  for (let index = 60; index < 120; index++) ring.add(T0 + index * 1_000);
  time.state.now = T0 + 300_000;
  poll(ledger, ring);
  const sets = storage.stats().sets;
  await ledger.flush('rows');
  expect(storage.stats().sets).toBe(sets);
  expect(ledger.state).toBe('idle');
  expect(ledger.pendingRows).toBe(60);
  expect(ledger.due('rows', time.state.now + 1_000)).toBe(false);
  await storage.delete('capture.v2.last');
  time.state.now += 30_000;
  expect(ledger.due('rows', time.state.now)).toBe(true);
  await ledger.flush('rows');
  expect(ids(storage)).toHaveLength(120);
  expect(ledger.accounting()!.totalBytes).toBe(storage.stats().fileBytes);
});

test('chunk keys stay unique even when the random suffix repeats', async () => {
  const storage = createFakeStorage(), time = clock();
  for (let leader = 0; leader < 6; leader++) {
    const ledger = new Ledger({ storage, now: time.now, random: () => 'aaaa' }), ring = new FakeRing(INSTANCE);
    await ledger.start();
    // A full open chunk each time, so every leader starts a new chunk in the same second.
    for (let index = 0; index < 700; index++) ring.add(T0 + index);
    ring.seq += leader * 1_000;
    ring.items.forEach((item, index) => { item.seq = leader * 1_000 + index + 1; });
    ledger.append({ instance: INSTANCE, cursor: ring.items.at(-1)!.seq, reset: false, items: ring.items.slice(0, 64) }, verdictAttr, SOURCE);
    await ledger.flush('hidden');
    ledger.dispose();
  }
  const keys = chunks(storage).map(([key]) => key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const [, value] of chunks(storage)) expect(JSON.stringify(value).length).toBeLessThan(CHUNK_MAX_CHARS);
});

test('Clear removes the ledger and baselines, and no later leader re-records a cleared reply from the ring', async () => {
  const { storage, time, ledger } = setup(), ring = new FakeRing();
  await storage.set('capture.v2.keep', { v: 2 });
  await ledger.start();
  for (let index = 0; index < 5; index++) ring.add(T0 + index * 1_000);
  poll(ledger, ring);
  await ledger.flush('hidden');
  time.state.now += 60_000;
  // Cleared from another frame's History tab while this one leads.
  await new Ledger({ storage, now: time.now }).clear();
  expect(Object.keys(storage.dump()).filter(key => key.startsWith('ledger.v2.') || key === KEYS.baseline)).toEqual([]);
  expect(storage.dump()['capture.v2.keep']).toEqual({ v: 2 });
  ring.add(time.state.now + 1_000);
  poll(ledger, ring);
  time.state.now += HIDE_FLUSH_GAP_MS;
  await ledger.flush('hidden');
  expect(ids(storage)).toEqual([`${INSTANCE}.6`]);
  expect(storage.dump()[KEYS.models]).toEqual(['Example-27B-4bit']);
  // A fresh leader with no cursor reads the whole ring and still skips the cleared five.
  ledger.dispose();
  const next = new Ledger({ storage, now: time.now });
  await next.start();
  next.append(ring.response(), verdictAttr, SOURCE);
  expect(next.pendingRows).toBe(0);
});

test('Pause recording: no new rows while paused (pending rows still flush), persisted in pref.v2', async () => {
  const { storage, time, ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  ring.add(T0 + 1_000);
  poll(ledger, ring);
  ledger.setPaused(true);
  expect(ledger.state).toBe('paused');
  ring.add(T0 + 2_000);
  poll(ledger, ring);
  expect(ledger.pendingRows).toBe(1);
  await ledger.flush('hidden');
  expect(ids(storage)).toEqual([`${INSTANCE}.1`]);
  expect((storage.dump()[KEYS.pref] as { history: boolean }).history).toBe(false);
  const next = new Ledger({ storage, now: time.now });
  await next.start();
  expect(next.state).toBe('paused');
  next.setPaused(false);
  ring.add(T0 + 3_000);
  poll(next, ring);
  expect(next.pendingRows).toBe(1);
});

test('settings from another frame apply at the next flush; a local Pause still in flight is not undone', async () => {
  const { storage, time, ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  for (let day = 0; day < 10; day++) {
    time.state.now = T0 + day * 86_400_000;
    ring.add(time.state.now - 1_000);
    poll(ledger, ring);
    await ledger.flush('hidden');
  }
  await new Ledger({ storage, now: time.now }).setRetention(3);
  ring.add(time.state.now + 1_000);
  poll(ledger, ring);
  time.state.now += HIDE_FLUSH_GAP_MS;
  await ledger.flush('hidden');
  expect(storedReplies(storage).every(row => row[1] >= Math.floor(time.state.now / 1000) - 4 * 86_400)).toBe(true);
  expect(ledger.usage()!.retentionDays).toBe(3);
  ring.add(time.state.now + 2_000);
  poll(ledger, ring);
  ledger.setPaused(true);
  time.state.now += HIDE_FLUSH_GAP_MS;
  await ledger.flush('hidden');
  expect(ledger.state).toBe('paused');
  expect((storage.dump()[KEYS.pref] as { history: boolean }).history).toBe(false);
});

test('a migration the host refuses does not keep the ledger from starting; it is retried at the next start', async () => {
  let refuse = true;
  const storage = createFakeStorage({ initial: { 'observation.v1.0001790600061000.aa': { savedAt: T0, sampledAt: T0, kind: 'snapshot', state: 'observed', phase: 'idle', measurements: { cpu: 5 } } },
    reject: (op, key) => refuse && op === 'set' && !!key?.startsWith('capture.v2.') });
  const { ledger } = setup(storage);
  await ledger.start();
  expect(ledger.state).toBe('idle');
  expect(storage.dump()[KEYS.meta]).toBeUndefined();
  refuse = false;
  await ledger.start();
  expect((storage.dump()[KEYS.meta] as { migratedAt: number }).migratedAt).toBe(T0);
});

test('a poll sent with a cursor ahead of the ledger\'s is not recorded; the next poll uses the ledger\'s cursor', async () => {
  const { ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  ring.add(T0 + 1_000);
  poll(ledger, ring);
  for (let index = 0; index < 4; index++) ring.add(T0 + 2_000 + index);
  ledger.append(ring.response(4), verdictAttr, { ...SOURCE, since: 4 });
  expect(ledger.pendingRows).toBe(1);
  ledger.append(ring.response(ledger.since('lmstudio')), verdictAttr, { ...SOURCE, since: ledger.since('lmstudio') });
  expect(ledger.pendingRows).toBe(5);
});

test('turn rows link the attributed replies they span', async () => {
  const { ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  ring.add(T0 + 1_000, { verdict: { attr: 'inferred', at: T0 } });
  ring.add(T0 + 5_000, { verdict: { attr: 'inferred', at: T0 } });
  ring.add(T0 + 9_000);
  poll(ledger, ring);
  ledger.appendTurn(['t', 1_790_690_700, 1_790_690_706, 'lmstudio', 0, 2, 1_800, 510, 380, 1_000, 'inferred', 0]);
  ledger.appendTurn(['t', 1_790_690_700, 1_790_690_706, 'lmstudio', 0, 2, 1_850, 510, 380, 1_000, 'inferred', 0]);
  const rows = await ledger.read();
  expect(rows.filter(row => row[0] === 'r').map(row => (row as ReplyRow)[14])).toEqual([1_790_690_700, 1_790_690_700, null]);
  expect(rows.filter(row => row[0] === 't')).toEqual([['t', 1_790_690_700, 1_790_690_706, 'lmstudio', 0, 2, 1_850, 510, 380, 1_000, 'inferred', 0]]);
});

test('read: range, retention and dedupe across chunks, including rows not yet flushed; a non-leader reads storage', async () => {
  const { storage, time, ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  for (let index = 0; index < 10; index++) ring.add(T0 + index * 60_000);
  poll(ledger, ring);
  await ledger.flush('hidden');
  ring.add(T0 + 11 * 60_000);
  time.state.now = T0 + 12 * 60_000;
  poll(ledger, ring);
  expect(await ledger.read(1_790_690_700 + 120, 1_790_690_700 + 300)).toHaveLength(4);
  expect(await ledger.read()).toHaveLength(11);
  const other = new Ledger({ storage, now: time.now });
  expect(await other.read()).toHaveLength(10);
  expect(await other.models()).toEqual(['Example-27B-4bit']);
  const usage = await other.inspect();
  expect(usage).toMatchObject({ replies: 10, retentionDays: 30, paused: false, keys: 2, capBytes: LEDGER_CAP_BYTES });
  expect(usage.namespaceBytes).toBe(storage.stats().fileBytes);
  time.state.now = T0 + 31 * 86_400_000;
  expect(await other.read()).toHaveLength(0);
});

test('the leader writes baseline.v2 after a flush, only when it changed and at most every 10 min', async () => {
  const { storage, time, ledger } = setup(), ring = new FakeRing();
  await ledger.start();
  for (let index = 0; index < 12; index++) ring.add(T0 - 3_600_000 + index * 60_000);
  poll(ledger, ring);
  await ledger.flush('hidden');
  expect(storage.stats().setKeys).toEqual([KEYS.models, expect.stringMatching(CHUNK_KEY), KEYS.baseline]);
  ring.add(time.state.now);
  poll(ledger, ring);
  time.state.now += HIDE_FLUSH_GAP_MS;
  await ledger.flush('hidden');
  expect(storage.stats().setKeys.filter(key => key === KEYS.baseline)).toHaveLength(1);
  expect((await new Ledger({ storage, now: time.now }).storedBaselines())?.get('decodeTps|lmstudio|0|1')?.n).toBe(12);
});

test('LedgerRecorder: records only while the lease says leader, and a lost lease stops without a write', async () => {
  const storage = createFakeStorage(), time = clock(), ring = new FakeRing(), recorder = new LedgerRecorder(new Ledger({ storage, now: time.now }));
  const snapshot = (leader: boolean): SnapshotV2 => ({ lease: { leader, epoch: 1, ttlMs: 12_000, leaderSurface: leader ? 'panel' : 'page' },
    connection: { id: 'lmstudio', runtime: 'lmstudio' }, completions: ring.response(recorder.since('lmstudio')) }) as unknown as SnapshotV2;
  ring.add(T0 + 1_000);
  await recorder.observe(snapshot(false), time.state.now);
  expect(recorder.recording).toBe(false);
  await recorder.observe(snapshot(true), time.state.now);
  expect(recorder.recording).toBe(true);
  expect(recorder.ledger.pendingRows).toBe(1);
  time.state.now += FLUSH_EVERY_MS;
  await recorder.observe(snapshot(true), time.state.now);
  expect(ids(storage)).toEqual([`${INSTANCE}.1`]);
  ring.add(time.state.now);
  await recorder.observe(snapshot(true), time.state.now);
  const sets = storage.stats().sets;
  await recorder.observe(snapshot(false), time.state.now);
  await recorder.hidden(time.state.now + 60_000);
  expect(storage.stats().sets).toBe(sets);
  expect(recorder.since('lmstudio')).toBeUndefined();
});

test('the first leader start migrates 1.x observations once; later starts write nothing', async () => {
  const fixture = await Bun.file(new URL('../../tests/fixtures/storage/1.6.1/observation-v1.json', import.meta.url)).json() as Record<string, unknown>;
  const storage = createFakeStorage({ initial: fixture }), time = clock();
  const ledger = new Ledger({ storage, now: time.now });
  await ledger.start();
  const keys = Object.keys(storage.dump());
  expect(keys.filter(key => key.startsWith(KEYS.capturePrefix))).toHaveLength(3);
  expect(keys.filter(key => key.startsWith(KEYS.legacyObservationPrefix))).toHaveLength(3);
  expect((storage.dump()[KEYS.meta] as { migratedAt: number }).migratedAt).toBe(T0);
  expect(ledger.accounting()!.totalBytes).toBe(storage.stats().fileBytes);
  const sets = storage.stats().sets;
  ledger.dispose();
  await new Ledger({ storage, now: time.now }).start();
  expect(storage.stats().sets).toBe(sets);
});

