import { expect, test } from 'bun:test';
import { ALERT_IDS, CONFIG_ISSUES, FRAME_REASONS, STATUS_REASONS, WITHHOLD_REASONS, type ReasonParams, type StatusReason } from '../../src/contract/reasons.ts';
import { RUNTIMES, type RuntimeKind } from '../../src/contract/runtime.ts';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { fullSnapshot } from '../../src/contract/testing/full.ts';
import { fromSnapshot } from './reading.ts';
import { alertCopy, alertMessage, frameMessage, statusCopy, statusMessage, withholdMessage } from './reasons.ts';

// Every English string the service used to send, as v1.6.1 wrote it (service/config.ts, service/runtime-client.ts, adapters).
const V16 = {
  config: {
    missing_endpoint: 'No local runtime connection found. Add your runtime as a provider in OpenChamber; saved connections are discovered automatically.',
    malformed_config: 'An existing provider configuration is malformed. Correct it in OpenChamber, then return here.',
    unreadable_config: 'An existing provider configuration or credential file could not be read.',
    invalid_endpoint: 'The selected connection needs an HTTP loopback URL with an explicit port, such as http://localhost:8000/v1.',
    unsupported_config: 'A configured credential or endpoint reference could not be resolved. Reconnect this provider in OpenChamber.',
    read_failed: 'Saved runtime connections could not be read. Reopen MLX Scope after checking the provider in OpenChamber.',
    removed: 'This saved connection is no longer configured. Choose another connection or Automatic.',
  },
  deferred: 'Earlier connection reads are finishing. Monitoring retries automatically.',
  unreachable: (name: string) => `${name} is not responding with supported readings. Start it on the OpenChamber host; monitoring retries automatically.`,
  noKey: (name: string) => `${name} needs an API key. Connect this provider in OpenChamber, then return here.`,
  rejected: (name: string) => `${name} rejected the saved API key. Reconnect this provider in OpenChamber.`,
  unsupportedRuntime: 'This connection does not identify a supported runtime. Choose its runtime in Change connection. OpenAI-compatible chat endpoints alone do not provide live telemetry.',
};
const every = (reason: StatusReason): ReasonParams[] => [{}, { port: 8001, sinceAt: 1, deferred: false, keySaved: true, detected: 'splash', retryInMs: 30_000,
  crashTrace: true, staleSinceAt: 1, cause: 'metal', issue: 'removed' }, reason === 'configuration_missing' ? { issue: 'invalid_endpoint' } : { port: 1234 }];

test('the 1.6 sentences are kept word for word where 1.6 said the same thing', () => {
  for (const issue of CONFIG_ISSUES) expect(statusMessage('configuration_missing', { issue }, null)).toBe(V16.config[issue]);
  expect(statusMessage('configuration_missing', {}, null)).toBe(V16.config.missing_endpoint);
  expect(statusMessage('runtime_unreachable', { port: 8000, deferred: true }, 'omlx')).toBe(V16.deferred);
  expect(statusMessage('runtime_unreachable', { port: 8000 }, 'vllm-mlx')).toBe(V16.unreachable('vllm-mlx'));
  expect(statusMessage('runtime_unreachable', {}, null)).toBe(V16.unreachable('The configured runtime'));
  expect(statusMessage('authentication_failed', { keySaved: false }, 'lmstudio')).toBe(V16.noKey('LM Studio'));
  // The oMLX "subkeys cannot read monitoring" clause is gone: 0.7 sub keys read /api/status (plan §5.2).
  expect(statusMessage('authentication_failed', { keySaved: true }, 'omlx')).toBe(V16.rejected('oMLX'));
  expect(statusMessage('authentication_failed', {}, null)).toBe(V16.rejected('This runtime'));
  expect(statusMessage('unsupported_runtime', { port: 8000 }, null)).toBe(V16.unsupportedRuntime);
  expect(['vllm-mlx', 'splash', 'lmstudio'].map(runtime => statusMessage('unsupported_contract', {}, runtime as RuntimeKind))).toEqual([
    'vllm-mlx returned an unsupported status response.', 'Splash returned an unsupported status response.', 'LM Studio returned an unsupported model inventory.']);
  expect(statusMessage('loading', {}, 'splash', { model: 'incoai/Qwen3.8-27B-Splash' })).toBe('Loading Qwen3.8-27B-Splash…');
  expect(statusMessage('loading', {}, 'splash')).toBe('Loading the model…');
});

