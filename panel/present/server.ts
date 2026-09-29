import type { CompletionV2 } from '../../src/contract/completion.ts';
import { runtimeNames } from '../../src/contract/runtime.ts';
import { cacheSplit } from '../insights.ts';
import { count, decimalText, EMPTY, gibText, looseRate, percent, rate, uptime, wholeText } from './format.ts';
import { RESIDENT_PHASES } from './messages.ts';
import type { CatalogEntry, Reading, ReadingPhase } from './reading.ts';
import type { Scope } from './scope.ts';

/** The Server tab: runtime memory, session statistics and runtime details, all server-wide. */
export interface ServerView {
  memory: { title: string; processLabel: string; modelLabel: string; note: string; process: string; model: string; hidden: boolean; stale: boolean; source: string };
  session: { title: string; labels: [string, string, string]; values: [string, string, string]; warn: boolean; stale: boolean; state: string; uptime: string };
  details: { hidden: boolean; ssdCache: string; guard: string; lookup: string };
}
export interface ResidentRow { phase: ReadingPhase; name: string; title: string; label: string; reading: string; allocation: string }
export interface CatalogRow { name: string; loaded: boolean; state: string; format: string; formatLabel: string; context: string }
export interface InsightView {
  cache: {
    hidden: boolean; stale: boolean; reused: string; fresh: string; fill: number; available: boolean; barLabel: string;
    ram: string; ssd: string; bankState: string; requestState: string; scope: string; tiersHidden: boolean;
  };
  advisory: string;
  residents: { hidden: boolean; count: string; note: string; rows: ResidentRow[] };
  catalog: { hidden: boolean; title: string; count: string; note: string; rows: CatalogRow[] };
}

const GUARD = ['Not reported', 'Normal', 'Elevated', 'Critical'];

export const presentServer = (s: Scope): ServerView => {
  const { runtime, display, current, stale, logActivity, logRequest } = s, splash = runtime === 'splash';
  const stats = display?.splash, process = splash ? stats?.metalBytes : display?.memory.processBytes, model = splash ? stats?.metalPeakBytes : display?.memory.modelBytes;
  const statsState = stale ? 'stale' : current?.statsState ?? 'unavailable', uptimeMs = display?.lifetime?.uptimeMs;
  return {
    memory: {
      title: splash ? 'GPU memory (Metal)' : 'Runtime memory', processLabel: splash ? 'Now' : `${s.name} process footprint`, modelLabel: splash ? 'Peak' : 'Model allocation',
      note: splash ? 'As reported by Splash. Not the same as process memory.' : 'Reported totals can overlap; they are not per-chat memory.',
      process: gibText(process), model: gibText(model), hidden: process == null && model == null, stale,
      source: stale ? 'Last reading · not live' : `${s.name} · server-wide`,
    },
    session: {
      title: splash ? 'Requests' : logActivity ? 'Finished responses' : 'Server session',
      labels: [splash ? 'Server decode' : 'Decode average', splash ? 'Completed' : logActivity ? 'Last first token' : 'Prefill average',
        splash ? 'Failed' : logActivity ? 'Input reused' : 'Cache efficiency'],
      values: [rate(splash ? stats?.decodeTps ?? null : display?.averages?.decodeTps),
        splash ? count(stats?.completed) : logActivity ? logRequest?.ttftMs == null ? EMPTY : `${decimalText(logRequest.ttftMs / 1000)}s` : rate(display?.averages?.prefillTps),
        splash ? count(stats?.failed) : percent(display?.averages?.cacheFraction == null ? null : display.averages.cacheFraction * 100)],
      warn: splash && (stats?.failed ?? 0) > 0, stale: splash ? stale : statsState !== 'fresh',
      state: splash ? stale ? 'Last reading · not live' : 'Server decode is shared across all requests.'
        : statsState === 'fresh' ? logActivity ? 'Exact figures for responses that finished while MLX Scope was open' : 'Completed requests across all models'
          : statsState === 'stale' ? 'Last available totals · not live' : logActivity ? 'Figures appear after the first response finishes' : 'Session statistics unavailable',
      uptime: splash ? 'Since Splash started' : logActivity ? 'This session' : uptimeMs == null ? 'Since start / reset' : uptime(uptimeMs),
    },
    details: {
      // Runtime details list only oMLX-style internals; hidden when none are reported.
      hidden: display?.cache == null && display?.guardLevel == null && current?.request?.outputTokens == null,
      ssdCache: gibText(display?.cache?.ssdBytes),
      guard: display?.guardLevel == null ? 'Not reported' : GUARD[Math.min(3, display.guardLevel)] ?? 'Not reported',
      lookup: display?.lastMissReason?.replaceAll('_', ' ') ?? 'Not reported',
    },
  };
};

