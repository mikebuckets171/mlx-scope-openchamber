import type { Basis } from '../../src/contract/capabilities.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { phaseLabel, rtName } from './copy.ts';
import { BASIS_WORD } from './parts.ts';
import { dur, tps } from './format.ts';
import { liveSplashRate, modelOf } from './scope.ts';

export interface Speed {
  key: 'prefill' | 'generation'; label: string; value: string | null; basis: Basis;
  detail: string; active: boolean; average: string | null;
}
export interface SpeedsView { phase: string; model: string | null; speeds: Speed[]; averageTitle: string; averageNote: string; source: string }
export const SPLASH_SPEED_HELP = [
  'Prefill: prompt tokens ÷ reading time. Generation: kept output tokens ÷ generation time. Discarded drafts excluded.',
  'All Splash requests · ≥3 readings over 2–5 s. Windows shown per stage. Polling time is excluded.',
  'Overall averages use totals since model start. Engine speed is not chat delivery.',
];
export interface SpeedInput { snapshot: SnapshotV2 | null; fresh?: boolean; paused?: boolean; efficient?: boolean }
/** One instrument shared by Live, Compact and Session. Missing recent readings never borrow an average. */
export const presentSpeeds = ({ snapshot: s, fresh = true, paused = false, efficient = false }: SpeedInput): SpeedsView => {
  const r = s?.runtime, splash = s?.connection.runtime === 'splash';
  const usable = !!s && fresh && !paused && s.status.state === 'ready' && s.status.reason === null;
  const positive = (n: number | null | undefined): number | null => n != null && Number.isFinite(n) && n > 0 ? n : null;
  const speeds = (['prefill', 'generation'] as const).map(key => {
    const prefill = key === 'prefill', active = !!r && (r.phase === 'processing' || r.phase === (prefill ? 'prefill' : 'decode'));
    const current = !usable ? null : splash ? liveSplashRate(s, prefill ? 'prefill' : 'decode')
      : active && !(prefill && r!.request?.prefillStale) ? positive(prefill ? r!.request?.prefillTps : r!.request?.decodeTps) : null;
    const window = prefill ? r?.server.rates?.promptWindowMs ?? (r?.server.rates?.decodeTps === undefined ? r?.server.rates?.windowMs : undefined) : r?.server.rates?.windowMs;
    const basis = splash ? 'derived' : s?.capabilities[prefill ? 'request.prefillRate' : 'request.decodeRate']?.basis ?? 'reported';
    const detail = current !== null ? splash ? `Calculated · last ${dur(window!)}` : `${BASIS_WORD[basis] || 'From server'} · ${prefill ? 'reading this prompt' : 'average for this request'}`
      : paused ? 'Monitoring paused' : !s ? 'Waiting for server' : !fresh || s.status.state !== 'ready' || s.status.reason !== null ? 'Waiting for reading'
        : active ? splash && efficient ? 'Turn off Energy saving to see speeds' : 'Measuring…' : prefill ? 'No prompt being read' : 'No text being generated';
    const average = prefill ? r?.server.averages?.prefillTps : r?.server.averages?.decodeTps;
    return { key, label: prefill ? 'Prefill speed' : 'Generation speed', value: current === null ? null : tps(current),
      basis, detail, active: usable && active,
      average: average != null && Number.isFinite(average) ? tps(average) : null };
  });
  const phase = paused ? 'Paused' : !s ? 'Connecting' : !fresh ? 'Waiting for update'
    : splash && speeds.every(speed => speed.value !== null) ? 'Reading and generating' : phaseLabel(s) === 'Reading context' ? 'Reading prompt' : phaseLabel(s);
  return { phase, model: modelOf(s), speeds, averageTitle: 'Overall average', averageNote: `${splash ? 'Since this model started' : 'From server totals'}${!usable ? ' · last reading' : ''}`, source: rtName(s?.connection ?? null) };
};
