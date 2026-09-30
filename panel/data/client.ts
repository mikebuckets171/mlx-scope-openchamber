import type { HostClient } from '@openchamber/sdk';
import { obj } from '../../src/contract/guards.ts';
import { parseSnapshotV2, SURFACES, type Surface } from '../../src/contract/snapshot.ts';
import { CONTRACT_VERSION, ROUTES } from '../../src/contract/version.ts';
import { unavailableForHostError, unavailableForServiceResponse } from '../host-errors.ts';
import { CONTRACT_MISMATCH } from '../present/messages.ts';
import { frameReading, fromSnapshot, type Reading } from '../present/reading.ts';

/** `mark`/`attr` are pre-encoded comma lists (src/contract/query.ts encodeMarks/encodeAttrs); `tier` defaults to full. */
export type SnapshotQuery = { provider?: string; runtime?: string; frame: string; surface: string; since?: number;
  tier?: 'glance' | 'full'; detail?: 'server'; mark?: string; attr?: string };
const OFFSET_SAMPLES = 5;

/** 8 hex characters per frame mount, memory only: the service's lease key. `getRandomValues` works on plain HTTP hosts. */
export const frameId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(4)), byte => byte.toString(16).padStart(2, '0')).join('');

/** Contract §7: the tier (full unless asked), a surface the service knows (others are left out rather than rejected), the cursor, then marks and verdicts. */
export const snapshotQuery = (query: SnapshotQuery): Record<string, string> => ({
  ...query.provider ? { provider: query.provider } : {}, ...query.runtime ? { runtime: query.runtime } : {},
  frame: query.frame, ...SURFACES.includes(query.surface as Surface) ? { surface: query.surface } : {}, tier: query.tier ?? 'full',
  ...query.since !== undefined ? { since: String(query.since) } : {},
  ...query.detail ? { detail: query.detail } : {}, ...query.mark ? { mark: query.mark } : {}, ...query.attr ? { attr: query.attr } : {},
});

/** `serviceRequest` returns the body as a string (SPIKES S1); an object is accepted too. Malformed JSON throws. */
export const parseBody = (body: unknown): unknown => typeof body === 'string' ? JSON.parse(body) : body;

/** The response as a reading. A 404 on `/v2/*` or another contract version is a still-running older service. */
export const readResponse = (status: number, body: unknown, at: number): Reading => {
  if (status === 404) return frameReading('contract_mismatch', CONTRACT_MISMATCH, at);
  if (status !== 200) { const { reason, message } = unavailableForServiceResponse(status); return frameReading(reason, message, at); }
  const value = parseBody(body), version = obj(value)?.contractVersion;
  if (version !== undefined && version !== CONTRACT_VERSION) return frameReading('contract_mismatch', CONTRACT_MISMATCH, at);
  const snapshot = parseSnapshotV2(value);
  return snapshot ? fromSnapshot(snapshot) : frameReading('unparseable_snapshot', null, at);
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * One `/v2/snapshot` read. A host error or a malformed JSON body throws, as `serviceRequest` does; `failure` turns it
 * into a reading. The service clock's offset is the median of the last five `serverNow − rtt midpoint`.
 */
export class SnapshotClient {
  private offsets: number[] = [];
  constructor(private readonly host: Pick<HostClient, 'serviceRequest'>, private readonly clock: () => number = () => Date.now()) {}
  /** Service clock minus frame clock, in whole ms; 0 until a body arrives. */
  get offsetMs(): number { return this.offsets.length ? Math.round(median(this.offsets)) : 0; }
  /** The frame's current time on the service clock, which every `*At` field uses. */
  now(): number { return this.clock() + this.offsetMs; }
  async read(query: SnapshotQuery): Promise<Reading> {
    const sent = this.clock();
    const response = await this.host.serviceRequest({ method: 'GET', path: ROUTES.snapshot, query: snapshotQuery(query) });
    const received = this.clock(), reading = readResponse(response.status, response.body, this.now());
    if (reading.body) this.offsets = [...this.offsets, reading.body.serverNow - (sent + received) / 2].slice(-OFFSET_SAMPLES);
    return reading;
  }
  failure(error: unknown): Reading {
    const { reason, message } = unavailableForHostError(error);
    return frameReading(reason, message, this.now());
  }
}
