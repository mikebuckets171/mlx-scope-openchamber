import type { MarkPhase, TrendSeries, TrendV2 } from '../../src/contract/trend.ts';

// Owner: ui-history. Trend geometry: lines break at null buckets, only gaps[] are hatched ("Not observed · Scope wasn't
// open"), turn marks as ticks; nothing is interpolated and a chart needs ≥ 2 readings. Live keeps traceGeometry.

export interface TrendGeometry {
  segments: string[];                        // SVG path data, one per run of readings
  band: string[];                            // min–max area per segment
  gaps: Array<{ x: number; width: number }>;
  marks: Array<{ x: number; phase: 'started' | 'completed' | 'failure' }>;
  max: number;                               // the y-axis ceiling, a round number above the highest reading
  spans: Array<{ x: number; width: number }>;   // started → completed/failure (or now): this chat's turns
  readings: number;                          // buckets that hold a reading
  low: number; high: number;                 // lowest bucket minimum and highest bucket maximum
}
const INSET = 4;
/** A round ceiling 5 % above the highest reading, so the top of the band never touches the frame. */
export const trendCeiling = (max: number): number => Math.max(5, Math.ceil(max * 1.05 / 5) * 5);
const fixed = (value: number): string => value.toFixed(1);
const place = (trend: TrendV2, width: number) => (at: number): number =>
  INSET + Math.min(1, Math.max(0, (at - trend.startAt) / trend.windowMs)) * (width - 2 * INSET);

/** Spans no Scope view observed, in the chart's x units: drawn even when there are too few readings for a line. */
export const trendGaps = (trend: TrendV2, width = 600): TrendGeometry['gaps'] => {
  const x = place(trend, width);
  return trend.gaps.map(gap => ({ x: x(gap.fromAt), width: x(gap.toAt) - x(gap.fromAt) })).filter(gap => gap.width > 0);
};

export const trendGeometry = (trend: TrendV2, series: TrendSeries, width = 600, height = 120, ceiling?: number): TrendGeometry | null => {
  const buckets = trend.series[series]?.buckets ?? [], read = buckets.filter(bucket => bucket !== null);
  if (read.length < 2) return null;
  const high = Math.max(...read.map(bucket => bucket[1])), low = Math.min(...read.map(bucket => bucket[0]));
  const max = ceiling ?? trendCeiling(high), x = place(trend, width);
  const y = (value: number): string => fixed(height - INSET - Math.min(1, value / max) * (height - 2 * INSET));
  const segments: string[] = [], band: string[] = [];
  let run: Array<{ cx: string; bucket: [number, number, number] }> = [];
  const close = (): void => {
    if (!run.length) return;
    // A lone reading is a short dash, so it stays visible without inventing a neighbour.
    segments.push(run.length === 1 ? `M${fixed(Number(run[0]!.cx) - 1)} ${y(run[0]!.bucket[2])}H${fixed(Number(run[0]!.cx) + 1)}`
      : run.map((point, index) => `${index ? 'L' : 'M'}${point.cx} ${y(point.bucket[2])}`).join(' '));
    if (run.length > 1) band.push(`M${run.map(point => `${point.cx} ${y(point.bucket[1])}`).join(' L')} L${[...run].reverse().map(point => `${point.cx} ${y(point.bucket[0])}`).join(' L')}Z`);
    run = [];
  };
  buckets.forEach((bucket, index) => {
    if (!bucket) { close(); return; }
    run.push({ cx: fixed(x(trend.startAt + (index + 0.5) * trend.bucketMs)), bucket });
  });
  close();
  const inWindow = trend.marks.filter(mark => mark.at >= trend.startAt && mark.at <= trend.serverNow);
  const ends = (phase: MarkPhase): boolean => phase === 'completed' || phase === 'failure';
  const spans = inWindow.filter(mark => mark.phase === 'started').map(start => {
    const end = inWindow.find(mark => ends(mark.phase) && mark.at > start.at)?.at ?? trend.serverNow;
    return { x: x(start.at), width: Math.max(2, x(end) - x(start.at)) };
  });
  return { segments, band, gaps: trendGaps(trend, width), marks: inWindow.map(mark => ({ x: x(mark.at), phase: mark.phase })), max, spans, readings: read.length, low, high };
};
