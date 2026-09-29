import { connectionName, PHASES } from './messages.ts';
import { oneDecimalText } from './format.ts';
import type { Reading } from './reading.ts';

/**
 * Stage 2a stub for the Work Status glance line (plan §5.8): phase, short model and the reported rate. No surface
 * renders it yet; Stage 8 adds the sparkline, chips, alerts and attribution tag.
 */
export interface GlanceView { phase: string; model: string | null; rate: string | null }

export const presentGlance = (reading: Reading): GlanceView => {
  if (!reading.available) return { phase: `Waiting for ${connectionName(reading.link?.runtime ?? null, reading.link)}`, model: null, rate: null };
  const rate = reading.phase === 'decode' ? reading.request?.decodeTps : reading.phase === 'prefill' ? reading.request?.prefillTps : undefined;
  return {
    phase: PHASES[reading.phase], model: reading.model?.split('/').at(-1) ?? null,
    rate: rate == null ? null : `${oneDecimalText(rate)} tok/s${reading.phase === 'prefill' ? ' prefill' : ''}`,
  };
};
