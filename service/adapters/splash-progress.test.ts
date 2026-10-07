import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classAKeys } from '../../src/contract/guards.ts';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { mockBody } from '../../panel/testing/mock-states.ts';
import { prefillReading } from '../../panel/progress.ts';
import { scopeText } from '../../panel/share/scope.ts';
import type { AdapterContextV2 } from '../core/adapter-v2.ts';
import { createSplashAdapter, splashReading } from './splash.ts';
import { parseProgressFile, progressKey, PROGRESS_MAX_BYTES, PROGRESS_TTL_MS, readProgressCache, SplashPromptProgress, type ProgressScope } from './splash-progress.ts';

type Json = Record<string, any>;
const AT = 1_790_690_700_000, MODEL = 'publisher/Example-27B-4bit', PROVIDER = 'splish';
const WRITER = '00000000-0000-4000-8000-000000000001', REQUEST = '00000000-0000-4000-8000-000000000002';
const entry = (at = AT, patch: Json = {}): Json => ({ requestID: REQUEST, sessionKey: progressKey('session', 'PRIVATE-SESSION-CANARY'),
  providerID: PROVIDER, endpointKey: progressKey('endpoint', 'http://127.0.0.1:8000'), modelKey: progressKey('model', MODEL), kind: 'primary',
  total: 1000, cache: 800, processed: 850, timeMs: 200.25, observedAtMs: at, expiresAtMs: at + PROGRESS_TTL_MS, ...patch });
const document = (entries: Json[] = [entry()], at = AT, writerID = WRITER): Json => ({ schemaVersion: 1, writerID,
  updatedAtMs: at, expiresAtMs: at + PROGRESS_TTL_MS, entries });
const scope = (patch: Partial<ProgressScope> = {}): ProgressScope => ({ providerID: PROVIDER, endpointOrigin: 'http://127.0.0.1:8000',
  model: MODEL, generationKey: 'engine-a', startedAtMs: AT - 20_000, ...patch });
const parse = (body: Json, at = AT) => parseProgressFile(JSON.stringify(body), WRITER, at);

const withCache = async (run: (cache: { home: string; dir: string; write: (body: Json, writerID?: string) => Promise<void> }) => Promise<void>) => {
  const home = await mkdtemp(join(tmpdir(), 'scope-progress-')), dir = join(home, '.cache', 'mlx-scope', 'prompt-progress');
  try {
    await chmod(home, 0o700); await mkdir(dir, { recursive: true, mode: 0o700 });
    await run({ home, dir, write: (body, writerID = WRITER) => writeFile(join(dir, `${writerID}.json`), JSON.stringify(body), { mode: 0o600 }) });
  } finally { await rm(home, { recursive: true, force: true }); }
};

