// Integrity tests for the oMLX fixture corpus (tests/fixtures/omlx/<version>/). They assert that every body parses,
// matches the upstream shape that SOURCE.md cites (SPIKES S6), stays under the route limit, and carries each
// privacy canary exactly where intended and nowhere else, so adapter tests can later prove none of them leaks.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
type Range = 'today' | 'yesterday' | '7d' | '30d' | '90d';
type Spec =
  | { status: 200 | 503; kind: 'health' }
  | { status: 200; kind: 'api-status' }
  | { status: 200; kind: 'usage'; range: Range; details: boolean; disabled?: true }
  | { status: 200; kind: 'activity' }
  | { status: 200; kind: 'stats' }
  | { status: 401 | 404 | 503; kind: 'detail'; detail: string }
  | { status: 422; kind: 'validation' };

const API_KEY_REQUIRED = { status: 401, kind: 'detail', detail: 'API key required' } as const;
const ADMIN_REQUIRED = { status: 401, kind: 'detail', detail: 'Admin authentication required' } as const;

const CORPUS: Record<string, Record<string, Spec>> = {
  '0.7.0rc1': {
    'health.healthy-loaded.json': { status: 200, kind: 'health' },
    'health.healthy-unloaded.json': { status: 200, kind: 'health' },
    'health.healthy-null-pool.json': { status: 200, kind: 'health' },
    'health.healthy-guard-off.json': { status: 200, kind: 'health' },
    'health.healthy-mcp.json': { status: 200, kind: 'health' },
    'health.loading.json': { status: 503, kind: 'health' },
    'api-status.idle.json': { status: 200, kind: 'api-status' },
    'api-status.busy.json': { status: 200, kind: 'api-status' },
    'api-status.sub-key.json': { status: 200, kind: 'api-status' },
    'api-status.source-install.json': { status: 200, kind: 'api-status' },
    'api-status.unauthorized.json': API_KEY_REQUIRED,
    'api-status.invalid-key.json': { status: 401, kind: 'detail', detail: 'Invalid API key' },
    'admin-api-usage.7d.json': { status: 200, kind: 'usage', range: '7d', details: false },
    'admin-api-usage.30d.json': { status: 200, kind: 'usage', range: '30d', details: false },
    'admin-api-usage.90d.json': { status: 200, kind: 'usage', range: '90d', details: false },
    'admin-api-usage.90d-many-models.json': { status: 200, kind: 'usage', range: '90d', details: false },
    'admin-api-usage.today-details.json': { status: 200, kind: 'usage', range: 'today', details: true },
    'admin-api-usage.yesterday-details.json': { status: 200, kind: 'usage', range: 'yesterday', details: true },
    'admin-api-usage.7d-details.json': { status: 200, kind: 'usage', range: '7d', details: true },
    'admin-api-usage.disabled.json': { status: 200, kind: 'usage', range: '7d', details: false, disabled: true },
    'admin-api-usage.unavailable.json': { status: 503, kind: 'detail', detail: 'Usage history unavailable' },
    'admin-api-usage.unauthorized.json': ADMIN_REQUIRED,
    'admin-api-usage.bad-range.json': { status: 422, kind: 'validation' },
    'admin-api-activity.idle.json': { status: 200, kind: 'activity' },
    'admin-api-activity.prefill.json': { status: 200, kind: 'activity' },
    'admin-api-activity.prefill-stalled.json': { status: 200, kind: 'activity' },
    'admin-api-activity.generating.json': { status: 200, kind: 'activity' },
    'admin-api-activity.waiting.json': { status: 200, kind: 'activity' },
    'admin-api-activity.pressure-soft.json': { status: 200, kind: 'activity' },
    'admin-api-activity.pressure-hard.json': { status: 200, kind: 'activity' },
    'admin-api-activity.guard-disabled.json': { status: 200, kind: 'activity' },
    'admin-api-activity.no-pool.json': { status: 200, kind: 'activity' },
    'admin-api-activity.loading.json': { status: 200, kind: 'activity' },
    'admin-api-activity.activities.json': { status: 200, kind: 'activity' },
    'admin-api-activity.unauthorized.json': ADMIN_REQUIRED,
    'admin-api-stats.canary.json': { status: 200, kind: 'stats' },
  },
  '0.6.4': {
    'health.healthy.json': { status: 200, kind: 'health' },
    'health.loading.json': { status: 503, kind: 'health' },
    'api-status.idle.json': { status: 200, kind: 'api-status' },
    'api-status.busy.json': { status: 200, kind: 'api-status' },
    'api-status.unauthorized.json': API_KEY_REQUIRED,
    'admin-api-usage.not-found.json': { status: 404, kind: 'detail', detail: 'Not Found' },
    'admin-api-activity.generating.json': { status: 200, kind: 'activity' },
    'admin-api-stats.canary.json': { status: 200, kind: 'stats' },
  },
};

