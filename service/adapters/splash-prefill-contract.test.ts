import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { honestyViolations, parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import type { RuntimeConnections } from '../config.ts';
import { RuntimeClient } from '../runtime-client.ts';
import { SplashRates, SPLASH_RATE_GAP_MS, SPLASH_RATE_MIN_SAMPLES, SPLASH_RATE_MIN_WINDOW_MS, splashDescriptor } from './splash.ts';

/** Identical fixture bytes are consumed by the native ScopeCore test suite. */
const contract = JSON.parse(readFileSync(join(import.meta.dir, '../../tests/fixtures/splash/prefill-rate-contract.json'), 'utf8')) as {
  schemaVersion: number; contract: string; windowMaxMs: number; minimumSamples: number; minimumSpanMs: number; roundingDigits: number;
  cases: Array<{ name: string; samples: Array<{ atMs: number; body: unknown; expected: { prefillTps: number; windowMs: number } | null }> }>;
};

describe('shared Splash recent prefill speed contract', () => {
  test('declares the independent measurement specification implemented by both apps', () => {
    expect({ schemaVersion: contract.schemaVersion, contract: contract.contract, windowMaxMs: contract.windowMaxMs,
      minimumSamples: contract.minimumSamples, minimumSpanMs: contract.minimumSpanMs, roundingDigits: contract.roundingDigits })
      .toEqual({ schemaVersion: 1, contract: 'splash-recent-prefill-v1', windowMaxMs: SPLASH_RATE_GAP_MS,
        minimumSamples: SPLASH_RATE_MIN_SAMPLES, minimumSpanMs: SPLASH_RATE_MIN_WINDOW_MS, roundingDigits: 3 });
  });

  test.each(contract.cases.map(item => [item.name, item.samples] as const))('%s', (_, samples) => {
    const observer = new SplashRates();
    for (const [index, sample] of samples.entries()) {
      const rates = observer.observe(sample.body, sample.atMs);
      const prefill = rates?.promptTps === undefined ? null : { prefillTps: rates.promptTps, windowMs: rates.promptWindowMs };
      expect(prefill, `sample ${index} at ${sample.atMs} ms`).toEqual(sample.expected);
    }
  });

  test('endpoint changes clear prefill continuity and fresh rates survive normalization with derived basis', async () => {
    let now = 0, port = 8000, counterIndex = 0;
    const requests: string[] = [], sequence = contract.cases.find(item => item.name === 'rolling-five-seconds')!.samples;
    const configuration = (): RuntimeConnections => ({ issue: 'none', error: null, connections: [{ id: 'local', label: 'Splash', runtime: 'splash',
      config: { baseURL: new URL(`http://127.0.0.1:${port}/`), apiKey: null, preferredModel: null, issue: 'none', error: null,
        source: 'opencode', configStatus: 'present', authStatus: 'present' } }] });
    const client = new RuntimeClient({ now: () => now, descriptors: [splashDescriptor], readConfig: async () => configuration(),
      fetchImpl: async url => {
        requests.push(new URL(String(url)).port);
        return new Response(JSON.stringify(sequence[counterIndex]!.body), { headers: { 'Content-Type': 'application/json' } });
      } });
    try {
      for (counterIndex = 0; counterIndex < 3; counterIndex += 1) {
        now = counterIndex * 1000;
        const reading = await client.read();
        expect(reading.runtime.server.rates?.promptTps ?? null).toEqual(sequence[counterIndex]!.expected?.prefillTps ?? null);
      }
      port = 8001; counterIndex = 5; now = 5000;
      expect((await client.read()).runtime.server.rates).toBeUndefined();
      counterIndex = 6; now = 6000;
      expect((await client.read()).runtime.server.rates).toBeUndefined();
      counterIndex = 7; now = 7000;
      const reading = await client.read();
      expect(reading.runtime.server.rates).toEqual({ promptTps: 100, promptWindowMs: 2000, windowMs: 2000 });
      expect(reading.capabilities['server.rates']).toEqual({ scope: 'server', basis: 'derived' });
      const snapshot = { contractVersion: 2, serverNow: now, service: { version: '2.1.5', instance: '12345678' },
        connection: { id: 'local', label: 'Splash', runtime: 'splash', generation: 1, choices: [], detection: { basis: 'explicit', confidence: 'high' } },
        status: reading.status, capabilities: reading.capabilities, runtime: reading.runtime, host: null,
        completions: { instance: '12345678', cursor: 0, reset: false, items: [] }, marksHead: 0, alerts: [], alertLog: [],
        lease: { leader: false, epoch: 1, ttlMs: 0, leaderSurface: null }, nextPollMs: 1000 };
      expect(parseSnapshotV2(snapshot)?.runtime.server.rates).toEqual(reading.runtime.server.rates);
      expect(honestyViolations(snapshot)).toEqual([]);
      expect(requests).toEqual(['8000', '8000', '8000', '8001', '8001', '8001']);
    } finally { client.dispose(); }
  });
});
