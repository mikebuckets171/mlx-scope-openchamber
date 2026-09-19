import { expect, test } from 'bun:test';
import { contextBudget } from './context.ts';
import { parseTelemetrySnapshot } from '../src/telemetry.ts';
const reading=(extra={})=>parseTelemetrySnapshot({available:true,phase:'decode',activeRequests:1,promptTokens:52000,completionTokens:8000,contextWindow:100000,...extra});
test('context headroom includes output and reused input without claiming compaction',()=>{
 expect(contextBudget(reading({cachedTokens:40000}))).toEqual({used:60000,limit:100000,remaining:40000,percent:60});
 expect(contextBudget(reading({phase:'prefill',completionTokens:null}))?.used).toBe(52000);
});
test('context headroom rejects absent, conflicting, ambiguous or stale readings',()=>{
 for (const extra of [{promptTokens:null},{completionTokens:null},{contextWindow:50000},{contextWindow:0},{activeRequests:2},{phase:'idle'},{available:false}]) expect(contextBudget(reading(extra))).toBeNull();
});
