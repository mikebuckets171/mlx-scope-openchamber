import { connName, phaseLabel } from './copy.ts';
import { ago } from './format.ts';
import type { ScopeInput } from './scope.ts';

/** The masthead's status pill and the frame-wide state its accent follows (1.6 data-phase rules, plus --scope-bad). */
export interface HeaderView {
  phase: string; connection: string | null; updated: string;
  data: { phase: string; stale: boolean; approval: boolean; paused: boolean };
}
export type FrameCard = 'approval' | 'restart' | null;
/** Version skew and a pending approval replace every view: nothing below them would be a reading (S11). */
export const frameCard = (s: Pick<ScopeInput, 'frame'>): FrameCard =>
  s.frame?.reason === 'needs_approval' ? 'approval' : s.frame?.reason === 'contract_mismatch' ? 'restart' : null;

export const presentHeader = (s: ScopeInput): HeaderView => {
  const card = frameCard(s), snapshot = s.snapshot, status = snapshot?.status;
  const chatOnly = s.measurementScope !== 'engine' && s.chatIsLocal === false;
  const sampled = snapshot ? chatOnly ? snapshot.chat?.observedAtMs ?? snapshot.serverNow : snapshot.runtime.sampledAt ?? snapshot.serverNow : null;
  const updated = sampled === null ? 'No reading yet' : s.fresh && !s.paused ? `Updated ${ago(sampled, s.now)}` : `Last reading ${ago(sampled, s.now)}`;
  const base = { updated, data: { stale: false, approval: false, paused: s.paused } };
  if (card) return { ...base, phase: card === 'approval' ? 'Needs approval' : 'Needs restart', connection: null, data: { ...base.data, phase: 'detecting', approval: true } };
  if (!snapshot || !status) return { ...base, phase: s.frame ? 'Reconnecting' : 'Connecting', connection: connName(null), data: { ...base.data, phase: s.frame ? 'reconnecting' : 'detecting' } };
  const connection = chatOnly ? null : connName(snapshot.connection);
  if (s.paused) return { ...base, phase: 'Paused', connection, data: { ...base.data, phase: snapshot.runtime.phase } };
  if (s.frame || !s.fresh) return { ...base, phase: s.frame || s.stale ? 'Reconnecting' : 'Refreshing', connection, data: { ...base.data, phase: 'reconnecting', stale: true } };
  if (chatOnly) {
    const chat = snapshot.chat && snapshot.chat.observedAtMs <= s.now && snapshot.chat.expiresAtMs > s.now ? snapshot.chat : null;
    const phase = chat ? { generating: 'Generating', reasoning: 'Reasoning', tool: 'Using tools', waiting: 'Waiting', complete: 'Complete', cancelled: 'Stopped' }[chat.phase]
      : s.chatActivity === 'busy' ? 'Working' : 'Ready';
    return { ...base, phase, connection, data: { ...base.data, phase: chat?.phase ?? 'idle' } };
  }
  const phase = status.state === 'recovering' || status.reason === 'status_stale' ? 'reconnecting' : status.state === 'failing' ? 'offline'
    : status.state === 'detecting' || status.state === 'unconfigured' ? 'detecting' : snapshot.runtime.phase;
  return { ...base, phase: phaseLabel(snapshot), connection, data: { ...base.data, phase, stale: status.state === 'failing' } };
};
