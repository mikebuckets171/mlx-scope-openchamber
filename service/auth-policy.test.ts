import { expect, test } from 'bun:test';
import { OmlxClient } from './omlx-client.ts';
import { resolveOmlxConfig } from './config.ts';

for (const policy of ['open', 'required', 'rejected-key', 'wrong-server'] as const) {
  test(`server authorization policy: ${policy}`, async () => {
    const requests: { path: string; method: string; headers: Headers }[] = [];
    const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname, headers = new Headers(init?.headers);
      requests.push({path, method: init?.method ?? 'GET', headers});
      if (path === '/health') return Response.json(policy === 'wrong-server' ? {status:'healthy'} : {status:'healthy',engine_pool:{model_count:0}});
      if (policy === 'required' || policy === 'rejected-key') return Response.json({}, {status:401});
      if (path === '/v1/models/status') return Response.json({models:[]});
      return Response.json({engines:{},active_models:{models:[]}});
    }) as typeof fetch;
    const client = new OmlxClient({fetchImpl, readConfig: () => resolveOmlxConfig({home:'/unused',env:{MLX_SCOPE_BASE_URL:'http://127.0.0.1:8000', ...(policy==='rejected-key' ? {MLX_SCOPE_API_KEY:'fixture-key'} : {})},readText:async()=>null})});
    const result = await client.snapshot();
    expect(result.available).toBe(policy==='open');
    expect(requests[0]!.path).toBe('/health');
    expect(requests[0]!.headers.has('Authorization')).toBe(false);
    if (policy==='wrong-server') expect(requests).toHaveLength(1);
    if (policy==='rejected-key') expect(requests.map(r=>r.path)).toEqual(['/health','/admin/api/login']);
    else expect(requests.every(r=>r.method==='GET' && !r.headers.has('Authorization') && !r.headers.has('Cookie'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-key');
  });
}