/** Planted canaries (SOURCE.md "Privacy canaries"): the files each may appear in, and nowhere else. */
const CANARY_API_KEY = 'CANARY-API-KEY-7f3a';
const CANARY_HOST = 'CANARY-HOST-7f3a';
const CANARY_CLI = 'CANARY-CLI-7f3a';
const CANARY_PATH = 'CANARY-PATH-7f3a';
const CANARY_PORT = 32570;
const CANARY_REQUEST_ID = /^00000000-7f3a-4000-8000-[0-9a-f]{12}$/;
const STATS = 'admin-api-stats.canary.json';
/** Activity variants that carry request rows (prefilling, generating, waiting or activities). */
const WITH_ROWS = /^admin-api-activity\.(prefill|prefill-stalled|generating|waiting|pressure-soft|pressure-hard|activities)\.json$/;
/** For each canary, the exact set of files that must contain it: present there, absent everywhere else. */
const CANARY_HOMES: Record<string, (version: string, file: string) => boolean> = {
  [CANARY_API_KEY]: (_v, file) => file === STATS,
  [CANARY_HOST]: (_v, file) => file === STATS,
  [CANARY_CLI]: (_v, file) => file === STATS,
  [CANARY_PATH]: (v, file) => file === STATS || (v === '0.7.0rc1' && file === 'api-status.source-install.json'),
  '00000000-7f3a-4000-8000-': (_v, file) => WITH_ROWS.test(file),
};

