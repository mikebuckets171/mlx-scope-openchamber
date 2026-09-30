// Loopback stand-ins for local runtimes, for development measurements only. They answer a fixed synthetic model,
// never forward anything, and never start or contact a real runtime. The fake `lms` is a shell script that never
// runs the real CLI: `ps` and `runtime ls` print one synthetic row and exit, `log stream` prints one server-log record
// and then idles like the real stream, and anything else fails at once, so no one-shot ever waits out its timeout.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const FAKE_RUNTIMES = ['omlx', 'lmstudio'];
const MODEL = 'synthetic-model';

const omlx = (path, state) => {
  const activities = state.active ? [{ request_id: 'synthetic-request', kind: 'generate', detail: 'generating',
    token_count: Math.floor((Date.now() - state.began) / 1000 * 32), last_activity_age_seconds: 0.1 }] : [];
  if (path === '/health') return { status: 'healthy', engine_pool: { model_count: 1 } };
  if (path === '/v1/models/status') return { models: [] };
  if (path === '/api/status') {
    return { status: 'ok', version: '0.7.0', loaded_models: [MODEL], active_requests: activities.length, waiting_requests: 0 };
  }
  if (path === '/admin/api/activity') {
    return { engines: {}, active_models: { models: [{ id: MODEL, active_requests: activities.length, activities }] } };
  }
  return null;
};
const lmstudio = path => {
  if (path === '/lmstudio-greeting') return { lmstudio: true };
  if (path === '/api/v1/models') {
    return { models: [{ key: MODEL, type: 'llm', format: 'mlx', max_context_length: 8192,
      loaded_instances: [{ id: MODEL, config: { context_length: 4096 } }] }] };
  }
  if (path === '/api/v0/models') {
    return { object: 'list', data: [{ id: MODEL, type: 'llm', state: 'loaded', compatibility_type: 'mlx', max_context_length: 8192 }] };
  }
  return null;
};

/** A fake runtime server; `state.active` switches oMLX between generating and idle. Every request is reported. */
export const createFakeRuntime = (kind, state, onRequest) => createServer((request, response) => {
  request.resume();
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  onRequest(path);
  const body = kind === 'omlx' ? omlx(path, state) : lmstudio(path);
  response.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body ?? { error: 'not_found' }));
});

const quote = text => `'${text.replaceAll("'", `'\\''`)}'`;
// The Bionic fixture shapes (tests/fixtures/lmstudio/bionic-1.1.6), cut down to what the service reads.
const LMS_PS = JSON.stringify([{ type: 'llm', modelKey: MODEL, identifier: MODEL, format: 'safetensors', sizeBytes: 4_294_967_296,
  maxContextLength: 8192, contextLength: 4096, status: 'idle', queued: 0, parallel: 4 }]);
const LMS_RUNTIME_LS = ['LLM ENGINE                                  SELECTED    MODEL FORMAT',
  'mlx-llm-mac-arm64-apple-metal-advsimd@1.9.0    \u2713           MLX'];
const LMS_LOG = JSON.stringify({ timestamp: 1_767_225_600_000,
  data: { type: 'server.log', content: '[2026-01-01 00:00:00][INFO] synthetic', level: 'info' } });

/**
 * Makes `home` look like a running LM Studio home whose REST server is `port`, with a fake `lms` in its bin folder.
 * Each fake invocation appends its arguments and whether the server-info path was set to `invocationLog`, which must
 * lie outside `home`.
 */
export const installFakeLMStudio = async (home, port, invocationLog) => {
  const root = join(home, '.lmstudio');
  await mkdir(join(root, '.internal'), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, '.internal', 'http-server-config.json'), JSON.stringify({ port }));
  await writeFile(join(root, '.internal', 'http-server.json'), JSON.stringify({ port }));
  const lms = join(root, 'bin', 'lms');
  await writeFile(lms, [
    '#!/bin/sh',
    '# Fake lms for MLX Scope measurements. It never contacts or starts LM Studio.',
    `printf '%s|%s\\n' "$*" "\${LMS_API_SERVER_INFO_PATH:+set}" >> ${quote(invocationLog)}`,
    'case "$1" in',
    `  ps) printf '%s\\n' ${quote(LMS_PS)} ;;`,
    `  runtime) printf '%s\\n' ${LMS_RUNTIME_LS.map(quote).join(' ')} ;;`,
    `  log) printf '%s\\n' ${quote(LMS_LOG)}; exec /bin/sleep 600 ;;`,
    '  *) exit 64 ;;',
    'esac',
    '',
  ].join('\n'));
  await chmod(lms, 0o755);
};
