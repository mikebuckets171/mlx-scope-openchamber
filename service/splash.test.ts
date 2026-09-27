import { expect, test } from 'bun:test';
import { parseTelemetrySnapshot } from '../src/telemetry.ts';
import { SplashClient } from './splash.ts';

const fixture = () => ({
  ready: true,
  instance: { id: 'private-instance-id', pid: 9999, model: 'incoai/Qwen3.8-27B-Splash', host: '127.0.0.1' },
  maximum_context_tokens: 262_144,
  requests: { submitted: 18, completed: 17, cancelled: 1, failed: 0 },
  metrics: { decode_tokens_per_second: 47.2 },
  memory_actual: { current_bytes: 12_500_000_000, peak_bytes: 13_000_000_000 },
});

test('Splash reads one passive status endpoint and preserves server-wide scope', async () => {
  const paths: string[] = [];
  const client = new SplashClient(async path => { paths.push(path); return fixture(); }, () => 1234);
  const raw = await client.snapshot();
  const snapshot = parseTelemetrySnapshot(raw);

  expect(paths).toEqual(['/status']);
  expect(snapshot).toMatchObject({
    available: true, runtime: 'splash', phase: 'idle', modelID: 'incoai/Qwen3.8-27B-Splash',
    contextWindow: 262_144, activeRequests: 0, queuedRequests: null, liveDecodeTPS: null,
    memory: null, sessionBank: null, lifetime: null, sessionStatsState: 'unavailable',
    serverStats: { ready: true, aggregateDecodeTokensPerSecond: 47.2, completedRequests: 17,
      failedRequests: 0, metalCurrentGB: 12.5, metalPeakGB: 13 },
    catalog: [{ name: 'incoai/Qwen3.8-27B-Splash', loaded: true, format: 'splash', contextWindow: 262_144 }],
  });
  expect(snapshot.message).toBe('Idle · ready for your next request.');
  expect(JSON.stringify(snapshot)).not.toContain('private-instance-id');
  expect(JSON.stringify(snapshot)).not.toContain('127.0.0.1');
});

test('Splash derives in-flight requests from its lifetime counters', async () => {
  const busy = { ...fixture(), requests: { submitted: 21, completed: 17, cancelled: 1, failed: 1 } };
  const snapshot = await new SplashClient(async () => busy, () => 1234).snapshot();
  expect(snapshot).toMatchObject({ phase: 'processing', activeRequests: 2 });
  expect(snapshot.message).toBe('Generating · 2 requests in flight.');

  const partial = { ...fixture(), requests: { completed: 17 } };
  expect(await new SplashClient(async () => partial, () => 1234).snapshot()).toMatchObject({ phase: 'unknown', activeRequests: null });
});

test('Splash not-ready status does not claim model residency or request activity', async () => {
  const client = new SplashClient(async () => ({
    ready: false, instance: { model: '/private/models/example' },
    requests: { completed: 10 }, memory_actual: { current_bytes: 14, peak_bytes: 12 },
  }), () => 1234);
  const snapshot = await client.snapshot();
  expect(snapshot).toMatchObject({ available: true, runtime: 'splash', modelID: 'example',
    activeRequests: null, queuedRequests: null, memory: null,
    catalog: [{ name: 'example', loaded: null }],
    serverStats: { ready: false, completedRequests: 10, failedRequests: null,
      aggregateDecodeTokensPerSecond: null, metalCurrentGB: 0.000000014, metalPeakGB: null },
  });
  expect(snapshot.message).toBe('Loading example…');
  expect(JSON.stringify(snapshot)).not.toContain('/private/models');
});

test('Splash rejects an unrecognized status contract and sanitizes panel server statistics', async () => {
  const malformed = await new SplashClient(async () => ({ status: 'ready' })).snapshot();
  expect(malformed).toMatchObject({ available: false, runtime: 'splash', reason: 'unsupported_contract' });

  const parsed = parseTelemetrySnapshot({ available: true, runtime: 'splash', serverStats: {
    ready: 'yes', aggregateDecodeTokensPerSecond: 'secret', completedRequests: 2.5,
    failedRequests: -1, metalCurrentGB: 'secret', metalPeakGB: 4,
  } });
  expect(parsed.serverStats).toEqual({ ready: null, aggregateDecodeTokensPerSecond: null,
    completedRequests: null, failedRequests: null, metalCurrentGB: null, metalPeakGB: 4 });
});