const ROUTE_LIMIT_CHARS = 256_000;
const HEALTH_KEYS = ['status', 'default_model', 'engine_pool', 'mcp'];
const POOL_KEYS = ['model_count', 'loaded_count', 'final_ceiling', 'current_model_memory'];
const MCP_KEYS = ['enabled', 'servers_connected', 'servers_total', 'tools_available'];
const API_STATUS_KEYS = [
  'status', 'version', 'uptime_seconds', 'models_discovered', 'models_loaded', 'models_loading', 'default_model',
  'loaded_models', 'total_requests', 'active_requests', 'waiting_requests', 'total_prompt_tokens',
  'total_completion_tokens', 'total_cached_tokens', 'cache_efficiency', 'avg_prefill_tps', 'avg_generation_tps',
  'model_memory_used', 'model_memory_max', 'model_memory_used_formatted', 'model_memory_max_formatted',
  'custom_kernels', 'ane_prefill',
];
const KERNELS = ['bonsai', 'decode_fast', 'glm_moe_dsa', 'minimax_m3', 'qwen35_prefill'];
const ANE_MODEL_KEYS = [
  'attempted', 'configured', 'shed', 'mlp_layers', 'gdn_layers', 'dual_ane_layers', 'resident_programs',
  'tail_padding_min_tokens', 'model_id',
];
const USAGE_KEYS = [
  'range', 'start', 'end', 'timezone', 'retention_days', 'flush_seconds', 'enabled', 'available', 'dropped_requests',
  'totals', 'models', 'heatmap',
];
const SUMMARY_KEYS = [
  'requests', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'prefill_seconds', 'generation_seconds',
  'request_seconds', 'timed_requests', 'total_tokens', 'cache_efficiency', 'generation_tps', 'prefill_tps',
  'average_request_seconds',
];
const ACTIVE_MODELS_KEYS = [
  'models', 'model_memory_used', 'model_memory_max', 'memory_pressure', 'total_active_requests',
  'total_waiting_requests',
];
const PRESSURE_KEYS = [
  'enabled', 'current_bytes', 'soft_bytes', 'hard_bytes', 'current_formatted', 'soft_formatted', 'hard_formatted',
  'pressure_level',
];
const MODEL_ROW_KEYS_064 = [
  'id', 'estimated_size', 'estimated_size_formatted', 'actual_size', 'actual_size_formatted', 'pinned', 'is_loading',
  'loading_elapsed_seconds', 'loading_estimated_seconds', 'loading_remaining_seconds_estimate', 'active_requests',
  'waiting_requests', 'waiting', 'activities', 'prefilling', 'generating', 'idle_seconds', 'ttl_remaining_seconds',
  'dflash',
];
const MODEL_ROW_KEYS_070 = [...MODEL_ROW_KEYS_064, 'cluster'];
const PREFILL_KEYS = ['request_id', 'processed', 'total', 'speed', 'eta', 'elapsed', 'phase', 'detail'];
const PREFILL_EXTRAS = [
  'scored_tokens', 'selected_tokens', 'keep_percent', 'prompt_tokens', 'system_tokens', 'conversation_tokens',
  'cached_tokens',
];
const GENERATING_KEYS = [
  'request_id', 'elapsed_seconds', 'generated_tokens', 'tokens_per_second', 'last_activity_age_seconds',
  'prompt_tokens', 'max_tokens',
];
const WAITING_KEYS = ['request_id', 'queue_position', 'elapsed_seconds', 'prompt_tokens'];
const SNAPSHOT_KEYS = [
  'total_tokens_served', 'total_cached_tokens', 'cache_efficiency', 'total_prompt_tokens', 'total_completion_tokens',
  'total_requests', 'avg_prefill_tps', 'avg_generation_tps', 'uptime_seconds',
];
const STATS_KEYS = [...SNAPSHOT_KEYS, 'host', 'port', 'api_key', 'cli_prefix', 'engines', 'active_models', 'runtime_cache'];
const ENGINE_NAMES = ['mlx-lm', 'mlx-vlm', 'mlx-embeddings', 'mlx-audio'];
const RUNTIME_CACHE_KEYS = [
  'base_path', 'ssd_cache_dir', 'response_state_dir', 'models', 'total_num_files', 'total_size_bytes',
  'effective_block_sizes', 'disk_max_bytes', 'hot_cache_max_bytes', 'hot_cache_size_bytes', 'hot_cache_entries',
];
const RANGE_DAYS: Record<Range, number> = { today: 1, yesterday: 1, '7d': 7, '30d': 30, '90d': 90 };

const dir = (version: string) => join(import.meta.dir, version);
const text = (version: string, file: string) => readFileSync(join(dir(version), file), 'utf8');
const parse = (version: string, file: string) => JSON.parse(text(version, file)) as Json;

const obj = (value: Json | undefined): Obj => {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value)).toBe(true);
  return value as Obj;
};
const arr = (value: Json | undefined): Json[] => {
  expect(Array.isArray(value)).toBe(true);
  return value as Json[];
};
const count = (value: Json | undefined): number => {
  expect(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0).toBe(true);
  return value as number;
};
const amount = (value: Json | undefined): number => {
  expect(typeof value === 'number' && Number.isFinite(value) && value >= 0).toBe(true);
  return value as number;
};
const maybe = <T>(value: Json | undefined, check: (v: Json) => T): T | null => (value === null ? null : check(value as Json));
const str = (value: Json | undefined): string => {
  expect(typeof value).toBe('string');
  return value as string;
};
const keys = (value: Json | undefined, expected: string[]) => expect(Object.keys(obj(value))).toEqual(expected);
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(expected)));

function walk(value: Json, visit: (key: string, value: Json) => void): void {
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      walk(child, visit);
    }
  }
}

