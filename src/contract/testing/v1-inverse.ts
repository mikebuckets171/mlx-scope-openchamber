// Test support only: the v2 → 1.x inverse and the 1.6 panel's rendered projection, for the lossless round trip.
import { connectionName } from '../../runtime.ts';
import type { TelemetrySnapshot } from '../../telemetry.ts';
import { traceGeometry } from '../../../panel/signal.ts';
import { v1Reason } from '../convert-v1.ts';
import type { SnapshotV2 } from '../snapshot.ts';
import { bytesToGB, fractionToPercent, msToSeconds } from '../units.ts';
import { cacheSplit, contextBudget, measurementReport, prefillEstimate, prefillReading, snapshotObservation } from './v1-panel.ts';

const v1Phase = (phase: string) => phase === 'not-loaded' ? 'notLoaded' : phase;

/** Rebuild the body a 1.6 service would have sent. Test-only: the 2a panel reads v2 plus `compat` directly. */
export const toV1 = (snapshot: SnapshotV2): Record<string, unknown> => {
  const c = snapshot.compat!, r = snapshot.runtime, q = r.request, averages = r.server.averages, cache = r.server.cache, link = c.connection;
  const available = snapshot.status.state === 'ready' || snapshot.status.state === 'degraded';
  const runtime = 'runtime' in c ? c.runtime : snapshot.connection.runtime, splash = runtime === 'splash';
  const last = snapshot.completions.items.at(-1), host = snapshot.host, mac = host?.mac;
  return {
    available, reason: c.reason ?? v1Reason(snapshot.status.state, snapshot.status.reason), message: c.message, runtime,
    phase: c.phase ?? v1Phase(r.phase),
    connection: link && { selected: link.selected, label: link.selected === null ? null : snapshot.connection.label,
      runtime: snapshot.connection.runtime, generation: link.generation, choices: snapshot.connection.choices,
      diagnostic: link.diagnostic, coverage: link.coverage, engine: snapshot.connection.engine ?? null, host: snapshot.connection.host ?? null },
    catalog: r.catalog.map(model => ({ name: model.name, loaded: model.loaded, format: model.format, contextWindow: model.contextWindowTokens })),
    modelID: c.modelID, sessionStatsState: c.statsState,
    liveDecodeTPS: q?.decodeTps ?? null, livePrefillTPS: q?.prefillTps ?? null,
    sessionAverageDecodeTPS: splash ? null : averages?.decodeTps ?? null, sessionAveragePrefillTPS: splash ? null : averages?.prefillTps ?? null,
    sessionCacheEfficiencyPercent: fractionToPercent(averages?.cacheEfficiencyFraction),
    promptTokens: q?.promptTokens ?? null, cachedTokens: q?.cachedTokens ?? null, completionTokens: q?.outputTokens ?? null,
    prefillProgress: q?.prefillFraction ?? null, prefillProcessedTokens: q?.prefillProcessedTokens ?? null,
    prefillTotalTokens: q?.prefillTotalTokens ?? null, prefillProgressStale: q?.prefillStale === true,
    prefillETASeconds: msToSeconds(q?.prefillEtaMs), elapsedSeconds: msToSeconds(q?.elapsedMs),
    activeRequests: r.server.active, queuedRequests: r.server.queued, contextWindow: c.contextWindow,
    memory: r.memory.processBytes != null || r.memory.modelBytes != null
      ? { activeGB: bytesToGB(r.memory.processBytes), peakGB: null, modelGB: bytesToGB(r.memory.modelBytes), cacheGB: null } : null,
    sessionBank: cache || c.lastMissReason ? { hot: { totalGB: bytesToGB(cache?.ramBytes), entries: cache?.ramEntries ?? null },
      cold: cache?.ssdBytes != null || cache?.ssdEntries != null ? { totalGB: bytesToGB(cache.ssdBytes), entries: cache.ssdEntries ?? null } : null,
      lastMissReason: c.lastMissReason } : null,
    lifetime: !splash && (averages?.requestsTotal != null || averages?.uptimeMs != null) ? { requestsTotal: averages.requestsTotal ?? null,
      promptTokensTotal: null, completionTokensTotal: null, cachedTokensTotal: null, uptimeSeconds: msToSeconds(averages.uptimeMs) } : null,
    serverStats: splash && available ? { ready: snapshot.status.reason !== 'loading', aggregateDecodeTokensPerSecond: averages?.decodeTps ?? null,
      completedRequests: averages?.requestsTotal ?? null, failedRequests: averages?.failedTotal ?? null,
      metalCurrentGB: bytesToGB(r.memory.metalBytes), metalPeakGB: bytesToGB(r.memory.metalPeakBytes) } : null,
    lastRequest: last ? { model: last.model, tokensPerSecond: last.decodeTps ?? null, ttftSeconds: msToSeconds(last.ttftMs),
      promptTokens: last.promptTokens ?? null, cachedTokens: last.cachedTokens ?? null, outputTokens: last.outputTokens ?? null, finishedAt: last.finishedAt } : null,
    memoryPressureLevel: c.guardLevel, memoryPressureSource: null, sampledAt: r.sampledAt ?? snapshot.serverNow, traceEpoch: c.traceEpoch,
    residentModels: r.residency.map(model => ({ id: model.model, phase: v1Phase(model.phase), activeRequests: model.active ?? null,
      queuedRequests: model.queued ?? null, allocationGB: bytesToGB(model.bytes), tokensPerSecond: model.decodeTps ?? model.prefillTps ?? null,
      prefillProgress: model.prefillFraction ?? null, progressStale: model.prefillStale === true })),
    residentModelCount: r.residencyCount ?? null,
    system: host && { platform: host.platform ?? 'Host', cpuModel: host.cpuModel ?? null, logicalCores: host.logicalCores ?? null,
      cpuPercent: fractionToPercent(host.cpuFraction), memoryUsedGB: bytesToGB(host.memUsedBytes), memoryTotalGB: bytesToGB(host.memTotalBytes),
      macOS: mac ? { wiredGB: bytesToGB(mac.wiredBytes), compressedGB: bytesToGB(mac.compressedBytes), swapUsedGB: bytesToGB(mac.swapUsedBytes),
        sampledAt: mac.sampledAt } : null, sampledAt: host.sampledAt },
  };
};