describe('private prompt-progress schema', () => {
  test('the versioned SHA-256 protocol agrees with independently calculated companion keys', () => {
    expect(progressKey('session', 'PRIVATE-SESSION-CANARY')).toBe('189e522450bea2b041f10b388977f174edeb02f4fb132859622977801206a67a');
    expect(progressKey('endpoint', 'http://127.0.0.1:8000')).toBe('69a9704f56b5cb7a279a7708596e2369e87c8cd759b326c77cdd5313b9e2d225');
    expect(progressKey('model', MODEL)).toBe('1ac6d4838b0256db05c9c1d3a6bf7104896f48d44e47168e6a37639c1786b093');
  });
  test('cached input remains in the actual overall prompt denominator; fractional native time is valid', () => {
    expect(parse(document())).toMatchObject([{ total: 1000, cache: 800, processed: 850, timeMs: 200.25 }]);
    expect(parse(document([entry(AT, { processed: 1000, cache: 1000 })]))).toHaveLength(1);
    expect(parse(document([entry(AT, { responseModelKey: progressKey('model', MODEL), kind: 'compaction' })]))).toHaveLength(1);
  });
  test('invalid counts, times, identities and unsupported formats cannot establish progress', () => {
    const patches: Json[] = [{ total: true }, { total: '1000' }, { total: 0 }, { total: 1.5 }, { total: Number.MAX_SAFE_INTEGER + 1 },
      { cache: -1 }, { cache: 851 }, { processed: 1001 }, { processed: false }, { timeMs: true }, { timeMs: -1 },
      { requestID: 'PRIVATE-REQUEST' }, { sessionKey: 'PRIVATE-SESSION' }, { endpointKey: 'http://localhost:8000' },
      { responseModelKey: 'bad' }, { kind: 'unknown' }, { providerID: 'not a provider' }, { unexpected: 'PRIVATE-CANARY' },
      { observedAtMs: AT + 1, expiresAtMs: AT + PROGRESS_TTL_MS + 1 }, { observedAtMs: AT + 0.5 },
      { expiresAtMs: AT + PROGRESS_TTL_MS + 1 }, { expiresAtMs: AT }];
    for (const patch of patches) expect(parse(document([entry(AT, patch)])), JSON.stringify(patch)).toBeNull();
    for (const patch of [{ schemaVersion: 2 }, { writerID: randomUUID() }, { updatedAtMs: AT + 1 }, { entries: {} },
      { unexpected: 'PRIVATE-CANARY' }, { expiresAtMs: AT + PROGRESS_TTL_MS + 1 }]) expect(parse({ ...document(), ...patch })).toBeNull();
    expect(parseProgressFile('{invalid', WRITER, AT)).toBeNull();
    expect(parseProgressFile('[]', WRITER, AT)).toBeNull();
  });
  test('expired entries are absent, while duplicate IDs and overflowing snapshots fail closed', () => {
    expect(parse(document(), AT + PROGRESS_TTL_MS)).toEqual([]);
    expect(parse(document([entry(), entry()]))).toBeNull();
    expect(parse(document(Array.from({ length: 17 }, () => entry(AT, { requestID: randomUUID() }))))).toBeNull();
  });
});

describe('bounded private file reads', () => {
  test('multiple safe writers are read together; foreign records do not override a matching one', () => withCache(async ({ home, write }) => {
    await write(document());
    const other = randomUUID();
    await write(document([entry(AT, { requestID: randomUUID(), providerID: 'foreign' })], AT, other), other);
    expect(await readProgressCache(AT, { home })).toHaveLength(2);
    expect(await new SplashPromptProgress({ home }).observe(scope(), AT, 0)).toEqual({ processed: 850, total: 1000, observedAt: AT, stale: false });
  }));
  test('symlinks, hardlinks, permissive modes and oversized files are rejected', () => withCache(async ({ home, dir, write }) => {
    const path = join(dir, `${WRITER}.json`);
    await write(document()); await chmod(path, 0o644);
    expect(await readProgressCache(AT, { home })).toBeNull();
    await chmod(path, 0o600); await chmod(dir, 0o755);
    expect(await readProgressCache(AT, { home })).toBeNull();
    await chmod(dir, 0o700);
    expect(await readProgressCache(AT, { home, uid: (process.getuid?.() ?? 0) + 1 })).toBeNull();
    const copy = join(home, 'private-source.json'); await writeFile(copy, JSON.stringify(document()), { mode: 0o600 });
    await unlink(path); await symlink(copy, path);
    expect(await readProgressCache(AT, { home })).toBeNull();
    await unlink(path); await link(copy, path);
    expect(await readProgressCache(AT, { home })).toBeNull();
    await unlink(path); await writeFile(path, ' '.repeat(PROGRESS_MAX_BYTES + 1), { mode: 0o600 });
    expect(await readProgressCache(AT, { home })).toBeNull();
  }));
  test('cache ancestors and unknown file formats fail closed; atomic temporary files are bounded and ignored', () => withCache(async ({ home, dir, write }) => {
    await write(document());
    await writeFile(join(dir, 'unknown.json'), JSON.stringify(document()), { mode: 0o600 });
    expect(await readProgressCache(AT, { home })).toBeNull();
    await unlink(join(dir, 'unknown.json'));
    await writeFile(join(dir, `.${WRITER}-${randomUUID()}.tmp`), 'partial', { mode: 0o600 });
    expect(await readProgressCache(AT, { home })).toHaveLength(1);
    const alias = join(home, 'alias'); await symlink(home, alias);
    expect(await readProgressCache(AT, { home: alias })).toBeNull();
    const cache = join(home, '.cache'), moved = join(home, 'moved-cache');
    const { rename } = await import('node:fs/promises'); await rename(cache, moved); await symlink(moved, cache);
    expect(await readProgressCache(AT, { home })).toBeNull();
  }));
  test('writer count and cross-writer duplicate requests cannot hide ambiguity', () => withCache(async ({ home, write }) => {
    await write(document()); const second = randomUUID();
    await write(document([entry()], AT, second), second);
    expect(await readProgressCache(AT, { home })).toBeNull();
    for (let i = 0; i < 15; i++) { const id = randomUUID(); await write(document([], AT, id), id); }
    expect(await readProgressCache(AT, { home })).toBeNull();
  }));
  test('atomic temporary files cannot make a directory scan unbounded', () => withCache(async ({ home, dir, write }) => {
    await write(document());
    for (let i = 0; i < 32; i++) await writeFile(join(dir, `.${WRITER}-${randomUUID()}.tmp`), 'partial', { mode: 0o600 });
    expect(await readProgressCache(AT, { home })).toBeNull();
  }));
});

