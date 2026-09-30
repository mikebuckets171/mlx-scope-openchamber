import type { AlertId, ReasonParams, WithholdReason } from '../../src/contract/reasons.ts';
import type { HistoryText } from '../present/history.ts';

// Test support only (ui-history): the mock's copy table (docs/design/2.0-mock.html WITHHOLD and ALERT) standing in for
// panel/present/copy.ts, so History and Captures tests pin the mock's own table.
const WITHHOLD: Record<WithholdReason | 'all-requests', string> = {
  'other-provider': 'this chat uses another runtime',
  'model-differs': 'chat model differs', 'model-unknown': 'chat model unknown', 'cannot-count': 'runtime can’t count requests', overlap: 'overlapping requests',
  'outside-turn': 'outside this chat’s turn', 'joined-mid-turn': 'joined mid-turn', 'not-observed': 'not observed', 'auto-off': 'auto-labelling off', 'all-requests': 'all requests',
};
const gib = (bytes: unknown): string => `${(Number(bytes) / 2 ** 30).toFixed(1)} GiB`;
const ALERT: Record<AlertId, (p: ReasonParams) => string> = {
  'runtime-lost': () => 'oMLX stopped responding', 'model-unloaded': p => `${p.model} was unloaded`,
  'pressure-warning': () => 'macOS memory pressure: warning', 'pressure-critical': () => 'macOS memory pressure: critical',
  'swap-growth': p => `Swap grew ${gib(p.deltaBytes)} in ${Math.round(Number(p.windowMs) / 60_000)} min`, thermal: () => 'Thermal pressure: heavy',
  'splash-recovering': () => 'Splash was recovering', 'omlx-prefill-stall': () => 'Prefill progress stopped moving', 'omlx-memory-guard': () => 'oMLX memory guard is active',
};
export const MOCK_TEXT: HistoryText = { withheld: reason => `Server-wide · ${WITHHOLD[reason]}`, alert: (id, params) => ALERT[id](params) };
