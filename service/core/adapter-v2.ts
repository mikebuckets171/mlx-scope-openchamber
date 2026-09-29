import type { Capabilities, CapabilityDescriptor } from '../../src/contract/capabilities.ts';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { Json } from '../../src/contract/guards.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { ConnectionV2, RuntimeV2, StatusV2 } from '../../src/contract/snapshot.ts';
import type { OmlxConfig } from '../config.ts';
import type { FetchImplementation } from '../http.ts';
import type { Exec } from '../lib/argv.ts';
import type { Confidence } from './registry.ts';

// The v2 adapter contract (docs/2.0/INTERFACES.md §2). Scaffold only: nothing constructs these yet. svc-2b moves
// DESCRIPTORS onto DescriptorV2 and bridges the 1.6 adapters; the ad-* tracks implement `create`.

export type Tier = 'glance' | 'full';
/** Plan §5.1 detection order; the hinted descriptor is tried first. mlx-lm is hint-only. */
export const DETECT_ORDER = ['/health', '/props', '/api/version', '/lmstudio-greeting', '/status', '/v1/models'] as const;
export type DetectProbe = typeof DETECT_ORDER[number];

/** One GET against the connection's loopback origin. `routeMissing` folds a 200 "Unexpected endpoint" body into 404. */
export interface RuntimeReply { status: number; body: Json | null; routeMissing: boolean }
export type RuntimeGet = (path: string) => Promise<RuntimeReply>;
/** Text GET (Prometheus); `maxBytes` defaults to the 2 MB http.ts cap. */
export type RuntimeGetText = (path: string, maxBytes?: number) => Promise<{ status: number; text: string }>;

/** What the frame asked for; adapters skip reads the tier or the Server tab (`detail`) does not need. */
export interface ReadContext { deadline: number; tier: Tier; detail: boolean }
/** A finished request as the adapter saw it. The completion ring assigns `seq`; verdicts and host co-factors come later. */
export type CompletionDraft = Omit<CompletionV2, 'seq' | 'verdict' | 'host'>;

export interface AdapterReadingV2 {
  at: number;                                // when the runtime was read (service clock); cached reads keep their time
  status: StatusV2;
  capabilities: Capabilities;                // narrowed to what this reading actually reports (P3)
  runtime: RuntimeV2;
  identity: Pick<ConnectionV2, 'version' | 'engine' | 'host'>;
  /** Opaque, never on the wire: a change bumps `connection.generation` (LM Studio `/api/v0/models` state, a reload). */
  generationKey?: string;
  completions: CompletionDraft[];            // finished since the previous read, oldest first
}

export interface AdapterV2 {
  read(context: ReadContext): Promise<AdapterReadingV2>;
  /** Cheap "still the same runtime" check behind re-detection; false or a throw starts a detection pass. */
  identity(): Promise<boolean>;
  /** Stops streams and pending timers; the slot drops the adapter afterwards. */
  dispose(): void;
}

export interface AdapterContextV2 {
  connection: { id: string; port: number };  // loopback only; the origin never enters a reading
  get: RuntimeGet;
  getText: RuntimeGetText;
  config: OmlxConfig;                        // oMLX admin login, the one non-GET (P1)
  fetchImpl: FetchImplementation;
  exec: Exec;                                // argv-allowlisted, absolute paths, no shell
  now: () => number;
  monotonic: () => number;
  timeoutMs: number;
  budgetMs: number;
}

export interface CadenceContext { activity: boolean; tier: Tier; recovering: boolean }
export interface DetectStep {
  probe: DetectProbe;
  confidence: Confidence;
  /** `follow` makes the descriptor's own second GET (LM Studio `/api/v1/models`, Ollama `/api/ps`). */
  match: (reply: RuntimeReply, follow: RuntimeGet) => boolean | Promise<boolean>;
}

export interface DescriptorV2 {
  id: RuntimeKind;
  hints: (id: string, name: string) => boolean;
  detect: readonly DetectStep[];
  cadence: (context: CadenceContext) => number;
  /** The most this runtime can report; each reading narrows it. */
  capabilities: readonly CapabilityDescriptor[];
  identityEveryMs: number;                   // 60 s; oMLX 300 s
  create: (context: AdapterContextV2) => AdapterV2;
}