test('every status reason has a callout and a line for every runtime, from its params alone', () => {
  for (const reason of STATUS_REASONS) for (const runtime of [...RUNTIMES, null]) for (const params of every(reason)) {
    const copy = statusCopy(reason, params, runtime), line = statusMessage(reason, params, runtime);
    for (const text of [copy.title, copy.detail, line]) {
      expect(text, `${reason} ${runtime}`).toMatch(/^\S.*\S$/);
      expect(text, `${reason} ${runtime}`).not.toMatch(/undefined|null|NaN|\[object|VRAM/);
    }
    expect(['info', 'warning', 'critical']).toContain(copy.severity);
  }
  expect(statusCopy('runtime_changed', { detected: 'vllm-mlx', port: 8000 }, 'splash')).toEqual({ severity: 'warning', title: 'Looks like vllm-mlx now',
    detail: 'Splash is chosen, but vllm-mlx answers on :8000. Scope never switches on its own.', action: 'Switch to vllm-mlx' });
  expect(statusMessage('runtime_changed', { detected: 'splash', port: 8000 }, 'vllm-mlx')).toBe('Looks like Splash now. vllm-mlx is chosen, but Splash answers on :8000. Scope never switches on its own.');
  expect(statusCopy('recovering', { crashTrace: false }, 'splash').detail).not.toContain('crash trace');
  expect(statusCopy('not_admitting', { cause: 'memory' }, 'splash').detail).toContain('memory pressure');
  expect(statusCopy('runtime_unreachable', { port: 8001 }, 'omlx')).toMatchObject({ severity: 'critical', title: 'oMLX stopped responding', action: 'Connection…' });
});

test('frame, withhold and alert English covers every code; the sessions-era reasons are gone', () => {
  for (const reason of FRAME_REASONS) expect(frameMessage(reason)).toMatch(/^\S.*\.$/);
  expect(frameMessage('needs_approval')).not.toMatch(/chat|project|session/i);
  expect(frameMessage('contract_mismatch')).toContain('pause it and resume it');
  expect(WITHHOLD_REASONS.map(reason => withholdMessage(reason, null))).toEqual(['Server-wide · this chat uses another provider', 'Server-wide · chat model differs',
    'Server-wide · chat model unknown', 'Server-wide · runtime can’t count requests', 'Server-wide · overlapping requests', 'Server-wide · outside this chat’s turn',
    'Server-wide · joined mid-turn', 'Server-wide · not observed', 'Server-wide · auto-labelling off']);
  expect(withholdMessage('other-provider', 'splash')).toBe('This chat uses Splash · Watch Splash');
  expect(withholdMessage('all-requests', null)).toBe('Server-wide · all requests');
  for (const id of ALERT_IDS) {
    const { title, detail } = alertCopy(id, {});
    expect([title, detail].join(' '), id).not.toMatch(/undefined|null|NaN|VRAM|GPU/);
    expect(alertMessage(id, {})).toBe(title);
  }
  expect(alertMessage('swap-growth', { deltaBytes: 1024 ** 3 * 1.5, windowMs: 240_000 })).toBe('Swap grew 1.5 GiB in 4 min');
  expect(alertMessage('model-unloaded', { model: 'Example-27B' })).toBe('Example-27B was unloaded');
  expect(alertCopy('omlx-prefill-stall', { stalledMs: 45_000 }).detail).toBe('No change for 45 s · reported by oMLX');
});

test('the panel words a code-only body from its status code alone (it never reads compat)', () => {
  const full = fullSnapshot() as ReturnType<typeof fullSnapshot> & { compat: Record<string, unknown>; connection: Record<string, unknown> };
  const body = parseSnapshotV2({ ...full, status: { state: 'failing', reason: 'authentication_failed', params: { keySaved: false } },
    connection: { ...full.connection, runtime: 'omlx' }, compat: { ...full.compat, message: null, reason: undefined } })!;
  expect(fromSnapshot(body).message).toBe(V16.noKey('oMLX'));
  const fixture = parseSnapshotV2({ ...full, status: { state: 'failing', reason: 'authentication_failed', params: { keySaved: false } },
    connection: { ...full.connection, runtime: 'omlx' }, compat: { ...full.compat, message: 'A 1.x line the panel no longer reads.' } })!;
  expect(fromSnapshot(fixture).message).toBe(V16.noKey('oMLX'));
  const ready = parseSnapshotV2({ ...full, status: { state: 'ready', reason: null, params: {} }, compat: { ...full.compat, message: null } })!;
  expect(fromSnapshot(ready).message).toBeNull();
});
