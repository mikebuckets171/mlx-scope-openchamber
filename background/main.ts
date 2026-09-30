import { connectHost } from '@openchamber/sdk';
import { resolveScope } from './scope.ts';

// Owner: scope-flip. The `/scope` background frame (≤ 25 KB, plan §4.1): the host loads it on demand for the slash
// command and it registers the resolver, nothing else. It exports nothing, so the bundle carries no module wrapper.
const host = connectHost();
host.onResolve(request => resolveScope(host, request));