function checkHealth(body: Json, status: number): void {
  keys(body, HEALTH_KEYS);
  const b = obj(body);
  expect(b.status).toBe(status === 200 ? 'healthy' : 'loading');
  maybe(b.default_model, str);
  if (b.engine_pool !== null) {
    keys(b.engine_pool, POOL_KEYS);
    const pool = obj(b.engine_pool);
    POOL_KEYS.forEach((key) => count(pool[key]));
    expect(count(pool.loaded_count)).toBeLessThanOrEqual(count(pool.model_count));
  }
  if (b.mcp !== null) {
    keys(b.mcp, MCP_KEYS);
    expect(obj(b.mcp).enabled).toBe(true);
    MCP_KEYS.slice(1).forEach((key) => count(obj(b.mcp)[key]));
  }
}

function checkApiStatus(body: Json, version: string): void {
  expect(API_STATUS_KEYS).toHaveLength(23); // SPIKES S6: "Returns 23 keys"
  keys(body, API_STATUS_KEYS);
  const b = obj(body);
  expect(b.status).toBe('ok');
  expect(b.version).toBe(version);
  amount(b.uptime_seconds);
  for (const key of ['models_discovered', 'models_loaded', 'models_loading', 'total_requests', 'active_requests',
    'waiting_requests', 'total_prompt_tokens', 'total_completion_tokens', 'total_cached_tokens', 'model_memory_used']) count(b[key]);
  const loaded = arr(b.loaded_models).map(str);
  expect(count(b.models_loaded)).toBe(loaded.length);
  expect(loaded.length).toBeLessThanOrEqual(count(b.models_discovered));
  const efficiency = amount(b.cache_efficiency); // percent, not ratio
  expect(efficiency).toBeLessThanOrEqual(100);
  if (count(b.total_prompt_tokens) > 0) {
    const percent = count(b.total_cached_tokens) / count(b.total_prompt_tokens) * 100;
    expect(Math.abs(efficiency - percent)).toBeLessThanOrEqual(0.05 + 1e-9); // round(x, 1)
  }
  amount(b.avg_prefill_tps);
  amount(b.avg_generation_tps);
  const max = maybe(b.model_memory_max, count);
  expect(b.model_memory_used_formatted === '0B').toBe(b.model_memory_used === 0);
  expect(b.model_memory_max_formatted === 'unlimited').toBe(!max);
  keys(b.custom_kernels, KERNELS);
  for (const kernel of KERNELS) {
    keys(obj(b.custom_kernels)[kernel], ['available', 'import_error']);
    const entry = obj(obj(b.custom_kernels)[kernel]);
    expect(typeof entry.available).toBe('boolean');
    expect(entry.import_error === null).toBe(entry.available === true);
  }
  keys(b.ane_prefill, ['patch_available', 'configured_models', 'models']);
  const ane = obj(b.ane_prefill);
  const aneModels = arr(ane.models).map((model) => {
    keys(model, ANE_MODEL_KEYS);
    return obj(model);
  });
  expect(count(ane.configured_models)).toBe(aneModels.filter((model) => model.configured === true).length);
}

function checkSummary(value: Json, withModelId: boolean): Obj {
  keys(value, withModelId ? ['model_id', ...SUMMARY_KEYS] : SUMMARY_KEYS);
  const s = obj(value);
  for (const key of ['requests', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'timed_requests', 'total_tokens']) count(s[key]);
  for (const key of ['prefill_seconds', 'generation_seconds', 'request_seconds']) amount(s[key]);
  expect(s.total_tokens).toBe(count(s.prompt_tokens) + count(s.completion_tokens));
  expect(count(s.cached_tokens)).toBeLessThanOrEqual(count(s.prompt_tokens));
  expect(count(s.timed_requests)).toBeLessThanOrEqual(count(s.requests));
  const ratio = amount(s.cache_efficiency); // ratio 0–1, unlike /api/status
  expect(ratio).toBeLessThanOrEqual(1);
  if (count(s.prompt_tokens) > 0) close(ratio, count(s.cached_tokens) / count(s.prompt_tokens));
  expect(s.generation_tps === null).toBe(s.generation_seconds === 0);
  expect(s.prefill_tps === null).toBe(s.prefill_seconds === 0);
  expect(s.average_request_seconds === null).toBe(s.timed_requests === 0);
  if (s.generation_tps !== null) close(amount(s.generation_tps), count(s.completion_tokens) / amount(s.generation_seconds));
  return s;
}

