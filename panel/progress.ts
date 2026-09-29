import type { Reading } from './present/reading.ts';

/** Current runtime stage only. Cache reuse is separate; elapsed time never advances this. */
export const prefillReading = (reading: Reading | null) => {
  if (reading?.phase !== 'prefill') return null;
  const request = reading.request, progress = request?.prefillFraction ?? null, stale = request?.prefillStale === true;
  if (progress === null || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    return { percent: null, remaining: 'Progress unavailable', completed: 'Waiting for token counts', counts: null, stale };
  }
  // Do not round an incomplete stage to 0% remaining / 100% complete.
  const left = (1 - progress) * 100;
  // Decimal percentages such as 58 / 100 may land a few ulps below an integer.
  const whole = progress === 1 ? 100 : Math.min(99, Math.floor(progress * 100 + Number.EPSILON * 100));
  const remaining = left > 0 && left < 1 ? '<1%' : `${100 - whole}%`;
  const completed = progress > 0.99 && progress < 1 ? '>99%' : `${whole}%`;
  const done = request?.prefillProcessedTokens ?? null, total = request?.prefillTotalTokens ?? null;
  const counts = done !== null && total !== null ? { done, total, remaining: total - done } : null;
  return { percent: progress * 100, remaining: `${remaining} remaining`, completed: `${completed} complete`, counts, stale };
};