describe('independent progress continuity', () => {
  test('an interrupted file read cannot republish its earlier percentage', () => withCache(async ({ home, write }) => {
    await write(document());
    const progress = new SplashPromptProgress({ home }), pending = progress.observe(scope(), AT, 0);
    progress.reset(AT + 1);
    expect(await pending).toBeUndefined();
    expect(await progress.observe(scope(), AT + 2, 2)).toBeUndefined();
  }));
  test('normal four-second chunks remain current, then become held at six seconds and expire at fifteen', () => withCache(async ({ home, write }) => {
    await write(document()); const progress = new SplashPromptProgress({ home });
    for (const elapsed of [0, 1000, 4000]) expect((await progress.observe(scope(), AT + elapsed, elapsed))?.stale).toBe(false);
    for (const elapsed of [6000, 10_000, 14_000]) expect((await progress.observe(scope(), AT + elapsed, elapsed))?.stale).toBe(true);
    expect(await progress.observe(scope(), AT + 15_000, 15_000)).toBeUndefined();
  }));
  test('response-declared model aliases match, but foreign providers, endpoints and models do not', () => withCache(async ({ home, write }) => {
    await write(document([entry(AT, { modelKey: progressKey('model', 'configured-alias'), responseModelKey: progressKey('model', MODEL) })]));
    expect(await new SplashPromptProgress({ home }).observe(scope(), AT, 0)).toBeDefined();
    for (const patch of [{ providerID: 'foreign' }, { endpointOrigin: 'http://127.0.0.1:8001' }, { model: 'different-model' }])
      expect(await new SplashPromptProgress({ home }).observe(scope(patch), AT, 0)).toBeUndefined();
  }));
  test('concurrent primary and background kinds stay ambiguous, regardless of which writer is read first', () => withCache(async ({ home, write }) => {
    await write(document()); const other = randomUUID();
    await write(document([entry(AT, { requestID: randomUUID(), kind: 'title' })], AT, other), other);
    expect(await new SplashPromptProgress({ home }).observe(scope(), AT, 0)).toBeUndefined();
  }));
  test('a lone title, compaction or generic generate observation is not the main reply’s prompt progress', () => withCache(async ({ home, write }) => {
    for (const kind of ['title', 'compaction', 'generate']) {
      await write(document([entry(AT, { kind })]));
      expect(await new SplashPromptProgress({ home }).observe(scope(), AT, 0)).toBeUndefined();
    }
  }));
  test('cancellation, interruption, gap, clock faults and engine replacement need a later source update', () => withCache(async ({ home, dir, write }) => {
    await write(document()); const progress = new SplashPromptProgress({ home });
    expect(await progress.observe(scope(), AT, 0)).toBeDefined();
    await unlink(join(dir, `${WRITER}.json`)); expect(await progress.observe(scope(), AT + 1000, 1000)).toBeUndefined();
    await write(document()); expect(await progress.observe(scope(), AT + 2000, 2000)).toBeUndefined();
    await write(document([entry(AT + 2500, { requestID: randomUUID() })], AT + 2500));
    expect(await progress.observe(scope(), AT + 3000, 3000)).toBeDefined();
    progress.reset(AT + 3500); expect(await progress.observe(scope(), AT + 4000, 4000)).toBeUndefined();
    await write(document([entry(AT + 4500)], AT + 4500)); expect(await progress.observe(scope(), AT + 5000, 5000)).toBeDefined();
    expect(await progress.observe(scope({ generationKey: 'engine-b', startedAtMs: AT + 5500 }), AT + 6000, 6000)).toBeUndefined();
    await write(document([entry(AT + 6500)], AT + 6500)); expect(await progress.observe(scope({ generationKey: 'engine-b' }), AT + 7000, 7000)).toBeDefined();
    expect(await progress.observe(scope({ generationKey: 'engine-b' }), AT + 13_000, 13_000)).toBeUndefined();
    await write(document([entry(AT + 14_000)], AT + 14_000)); expect(await progress.observe(scope({ generationKey: 'engine-b' }), AT + 14_000, 14_000)).toBeDefined();
    expect(await progress.observe(scope({ generationKey: 'engine-b' }), AT + 14_001, 14_000)).toBeUndefined();
  }));
  test('prior-process records and changed denominators/rollback cannot reappear as current progress', () => withCache(async ({ home, write }) => {
    await write(document());
    expect(await new SplashPromptProgress({ home }).observe(scope({ startedAtMs: AT + 1 }), AT, 0)).toBeUndefined();
    const progress = new SplashPromptProgress({ home }); expect(await progress.observe(scope(), AT, 0)).toBeDefined();
    await write(document([entry(AT + 1000, { processed: 820 })], AT + 1000));
    expect(await progress.observe(scope(), AT + 1000, 1000)).toBeUndefined();
    expect(await progress.observe(scope(), AT + 2000, 2000)).toBeUndefined();
    await write(document([entry(AT + 3000, { processed: 900 })], AT + 3000));
    expect(await progress.observe(scope(), AT + 3000, 3000)).toBeDefined();
    await write(document([entry(AT + 4000, { total: 1100 })], AT + 4000));
    expect(await progress.observe(scope(), AT + 4000, 4000)).toBeUndefined();
  }));
});

