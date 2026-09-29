// The synthetic host's copy of the service bridge: tests/browser/server.ts bundles this for host.html, so the fixture
// answers `/v2/snapshot` with exactly the bodies the converter produces for the service.
import { toSnapshotV2 } from '../../src/contract/convert-v1.ts';

(globalThis as unknown as { ScopeConvert: unknown }).ScopeConvert = { toSnapshotV2 };