function checkUsage(body: Json, spec: Extract<Spec, { kind: 'usage' }>): void {
  keys(body, spec.details ? [...USAGE_KEYS, 'daily', 'hourly'] : USAGE_KEYS);
  const b = obj(body);
  expect(b.range).toBe(spec.range);
  const localMidnight = /^\d{4}-\d\d-\d\dT00:00:00[+-]\d\d:\d\d$/;
  expect(str(b.start)).toMatch(localMidnight);
  expect(str(b.end)).toMatch(localMidnight);
  expect(Date.parse(str(b.end)) - Date.parse(str(b.start))).toBe(RANGE_DAYS[spec.range] * 86_400_000);
  expect(b.timezone).toBe('server local time');
  expect(b.retention_days).toBe(400);
  expect(b.flush_seconds).toBe(5);
  expect(b.enabled).toBe(spec.disabled !== true);
  expect(typeof b.available).toBe('boolean');
  count(b.dropped_requests);

  const totals = checkSummary(b.totals, false);
  const models = arr(b.models).map((model) => checkSummary(model, true));
  models.forEach((model) => expect(str(model.model_id)).toStartWith('Example-'));
  for (let i = 1; i < models.length; i += 1) expect(count(models[i - 1].total_tokens)).toBeGreaterThanOrEqual(count(models[i].total_tokens));
  for (const key of ['requests', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'timed_requests']) {
    expect(models.reduce((sum, model) => sum + count(model[key]), 0)).toBe(count(totals[key]));
  }

  const heatmap = arr(b.heatmap).map((day) => {
    keys(day, ['date', 'tokens']);
    const tokens = arr(obj(day).tokens).map(count);
    expect(tokens).toHaveLength(24);
    return { date: str(obj(day).date), sum: tokens.reduce((a, t) => a + t, 0) };
  });
  expect(heatmap).toHaveLength(RANGE_DAYS[spec.range]);
  expect(heatmap[0].date).toBe(str(b.start).slice(0, 10));
  expect(heatmap.reduce((a, day) => a + day.sum, 0)).toBe(count(totals.total_tokens));

  if (spec.disabled) {
    expect(b.available).toBe(false);
    expect(models).toHaveLength(0);
    expect(totals.requests).toBe(0);
  }
  if (!spec.details) return;
  const daily = arr(b.daily).map((day) => {
    const row = obj(day);
    keys(day, ['date', ...SUMMARY_KEYS]);
    checkSummary(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'date')), false);
    return row;
  });
  expect(daily.map((day) => day.date)).toEqual(heatmap.map((day) => day.date));
  daily.forEach((day, i) => expect(count(day.total_tokens)).toBe(heatmap[i].sum));
  const hourly = arr(b.hourly).map((hour) => {
    const row = obj(hour);
    keys(hour, ['timestamp_hour', ...SUMMARY_KEYS]);
    checkSummary(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'timestamp_hour')), false);
    return count(row.timestamp_hour);
  });
  hourly.forEach((ts, i) => {
    expect(ts % 3600).toBe(0);
    if (i > 0) expect(ts).toBeGreaterThan(hourly[i - 1]);
    expect(ts * 1000).toBeGreaterThanOrEqual(Date.parse(str(b.start)));
    expect(ts * 1000).toBeLessThan(Date.parse(str(b.end)));
  });
}