// Loaded first, then Splash-format models, then everything else; order is otherwise preserved.
const rank = (model: CatalogEntry) => model.loaded ? 0 : model.format === 'splash' ? 1 : 2;

/** Cache reuse, the loaded-model roster and the model inventory, from the newest reading only. */
export const presentInsights = (reading: Reading, lastRequest: CompletionV2 | null): InsightView => {
  const current = reading.available ? reading : null, request = current?.request;
  const runtimeName = current?.runtime ? runtimeNames[current.runtime] : 'Runtime';
  const lastResponse = request?.promptTokens == null && lastRequest?.promptTokens != null && lastRequest.cachedTokens != null ? lastRequest : null;
  const split = cacheSplit(request?.promptTokens, request?.cachedTokens) ?? (lastResponse ? cacheSplit(lastResponse.promptTokens, lastResponse.cachedTokens) : null);
  const bank = current?.cache ?? null;
  const models = current?.residents ?? [], reported = current?.residentCount ?? null;
  const splashHost = current?.runtime === 'lmstudio' && current.link?.engine === 'splash';
  const catalog = splashHost ? [...current.catalog].sort((a, b) => rank(a) - rank(b)) : current?.catalog ?? [];
  return {
    cache: {
      // Hidden for runtimes that report neither request reuse nor cache totals.
      hidden: current !== null && split === null && !bank, stale: !current,
      reused: split ? wholeText(split.reused) : EMPTY, fresh: split ? wholeText(split.fresh) : EMPTY, fill: split?.percent ?? 0, available: split !== null,
      barLabel: split ? `${wholeText(split.reused)} input tokens reused; ${wholeText(split.fresh)} not reused` : 'Cache reuse unavailable for the current request',
      ram: gibText(bank?.ramBytes), ssd: gibText(bank?.ssdBytes),
      bankState: bank ? current?.statsState === 'fresh' ? 'Server cache · categories can overlap' : 'Last cache totals · not live'
        : current ? 'Cache totals not reported by this runtime.' : 'Cache totals not live',
      requestState: split ? `${decimalText(split.percent)}% of input reused${lastResponse ? ' · last response' : ''}` : 'Waiting for the next request',
      scope: lastResponse ? 'Last response' : 'Current request', tiersHidden: current !== null && !bank,
    },
    advisory: current?.guardLevel && current.guardLevel >= 2
      ? `${runtimeName} memory guard elevated. This is the runtime’s guard, not macOS memory pressure.`
      : request?.prefillStale === true ? 'Prefill progress has not advanced. The stage estimate is withheld until fresh progress arrives.' : '',
    residents: {
      hidden: models.length === 0 || current?.link?.coverage === 'inventory',
      count: reported == null ? '' : `${reported} loaded`,
      note: (reported ?? 0) > models.length ? `Showing ${models.length} of ${reported} reported models. Read-only; no model switching.`
        : 'Reported models · not assigned to a selected chat',
      rows: models.map(model => {
        const fraction = model.prefillFraction;
        const progress = model.phase === 'prefill' && fraction !== null
          ? `${fraction < 1 && fraction > .99 ? '<1' : Math.max(0, 100 - Math.floor(fraction * 100 + Number.EPSILON * 100))}% left${model.stale ? ' · last reading' : ''}` : null;
        return { phase: model.phase, name: model.model.split('/').at(-1) ?? model.model, title: model.model, label: RESIDENT_PHASES[model.phase] ?? 'Unavailable',
          reading: progress ?? (model.tps !== null ? looseRate(model.tps)
            : [model.active === null ? null : `${model.active} active`, model.queued === null ? null : `${model.queued} queued`].filter(Boolean).join(' · ')),
          allocation: model.bytes === null ? '' : `${gibText(model.bytes)} allocated` };
      }),
    },
    catalog: {
      hidden: !current || current.runtime === 'splash' || catalog.length === 0 || (current.link?.coverage ?? 'requests') === 'requests' && !splashHost,
      title: current?.runtime === 'mlx-lm' ? 'Available models' : splashHost ? 'Splash models' : 'Model inventory',
      count: splashHost ? `${catalog.filter(model => model.format === 'splash').length} Splash · ${catalog.filter(model => model.loaded).length} loaded` : `${catalog.length} reported`,
      note: splashHost ? 'Load or switch models in Bionic. MLX Scope only watches.' : 'Listed models are not necessarily in use. Context is the configured or maximum length.',
      rows: catalog.map(model => ({ name: model.name, loaded: model.loaded === true, state: model.loaded === null ? '' : model.loaded ? 'Loaded' : 'Not loaded',
        format: model.format ?? '', formatLabel: model.format === 'splash' ? 'Splash' : model.format?.toUpperCase() ?? '',
        context: model.contextWindowTokens === null ? '' : `${wholeText(model.contextWindowTokens)} context` })),
    },
  };
};
