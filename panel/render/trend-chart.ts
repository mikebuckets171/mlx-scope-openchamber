import type { TrendSeries, TrendV2 } from '../../src/contract/trend.ts';

// Owner: ui-history. Trend geometry: lines break at null buckets, only gaps[] are hatched ("Not observed · Scope wasn't
// open"), turn marks as ticks; nothing is interpolated and a chart needs ≥ 2 readings. Live keeps traceGeometry.

export interface TrendGeometry {
  segments: string[];                        // SVG path data, one per run of readings
  band: string[];                            // min–max area per segment
  gaps: Array<{ x: number; width: number }>;
  marks: Array<{ x: number; phase: 'started' | 'completed' | 'failure' }>;
  max: number;
}
export const trendGeometry = (trend: TrendV2, series: TrendSeries, width = 600, height = 120): TrendGeometry | null => {
  void trend; void series; void width; void height;
  return null;
};
