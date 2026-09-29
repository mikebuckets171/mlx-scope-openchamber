import { expect, test } from 'bun:test';
import { readHostMessage } from '@openchamber/sdk';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { toSnapshotV2 } from '../src/contract/convert-v1.ts';
import { parseSnapshotV2 } from '../src/contract/snapshot.ts';
import { fromSnapshot } from './present/reading.ts';

type PreviewEvent = { source: unknown; data: Record<string, unknown> };

// Exercise the actual development fixture, not a duplicate protocol object.
// Only this repository's trusted inline script is evaluated in the test context.
test.each(['storage', 'clipboard'] as const)('preview %s failures match the pinned SDK wire contract', kind => {
  const html = readFileSync(new URL('../tests/browser/host.html', import.meta.url), 'utf8');
  const source = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!source) throw Error('Preview script missing');
  const replies: unknown[] = [];
  const listeners: Array<(event: PreviewEvent) => void> = [];
  const contentWindow = { postMessage: (message: unknown) => replies.push(message) };
  const context = {
    document: { querySelector: () => ({ contentWindow }) }, URLSearchParams,
    location: { search: `?${kind}=fail`, origin: 'http://127.0.0.1:9999' },
    window: { addEventListener: (_type: string, listener: (event: PreviewEvent) => void) => listeners.push(listener) },
  };
  runInNewContext(source, context, { timeout: 500 });
  expect(listeners).toHaveLength(1);
  listeners[0]!({ source: contentWindow, data: {
    channel: 'openchamber.sdk', v: 1, id: 'fixture-failure',
    type: kind === 'storage' ? 'storage' : 'clipboard-write',
    payload: { op: 'set', key: 'view.compact', value: true, text: 'Fixture reading' },
  } });
  expect(replies).toHaveLength(1);
  expect(readHostMessage(replies[0])).toMatchObject({
    type: 'result', id: 'fixture-failure', ok: false,
    code: 'HOST_REJECTED', error: `Fixture ${kind} failure`,
  });
});

// The synthetic host answers the panel the way a 2.0 service will: v2 bodies made by the service's own bridge, sent as
// strings, and a 410 for the retired 1.x route.
const HOST = /<script>([\s\S]*?)<\/script><\/body>/.exec(readFileSync(new URL('../tests/browser/host.html', import.meta.url), 'utf8'))![1]!;
const answer = (search: string, path: string, bridge: unknown = { toSnapshotV2 }) => {
  const replies: Array<{ payload: { status: number; body: unknown } }> = [], listeners: Array<(event: PreviewEvent) => void> = [];
  const contentWindow = { postMessage: (message: { payload: { status: number; body: unknown } }) => replies.push(message) };
  runInNewContext(HOST, { ScopeConvert: bridge, URLSearchParams, JSON, Math, Date: { now: () => 1_790_690_700_000 },
    document: { querySelector: () => ({ contentWindow, style: {} }) }, sessionStorage: { getItem: () => null },
    location: { search, origin: 'http://127.0.0.1:9999', href: 'http://127.0.0.1:9999/' },
    window: { addEventListener: (_type: string, listener: (event: PreviewEvent) => void) => listeners.push(listener) } }, { timeout: 500 });
  listeners[0]!({ source: contentWindow, data: { channel: 'openchamber.sdk', v: 1, id: 'poll', type: 'service-request', payload: { method: 'GET', path, query: {} } } });
  return replies[0]!.payload;
};

test('the preview host answers /v2/snapshot with the bridge\'s v2 body as a string', () => {
  const reply = answer('?state=prefill', '/v2/snapshot');
  expect(reply.status).toBe(200);
  expect(typeof reply.body).toBe('string');
  const body = parseSnapshotV2(JSON.parse(reply.body as string));
  expect(body).toMatchObject({ contractVersion: 2, serverNow: 1_790_690_700_000, service: { instance: '5c1e0a7b' } });
  expect(fromSnapshot(body!)).toMatchObject({ available: true, runtime: 'omlx', phase: 'prefill', model: 'Qwen3.8-27B-4bit',
    request: { prefillProcessedTokens: 5_824, prefillTotalTokens: 9_100, prefillEtaMs: 17_750 } });
  const offline = fromSnapshot(parseSnapshotV2(JSON.parse(answer('?state=offline&connections=1', '/v2/snapshot').body as string))!);
  expect(offline).toMatchObject({ available: false, reason: 'runtime_unreachable', link: { selected: 'omlx', coverage: 'requests' } });
});

test('the preview host retires /snapshot with 410 and can stand in for a 1.6 or a future service', () => {
  expect(answer('', '/snapshot')).toEqual({ status: 410, body: JSON.stringify({ error: 'contract_mismatch', contractVersion: 2 }) });
  expect(answer('', '/elsewhere').status).toBe(404);
  expect(answer('?contract=1.6', '/v2/snapshot').status).toBe(404);
  expect(answer('?contract=3', '/v2/snapshot')).toEqual({ status: 200, body: JSON.stringify({ contractVersion: 3 }) });
});

test('the page copy of the bridge is the converter itself, bundled for the browser', async () => {
  const build = await Bun.build({ entrypoints: [new URL('../tests/browser/convert-entry.ts', import.meta.url).pathname], format: 'iife', target: 'browser' });
  expect(build.success).toBe(true);
  const context: { ScopeConvert?: { toSnapshotV2: typeof toSnapshotV2 } } = {};
  runInNewContext(await build.outputs[0]!.text(), context);
  const v1 = JSON.parse(answer('?state=decode', '/v2/snapshot', { toSnapshotV2: (reading: unknown) => reading }).body as string);
  const extras = { service: { version: '2.0.0-preview', instance: '5c1e0a7b' }, serverNow: 1_790_690_700_000 };
  expect(JSON.parse(JSON.stringify(context.ScopeConvert!.toSnapshotV2(v1, extras)))).toEqual(JSON.parse(JSON.stringify(toSnapshotV2(v1, extras))));
});