function checkActiveModels(value: Json, version: string): void {
  keys(value, ACTIVE_MODELS_KEYS);
  const a = obj(value);
  const rows = arr(a.models).map((row) => {
    keys(row, version === '0.6.4' ? MODEL_ROW_KEYS_064 : MODEL_ROW_KEYS_070);
    return obj(row);
  });
  const ids = rows.map((row) => str(row.id));
  expect(ids).toEqual([...ids].sort());
  ids.forEach((id) => expect(id).toStartWith('Example-'));
  for (const row of rows) {
    count(row.estimated_size);
    count(row.actual_size);
    expect(row.actual_size_formatted === null).toBe(row.actual_size === 0);
    expect(row.is_loading === true).toBe(row.loading_elapsed_seconds !== null);
    if (row.is_loading === true) expect(row.idle_seconds).toBeNull();
    const waiting = arr(row.waiting).map((item) => {
      keys(item, WAITING_KEYS);
      return obj(item);
    });
    expect(count(row.waiting_requests)).toBe(waiting.length);
    expect(waiting.map((item) => item.queue_position)).toEqual(waiting.map((_, i) => i + 1));
    const prefilling = arr(row.prefilling).map((item) => {
      const entry = obj(item);
      const names = Object.keys(entry);
      expect(names.slice(0, PREFILL_KEYS.length)).toEqual(PREFILL_KEYS);
      names.slice(PREFILL_KEYS.length).forEach((name) => expect(PREFILL_EXTRAS).toContain(name));
      expect(count(entry.processed)).toBeLessThan(count(entry.total));
      return entry;
    });
    const generating = arr(row.generating).map((item) => {
      keys(item, GENERATING_KEYS);
      const entry = obj(item);
      close(amount(entry.tokens_per_second), count(entry.generated_tokens) / amount(entry.elapsed_seconds));
      return entry;
    });
    const requestIds = generating.map((entry) => str(entry.request_id));
    expect(requestIds).toEqual([...requestIds].sort());
    const activities = arr(row.activities).map((item) => {
      const entry = obj(item);
      expect(Object.keys(entry).slice(0, 3)).toEqual(['request_id', 'kind', 'detail']);
      expect(Object.keys(entry).slice(-2)).toEqual(['elapsed_seconds', 'last_activity_age_seconds']);
      return entry;
    });
    expect(count(row.active_requests)).toBe(prefilling.length + generating.length + activities.length);
  }
  expect(a.total_active_requests).toBe(rows.reduce((sum, row) => sum + count(row.active_requests), 0));
  expect(a.total_waiting_requests).toBe(rows.reduce((sum, row) => sum + count(row.waiting_requests), 0));
  keys(a.memory_pressure, PRESSURE_KEYS);
  const p = obj(a.memory_pressure);
  if (p.enabled === true) {
    const current = count(p.current_bytes);
    const expected = current < count(p.soft_bytes) ? 'ok' : current < count(p.hard_bytes) ? 'soft' : 'hard';
    expect(p.pressure_level).toBe(expected);
    expect(a.model_memory_used).toBe(current);
    expect(count(a.model_memory_max)).toBeGreaterThan(count(p.hard_bytes));
  } else {
    expect(p).toEqual({
      enabled: false, current_bytes: 0, soft_bytes: 0, hard_bytes: 0, current_formatted: '0.0GB',
      soft_formatted: '0.0GB', hard_formatted: '0.0GB', pressure_level: 'ok',
    });
  }
}

function checkStats(body: Json, version: string): void {
  keys(body, STATS_KEYS);
  const b = obj(body);
  SNAPSHOT_KEYS.forEach((key) => amount(b[key]));
  keys(b.engines, ENGINE_NAMES);
  for (const name of ENGINE_NAMES) {
    keys(obj(b.engines)[name], ['name', 'version', 'commit', 'url']);
    expect(obj(obj(b.engines)[name]).name).toBe(name);
  }
  checkActiveModels(b.active_models, version);
  keys(b.runtime_cache, RUNTIME_CACHE_KEYS);
}

const versions = Object.keys(CORPUS);

