import { capturedRate, type Capture } from '../capture.ts';
import type { GenerationObservation } from '../insights.ts';
import type { Observation } from '../saved.ts';
import { EMPTY, gibFixed, gibText, looseRate, wholeText } from './format.ts';

/** The Compare tab's observation window: the current capture and its pinned reference. */
export interface CaptureView {
  state: string; percent: number;
  speed: string; coverage: string; duration: string; samples: string;
  memory: string; cpu: string; hostMemory: string; requests: string; resources: string; note: string;
  reference: { cpu: string; hostMemory: string; memory: string; requests: string } | null;
  referenceLabel: string; change: string;
}

const memory = (bytes: number | null) => bytes === null ? EMPTY : `${gibFixed(bytes, 1)} GiB`;
const cpuPair = (mean: number | null, peak: number | null) =>
  mean === null && peak === null ? EMPTY : `${mean === null ? EMPTY : mean.toFixed(1)} / ${peak === null ? EMPTY : peak.toFixed(1)} %`;
const memoryPair = (mean: number | null, peak: number | null) =>
  mean === null && peak === null ? EMPTY : `${mean === null ? EMPTY : gibFixed(mean, 1)} / ${peak === null ? EMPTY : gibFixed(peak, 1)} GiB`;

export const presentCapture = (current: Capture | null, baseline: Capture | null, recording: boolean, comparison: number | null): CaptureView | null => {
  if (!current) return null;
  const r = capturedRate(current), ref = capturedRate(baseline), resources = current.model.startsWith('resources:');
  return {
    state: recording ? `${Math.floor(current.seconds)} / ${current.targetSeconds}s` : current.status === 'finished' ? 'Captured' : 'Partial capture',
    percent: Math.min(100, current.seconds / current.targetSeconds * 100),
    speed: r === null ? EMPTY : `${r.toFixed(1)} tok/s`,
    coverage: resources ? 'Request speed needs live token counts' : `${current.decodeSeconds.toFixed(1)}s of recorded generation`,
    duration: `${current.seconds.toFixed(1)}s`, samples: `${current.samples} server readings · ${current.targetSeconds}s requested`,
    memory: memory(current.peakProcessBytes), cpu: cpuPair(current.meanCPU, current.peakCPU), hostMemory: memoryPair(current.meanMemoryBytes, current.peakMemoryBytes),
    requests: current.requestCountChange === null ? EMPTY : String(current.requestCountChange),
    resources: `${current.cpuSamples} CPU · ${current.memorySamples} RAM · ${current.processSamples} server memory readings`, note: current.note,
    reference: baseline && { cpu: cpuPair(baseline.meanCPU, baseline.peakCPU), hostMemory: memoryPair(baseline.meanMemoryBytes, baseline.peakMemoryBytes),
      memory: memory(baseline.peakProcessBytes), requests: baseline.requestCountChange === null ? EMPTY : String(baseline.requestCountChange) },
    referenceLabel: ref === null ? 'Pinned reference' : `Reference · ${ref.toFixed(1)} tok/s over ${baseline!.decodeSeconds.toFixed(1)}s`,
    change: comparison === null ? baseline?.model !== current.model ? 'Different recording' : resources ? 'Mac activity' : 'Record another window'
      : `${comparison >= 0 ? '+' : ''}${comparison.toFixed(1)}% change`,
  };
};

/** One recent-generation row: last seen values only, never a completion claim. */
export const presentGeneration = (record: GenerationObservation) => ({
  name: record.model.split('/').at(-1) ?? record.model, title: record.model,
  at: new Date(record.lastSeenAt).toISOString(), time: new Date(record.lastSeenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  speed: looseRate(record.averageTPS), tokens: `${record.outputTokens === null ? EMPTY : wholeText(record.outputTokens)} tokens last seen`,
  note: `${record.coverage === 'monitoring-gap' ? 'Monitoring gap' : 'No longer recorded'}${record.peakProcessBytes !== null ? ` · ${gibText(record.peakProcessBytes)} peak server memory` : ''}`,
});

/** A saved measurement as shown: two decimals at most, `<1` for a sliver of prefill left, a dash when not reported. */
export const savedValue = (key: string, value: number | null | undefined): string =>
  value == null ? EMPTY : key === 'prefillRemaining' && value > 0 && value < 1 ? '<1' : Number(value.toFixed(2)).toLocaleString();
export const savedState = (item: Observation): string => item.state === 'interrupted' ? 'Partial capture' : item.state === 'finished' ? 'Finished window'
  : item.state === 'held' ? 'Last reading' : 'Server snapshot';
export const referenceState = (item: Observation): string => item.referenceState === 'interrupted' ? 'Partial reference'
  : item.referenceState === 'finished' ? 'Finished reference' : 'Reference status not recorded';
