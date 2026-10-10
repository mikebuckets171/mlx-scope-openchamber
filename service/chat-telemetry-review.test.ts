import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatTelemetry } from './chat-telemetry.ts';
import { version as companionVersion } from '../bridge/opencode/package.json';

test('writer freshness is checked after asynchronous IO while truly future data stays rejected', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'scope-chat-clock-')));
  const directory = join(home, '.cache', 'mlx-scope', 'chat-telemetry');
  const target = { sessionKey: 'a'.repeat(64), modelKey: 'b'.repeat(64), providerKey: 'c'.repeat(64), endpointKey: 'd'.repeat(64) };
  const writerID = '00000000-2222-4333-8444-555555555555';
  let now = 100_000;
  const measurement = { scope: 'chat', basis: 'estimated-characters', timingBasis: 'delivery-window', phase: 'generating',
    tokensPerSecond: 42, observedAtMs: now + 1, expiresAtMs: now + 5_001,
    observation: { startedAtMs: now - 2_999, endedAtMs: now + 1 }, freshness: 'live' } as const;
  const body = { schemaVersion: 1, writerID, companionVersion, protocol: 'opencode-2.0.25', runtimeVersion: '2.0.25',
    updatedAtMs: now + 1, expiresAtMs: now + 15_001, entries: [{ ...target, measurement }] };
  const telemetry = new ChatTelemetry(home, () => now);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${writerID}.json`), JSON.stringify({ ...body, updatedAtMs: now, expiresAtMs: now + 15_000 }), { mode: 0o600 });
    expect(await telemetry.observe('11111111', target)).toBeNull(); // Valid writer envelope cannot admit a future measurement.
    await writeFile(join(directory, `${writerID}.json`), JSON.stringify(body), { mode: 0o600 });
    expect(await telemetry.observe('11111111', target)).toBeNull();
    const pending = telemetry.observe('11111111', target);
    now += 1; // The writer becomes current while observe is awaiting filesystem IO.
    expect(await pending).toEqual(measurement);
  } finally { await telemetry.dispose(); await rm(home, { recursive: true, force: true }); }
});