// The 1.6 panel's formatters (panel/main.ts, insights-view.ts, report.ts, saved-view.ts, capture-view.ts at v1.6.1), en-US.
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const rate = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
type N = number | null | undefined;
const shown = (value: N) => value == null ? null : [decimal.format(value), rate.format(value), compact.format(value), value.toFixed(1), Number(value.toFixed(2))];
const gib = (gb: N) => gb == null ? null : gb * 1e9 / 1024 ** 3;
/** A meter: rounded label, the CSS width the browser serialises (6 significant digits), and the 0–100% chart y. */
const bar = (value: N) => value == null ? null
  : [Math.round(value), Number(Math.min(100, Math.max(0, value)).toPrecision(6)), (58 - value / 100 * 56).toFixed(2)];

/** Every value the 1.6 panel renders from one snapshot, at the precision it renders it. */
export const rendered = (s: TelemetrySnapshot, now: number) => {
  const current = s.available ? s : null, system = s.system, mac = system?.macOS ?? null, link = s.connection ?? null;
  const speed = s.phase === 'decode' ? s.liveDecodeTPS : s.phase === 'prefill' ? s.livePrefillTPS : null;
  const observation = snapshotObservation(s, false, null, now);
  return {
    exact: {
      available: s.available, reason: s.reason, message: s.message, phase: s.phase, runtime: s.runtime, modelID: s.modelID,
      statsState: s.sessionStatsState, stale: s.prefillProgressStale, sampledAt: s.sampledAt, traceEpoch: s.traceEpoch, guard: s.memoryPressureLevel,
      counts: [s.promptTokens, s.cachedTokens, s.completionTokens, s.prefillProcessedTokens, s.prefillTotalTokens, s.activeRequests,
        s.queuedRequests, s.contextWindow, s.residentModelCount, s.lifetime?.requestsTotal, s.serverStats?.completedRequests, s.serverStats?.failedRequests],
      connection: link, name: connectionName(s.runtime ?? link?.runtime, link), catalog: s.catalog ?? [],
      bank: s.sessionBank && { present: true, hot: s.sessionBank.hot?.entries ?? null, cold: s.sessionBank.cold?.entries ?? null, lookup: s.sessionBank.lastMissReason },
      memoryPresent: [s.memory?.activeGB != null, s.memory?.modelGB != null],
      ready: s.serverStats?.ready ?? null, lifetime: s.lifetime !== null,
      last: s.lastRequest && { model: s.lastRequest.model, prompt: s.lastRequest.promptTokens, cached: s.lastRequest.cachedTokens,
        output: s.lastRequest.outputTokens, finishedAt: s.lastRequest.finishedAt },
      residents: s.residentModels.map(model => ({ id: model.id, phase: model.phase, active: model.activeRequests, queued: model.queuedRequests,
        progress: model.prefillProgress, stale: model.progressStale, speed: shown(model.tokensPerSecond), allocated: shown(gib(model.allocationGB)) })),
      host: system && { platform: system.platform, cpuModel: system.cpuModel, cores: system.logicalCores, sampledAt: system.sampledAt, native: mac?.sampledAt ?? null },
    },
    formatted: {
      rates: [s.liveDecodeTPS, s.livePrefillTPS, s.sessionAverageDecodeTPS, s.sessionAveragePrefillTPS,
        s.serverStats?.aggregateDecodeTokensPerSecond, s.lastRequest?.tokensPerSecond].map(shown),
      percents: [s.sessionCacheEfficiencyPercent, s.prefillProgress == null ? null : s.prefillProgress * 100].map(bar),
      seconds: [s.elapsedSeconds, s.prefillETASeconds, s.lastRequest?.ttftSeconds, s.lifetime?.uptimeSeconds].map(shown),
      uptime: s.lifetime?.uptimeSeconds == null ? null : [Math.floor(s.lifetime.uptimeSeconds / 3600), Math.floor(s.lifetime.uptimeSeconds % 3600 / 60)],
      memory: [s.memory?.activeGB, s.memory?.modelGB, s.serverStats?.metalCurrentGB, s.serverStats?.metalPeakGB,
        s.sessionBank?.hot?.totalGB, s.sessionBank?.cold?.totalGB].map(value => shown(gib(value))),
      host: system && { cpu: bar(system.cpuPercent), used: shown(gib(system.memoryUsedGB)), total: shown(gib(system.memoryTotalGB)),
        share: bar(system.memoryUsedGB == null || system.memoryTotalGB == null || system.memoryTotalGB <= 0 ? null : system.memoryUsedGB / system.memoryTotalGB * 100),
        native: mac && [mac.wiredGB, mac.compressedGB, mac.swapUsedGB].map(value => shown(gib(value))) },
      progress: prefillReading(current), estimate: prefillEstimate(current), split: cacheSplit(current), budget: contextBudget(s),
      report: measurementReport(s, system ?? null, false, 'test', now),
      saved: { ...observation, measurements: Object.fromEntries(Object.entries(observation.measurements)
        .map(([key, value]) => [key, value == null ? value : Number(value.toFixed(2)).toLocaleString('en-US')])) },
      chart: speed == null ? null : traceGeometry([{ at: s.sampledAt - 1_000, rate: speed, phase: 'decode', segment: 1 },
        { at: s.sampledAt, rate: speed, phase: 'decode', segment: 1 }], s.sampledAt),
    },
  };
};