describe('Splash adapter progress corroboration', () => {
  const nativeBody = async (): Promise<Json> => {
    const body = JSON.parse(await readFile(join(import.meta.dir, '../../tests/fixtures/splash/1.1.0/status.ready-idle.json'), 'utf8'));
    body.requests.submitted += 1; body.http.requests.active = 1; body.scheduler.prefilling = 1;
    return body;
  };
  const harness = (body: Json, home: string) => {
    const clock = { at: AT, mono: 0 }, gets: string[] = [], execs: string[][] = [];
    const context: AdapterContextV2 = { connection: { id: PROVIDER, port: 8000 },
      get: async path => { gets.push(path); return { status: 200, body, routeMissing: false }; }, getText: async () => { throw Error('no text read'); },
      config: { baseURL: new URL('http://127.0.0.1:8000/'), apiKey: null, preferredModel: null, error: null, issue: 'none', source: 'opencode', configStatus: 'present', authStatus: 'missing' },
      fetchImpl: async () => { throw Error('no fetch'); }, exec: async argv => { execs.push([argv.file, ...argv.args]); return null; },
      now: () => clock.at, monotonic: () => clock.mono, timeoutMs: 2500, budgetMs: 1000 };
    return { adapter: createSplashAdapter(context, new SplashPromptProgress({ home })), clock, gets, execs };
  };
  const READ = { deadline: AT + 5000, tier: 'glance' as const, detail: false };
  test('real progress, unfinished >99% and timestamp survive normalization without private identities or fake chat attribution', () => withCache(async ({ home, write }) => {
    await write(document([entry(AT, { processed: 999 })])); const body = await nativeBody(), { adapter, gets, execs } = harness(body, home);
    expect(splashReading({ ...body, prompt_progress: { total: 1000, processed: 999 } }, AT).runtime.request).toBeNull();
    const reading = await adapter.read(READ);
    expect(reading.runtime.request).toEqual({ model: null, prefillFraction: 0.999, prefillProcessedTokens: 999, prefillTotalTokens: 1000, prefillObservedAt: AT });
    expect(reading.capabilities['request.prefillProgress']).toEqual({ scope: 'request', basis: 'reported' });
    const snapshot = parseSnapshotV2({ ...mockBody('splash-prefill'), status: reading.status, capabilities: reading.capabilities, runtime: reading.runtime })!;
    expect(snapshot.runtime.request!.prefillFraction).toBe(0.999);
    const { fromSnapshot } = await import('../../panel/present/reading.ts');
    expect(prefillReading(fromSnapshot(snapshot))!.completed).toBe('>99% complete');
    const exported = JSON.stringify(snapshot) + scopeText({ version: '2.1.5', now: AT, snapshot });
    for (const privateValue of [WRITER, REQUEST, 'PRIVATE-SESSION-CANARY', entry().sessionKey, entry().endpointKey, entry().modelKey]) expect(exported).not.toContain(privateValue);
    expect(classAKeys(snapshot)).toEqual([]); expect(gets).toEqual(['/status']); expect(execs).toEqual([]);
  }));
  test('fresh ready, one active prefill, no queue/decode/mask and a matching live process are all required', () => withCache(async ({ home, write }) => {
    await write(document());
    const changes: Array<(body: Json) => void> = [body => { body.ready = false; }, body => { body.transport.recovering = true; },
      body => { body.transport.status_stale = true; }, body => { body.transport.stopped = true; }, body => { body.metal.healthy = false; },
      body => { body.scheduler.prefilling = 0; }, body => { body.scheduler.prefilling = 2; body.requests.submitted += 1; body.http.requests.active = 2; },
      body => { body.scheduler.queued = 1; body.requests.submitted += 1; body.http.requests.active = 2; },
      body => { body.scheduler.decoding = 1; }, body => { body.scheduler.waiting_mask = 1; },
      body => { body.instance.model = 'foreign-model'; }, body => { body.instance.started_at = (AT + 1) / 1000; }];
    for (const change of changes) { const body = await nativeBody(); change(body); expect((await harness(body, home).adapter.read(READ)).runtime.request).toBeNull(); }
  }));
  test('recovery and disposal cannot resurrect an observation until the companion publishes again', () => withCache(async ({ home, write }) => {
    await write(document()); const body = await nativeBody(), { adapter, clock } = harness(body, home);
    expect((await adapter.read(READ)).runtime.request).not.toBeNull();
    body.transport.status_stale = true; clock.at += 1000; clock.mono += 1000;
    expect((await adapter.read(READ)).runtime.request).toBeNull();
    body.transport.status_stale = false; clock.at += 1000; clock.mono += 1000;
    expect((await adapter.read(READ)).runtime.request).toBeNull();
    await write(document([entry(AT + 2500, { processed: 950 })], AT + 2500)); clock.at += 1000; clock.mono += 1000;
    expect((await adapter.read(READ)).runtime.request?.prefillFraction).toBe(0.95);
    adapter.dispose(); clock.at += 1000; clock.mono += 1000;
    expect((await adapter.read(READ)).runtime.request).toBeNull();
  }));
});