describe('oMLX fixture corpus', () => {
  test.each(versions)('%s: folder holds exactly the listed fixtures plus SOURCE.md, each documented', (version) => {
    const files = readdirSync(dir(version)).sort();
    expect(files).toEqual([...Object.keys(CORPUS[version]), 'SOURCE.md'].sort());
    const source = text(version, 'SOURCE.md');
    for (const [file, spec] of Object.entries(CORPUS[version])) {
      expect(file).toMatch(/^[a-z-]+\.[a-z0-9-]+\.json$/);
      const line = source.split('\n').find((row) => row.startsWith(`| \`${file}\` |`));
      expect(line, `${version}/SOURCE.md documents ${file}`).toBeDefined();
      expect(line).toContain(spec.status === 200 ? '| 200 |' : `**${spec.status}**`);
    }
  });

  for (const version of versions) {
    describe(version, () => {
      for (const [file, spec] of Object.entries(CORPUS[version])) {
        test(`${file} parses as one compact line and matches the ${spec.kind} shape`, () => {
          const raw = text(version, file);
          expect(raw.endsWith('\n')).toBe(true);
          expect(raw.slice(0, -1)).not.toContain('\n');
          expect(raw.length).toBeLessThan(ROUTE_LIMIT_CHARS);
          const body = parse(version, file);
          switch (spec.kind) {
            case 'health': return checkHealth(body, spec.status);
            case 'api-status': return checkApiStatus(body, version);
            case 'usage': return checkUsage(body, spec);
            case 'activity': {
              keys(body, ['active_models']);
              return checkActiveModels(obj(body).active_models, version);
            }
            case 'stats': return checkStats(body, version);
            case 'detail': return expect(body).toEqual({ detail: spec.detail });
            case 'validation': {
              keys(body, ['detail']);
              const [error] = arr(obj(body).detail);
              keys(error, ['type', 'loc', 'msg', 'input', 'ctx']);
              expect(obj(error).type).toBe('literal_error');
              expect(obj(error).loc).toEqual(['query', 'range']);
              return;
            }
          }
        });
      }
    });
  }
});

describe('oMLX privacy canaries', () => {
  test.each(versions)('%s: /admin/api/stats carries every stats canary at its key', (version) => {
    const stats = obj(parse(version, STATS));
    expect(str(stats.api_key)).toContain(CANARY_API_KEY);
    expect(stats.host).toBe(CANARY_HOST);
    expect(stats.port).toBe(CANARY_PORT);
    expect(str(stats.cli_prefix)).toContain(CANARY_CLI);
    const cache = obj(stats.runtime_cache);
    for (const key of ['base_path', 'ssd_cache_dir', 'response_state_dir']) expect(str(cache[key])).toContain(CANARY_PATH);
  });

  test('0.7.0rc1: every custom_kernels import_error in the source-install status carries the path canary', () => {
    const kernels = obj(obj(parse('0.7.0rc1', 'api-status.source-install.json')).custom_kernels);
    for (const kernel of KERNELS) expect(str(obj(kernels[kernel]).import_error)).toContain(CANARY_PATH);
  });

  test('every request_id is a request-id canary, and every activity fixture with rows plants some', () => {
    for (const version of versions) {
      for (const file of Object.keys(CORPUS[version])) {
        const ids: string[] = [];
        walk(parse(version, file), (key, value) => { if (key === 'request_id') ids.push(str(value)); });
        ids.forEach((id) => expect(id).toMatch(CANARY_REQUEST_ID));
        expect(ids.length > 0, `${version}/${file} request ids`).toBe(WITH_ROWS.test(file));
      }
    }
  });

  test('each canary appears exactly in the files SOURCE.md names, and nowhere else', () => {
    for (const version of versions) {
      for (const file of Object.keys(CORPUS[version])) {
        const raw = text(version, file);
        for (const [canary, home] of Object.entries(CANARY_HOMES)) {
          expect(raw.includes(canary), `${canary} ${home(version, file) ? 'missing from' : 'leaked into'} ${version}/${file}`)
            .toBe(home(version, file));
        }
      }
    }
  });

  test('no real identifiers: fixture-only paths, Example-* models, no PIDs, no prompt text', () => {
    for (const version of versions) {
      for (const file of Object.keys(CORPUS[version])) {
        const raw = text(version, file);
        for (const match of raw.matchAll(/\/Users\/[^/"]*/g)) expect(match[0]).toBe('/Users/fixture');
        expect(raw).not.toContain('CANARY-PROMPT');
        walk(parse(version, file), (key, value) => {
          expect(key.toLowerCase()).not.toMatch(/^(pid|.*_pid|prompt|messages|content)$/);
          if (['default_model', 'model_id', 'id'].includes(key) && typeof value === 'string') expect(value).toStartWith('Example-');
          if (key === 'loaded_models') arr(value).forEach((id) => expect(str(id)).toStartWith('Example-'));
          if (key === 'port') expect(value).toBe(CANARY_PORT);
        });
      }
    }
  });
});
