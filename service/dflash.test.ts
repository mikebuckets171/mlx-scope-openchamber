import { expect, test } from 'bun:test';
import { OmlxClient } from './omlx-client.ts';
import { resolveOmlxConfig } from './config.ts';
import { SessionInsights } from '../panel/insights.ts';
import { SignalHistory } from '../panel/signal.ts';

test('DFlash primary counters, stalls, new requests and fallback remain distinct', async () => {
  let now = 10_000, tokens = 64, id = 'private-dflash-a', age = 0.1, mode = 'primary';
  const paths: string[] = [];
  const client = new OmlxClient({now: () => now, readConfig: () => resolveOmlxConfig({env:{MLX_SCOPE_BASE_URL:'http://127.0.0.1:8000'},readText:async()=>null}),
    fetchImpl: (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path === '/health') return Response.json({status:'healthy',engine_pool:{model_count:1}});
      if (path === '/v1/models/status') return Response.json({models:[]});
      const model = {id:'fixture',active_requests:1,waiting_requests:0,activities:[] as object[],generating:[] as object[],prefilling:[] as object[]};
      if (mode === 'primary') model.activities = [{kind:'generate',detail:'private detail',request_id:id,token_count:tokens,elapsed_seconds:30+(now-10_000)/1000,last_activity_age_seconds:age}];
      else model.prefilling = [{request_id:'private-fallback',total:100,processed:20,speed:40,eta:2}];
      return Response.json({engines:{},active_models:{models:[model]}});
    }) as typeof fetch});
  const insights = new SessionInsights(), history = new SignalHistory();
  let sample = await client.snapshot();
  const epoch = sample.traceEpoch;
  expect(sample.phase).toBe('decode'); expect(sample.liveDecodeTPS).toBeNull();
  expect(sample.completionTokens).toBe(64); expect(sample.prefillProgress).toBeNull();
  expect(JSON.stringify(sample)).not.toContain('private-');
  insights.observe(sample); expect(insights.speed).toBeNull();
  for (let i=1; i<=2; i++) {
    now += 1000; tokens += 32; sample = await client.snapshot(); insights.observe(sample);
    expect(sample.traceEpoch).toBe(epoch);
  }
  expect(insights.speed?.tokensPerSecond).toBe(32);
  history.observe(sample,1000,insights.speed!.tokensPerSecond);
  expect(history.points[0]?.basis).toBe('observed');
  now += 1000; age = 6; sample = await client.snapshot(); insights.observe(sample);
  expect(sample.phase).toBe('processing'); expect(sample.liveDecodeTPS).toBeNull(); expect(insights.speed).toBeNull();
  now += 1000; age = 0; id = 'private-dflash-b'; tokens=16; sample = await client.snapshot(); insights.observe(sample);
  expect(sample.traceEpoch).not.toBe(epoch); expect(insights.speed).toBeNull();
  const secondEpoch = sample.traceEpoch;
  now += 1000; mode = 'fallback'; sample = await client.snapshot(); insights.observe(sample);
  expect(sample.traceEpoch).not.toBe(secondEpoch); expect(sample.phase).toBe('prefill');
  expect(sample.prefillProgress).toBe(0.2); expect(sample.livePrefillTPS).toBe(40); expect(insights.speed).toBeNull();
  expect(new Set(paths)).toEqual(new Set(['/health','/admin/api/activity','/admin/api/stats','/v1/models/status']));
});

test('observed and reported chart rates never join into one segment', () => {
  const history = new SignalHistory();
  const base = {available:true,phase:'decode',liveDecodeTPS:null,livePrefillTPS:null,modelID:'fixture',traceEpoch:1,sampledAt:1000} as import('../src/telemetry.ts').AvailableTelemetry;
  history.observe(base,500,32);
  history.observe({...base,sampledAt:1500},500,33);
  expect(history.points[1]!.segment).toBe(history.points[0]!.segment);
  history.observe({...base,sampledAt:2000,liveDecodeTPS:25},500,32);
  expect(history.points[2]!.segment).not.toBe(history.points[1]!.segment);
  expect(history.points[2]!.basis).toBeUndefined(); expect(history.points[2]!.rate).toBe(25);
});
