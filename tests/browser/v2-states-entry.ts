// The 2.0 fixture host's copy of the mock states: tests/browser/server.ts bundles this for v2-host.html.
import { MOCK_STATES, mockBody, mockTitle } from '../../panel/testing/mock-states.ts';

(globalThis as unknown as { ScopeStates: unknown }).ScopeStates = { MOCK_STATES, mockBody, mockTitle };
