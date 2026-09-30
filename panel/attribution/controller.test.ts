import { expect, test } from 'bun:test';
import type { SessionSnapshot } from '@openchamber/sdk';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import { tag8 } from '../../src/contract/hash.ts';
import { parseSnapshotQuery } from '../../src/contract/query.ts';
import { SnapshotClient } from '../data/client.ts';
import { Attribution } from './controller.ts';
import { body, CHAT, fakeHost, INSTANCE, OTHER, step, T0, type BodyOptions } from './testing.ts';
import { ALTERNATING, attributionWhy } from './why.ts';

// End to end in one frame: the real SDK's session events (with its replays), polls every 500 ms, and what reaches the
// wire. Times are ms after T0 on the service clock.
const RUNTIME = 'mlx-community/Qwen3.8-27B-4bit';
const reply = (seq: number, startedAt: number | null, finishedAt: number, value: Partial<CompletionV2> = {}) =>
  step({ seq, startedAt: startedAt === null ? null : T0 + startedAt, finishedAt: T0 + finishedAt, model: RUNTIME, ...value });

const setup = (options: { busy?: boolean; auto?: boolean } = {}) => {
  const fake = fakeHost(), sent: string[] = [];
  let now = T0, auto = options.auto ?? true, extra: Partial<BodyOptions> = {};
  fake.ready({ ...CHAT, busy: options.busy ?? false });
  const attribution = new Attribution({ host: fake.host, now: () => now, auto: () => auto });
  /** One poll at `ms`: send what is queued, acknowledge, then apply the reading. */
  const poll = (ms: number, active = 0, items: CompletionV2[] = []) => {
    now = T0 + ms;
    const query = attribution.query();
    sent.push(new URLSearchParams(query).toString());
    attribution.acknowledge();
    attribution.observe(body({ at: now, active, items, ...extra }));
  };
  const run = (from: number, to: number, active = 0) => { for (let ms = from; ms < to; ms += 500) poll(ms, active); };
  const chat = (ms: number, busy: boolean, session: SessionSnapshot = CHAT) => { now = T0 + ms; fake.transition({ ...session, busy }); };
  const wire = () => {
    const parsed = sent.map(value => parseSnapshotQuery(new URLSearchParams(value)));
    return { marks: parsed.flatMap(item => 'marks' in item ? item.marks : []), attrs: parsed.flatMap(item => 'attrs' in item ? item.attrs : []) };
  };
  return { fake, attribution, sent, poll, run, chat, wire, at: (ms: number) => { now = T0 + ms; },
    setAuto: (value: boolean) => { auto = value; }, setBody: (value: Partial<BodyOptions>) => { extra = value; } };
};
const verdicts = (s: ReturnType<typeof setup>) => s.wire().attrs.map(({ seq, attr, reason }) => `${seq}.${attr}.${reason ?? '-'}`);

test('replays (×3) on mount send nothing; the first live turn is marked and inferred', () => {
  const s = setup();
  s.poll(0); s.chat(100, false); s.chat(200, false);           // the mount replay, then two repeats
  s.run(500, 2_000);
  s.chat(2_000, true); s.run(2_000, 6_000, 1);
  s.poll(6_000, 0, [reply(1, 2_200, 5_900)]);
  expect(s.attribution.isPending(1)).toBe(true);                // the 1 s hold: no verdict yet
  s.chat(6_300, false); s.run(6_500, 9_000);
  expect(s.attribution.isPending(1)).toBe(false);
  expect(s.wire().marks).toEqual([{ phase: 'started', at: T0 + 2_000, tag: tag8(CHAT.id, INSTANCE) },
    { phase: 'completed', at: T0 + 6_300, tag: tag8(CHAT.id, INSTANCE) }]);
  expect(verdicts(s)).toEqual(['1.inferred.-']);
  expect(s.attribution.label({ seq: 1 })).toEqual({ kind: 'inferred' });
  expect(s.attribution.turn()).toMatchObject({ label: { kind: 'inferred' }, live: false, summary: { steps: 1, outputTokens: 400 } });
  // Nothing on the wire names the chat.
  expect(s.sent.join('\n')).not.toMatch(/ses_fixture|secret|Qwen|splish/i);
});

test('mounted mid-turn: that turn is joined-mid-turn and left to other frames; the next one is inferred', () => {
  const s = setup({ busy: true });
  s.run(0, 3_000, 1); s.poll(3_000, 0, [reply(1, -8_000, 2_900)]); s.chat(3_300, false); s.run(3_500, 5_000);
  expect(s.attribution.label({ seq: 1 })).toEqual({ kind: 'server-wide', reason: 'joined-mid-turn' });
  expect(s.attribution.turn()).toMatchObject({ label: { kind: 'server-wide', reason: 'joined-mid-turn' }, summary: null });
  s.chat(5_000, true); s.run(5_000, 9_000, 1); s.poll(9_000, 0, [reply(2, 5_200, 8_900)]); s.chat(9_200, false); s.run(9_500, 11_000);
  expect(verdicts(s)).toEqual(['2.inferred.-']);
  expect(s.wire().marks.map(mark => mark.phase)).toEqual(['completed', 'started', 'completed']);
});

test('a multi-step turn with a tool pause: both steps inferred and one turn summary', () => {
  const s = setup();
  s.run(0, 1_000); s.chat(1_000, true);
  s.run(1_000, 5_000, 1); s.poll(5_000, 0, [reply(1, 1_200, 4_900, { outputTokens: 600, decodeTps: 30, ttftMs: 300 })]);
  s.run(5_500, 6_500, 0);
  s.run(6_500, 10_000, 1); s.poll(10_000, 0, [reply(2, 6_600, 9_900, { outputTokens: 400, decodeTps: 40 })]);
  expect(s.attribution.turn()).toMatchObject({ live: true, label: { kind: 'inferred' } });
  s.chat(10_300, false); s.run(10_500, 12_000);
  expect(verdicts(s)).toEqual(['1.inferred.-', '2.inferred.-']);
  const turn = s.attribution.turn()!;
  expect(turn.summary).toMatchObject({ steps: 2, wallMs: 9_300, modelMs: 3_700 + 3_300, toolMs: 9_300 - 7_000, firstTtftMs: 300, outputTokens: 1_000 });
  expect(turn.summary!.decodeTps).toBeCloseTo(1_000 / (600 / 30 + 400 / 40), 6);
});

test('a background request after the turn (title or recap) is outside the turn', () => {
  const s = setup();
  s.run(0, 1_000); s.chat(1_000, true); s.run(1_000, 5_000, 1);
  s.poll(5_000, 0, [reply(1, 1_200, 4_900)]); s.chat(5_300, false);
  s.run(5_500, 6_800); s.run(6_800, 9_800, 1); s.poll(9_800, 0, [reply(2, 6_800, 9_700)]); s.run(10_000, 12_000);
  expect(verdicts(s)).toEqual(['1.inferred.-', '2.withheld.outside-turn']);
  expect(s.attribution.turn()!.summary).toMatchObject({ steps: 1 });
});

test('a gap in this frame’s readings across a step: not observed, and not sent', () => {
  const s = setup();
  s.run(0, 1_000); s.chat(1_000, true); s.run(1_000, 3_000, 1);
  s.run(6_000, 7_000, 1);                                      // no readings from 3.0 to 6.0 s
  s.poll(7_000, 0, [reply(1, 1_200, 6_900)]); s.chat(7_200, false); s.run(7_500, 9_000);
  expect(s.attribution.label({ seq: 1 })).toEqual({ kind: 'server-wide', reason: 'not-observed' });
  expect(verdicts(s)).toEqual([]);
  expect(s.attribution.turn()).toMatchObject({ summary: null, label: { kind: 'server-wide', reason: 'not-observed' } });
});

test('two requests at once withhold the step as overlap; one request of another chat inside the turn cannot be ruled out', () => {
  const s = setup();
  s.run(0, 1_000); s.chat(1_000, true); s.run(1_000, 3_000, 1); s.run(3_000, 5_000, 2);
  s.poll(5_000, 0, [reply(1, 1_200, 4_900)]);
  s.run(5_500, 7_000, 0); s.run(7_000, 8_000, 1); s.poll(8_000, 0, [reply(2, 7_000, 7_900)]);   // alternating in the pause
  s.chat(8_300, false); s.run(8_500, 10_000);
  expect(verdicts(s)).toEqual(['1.withheld.overlap', '2.inferred.-']);
  // S2: the second request may well be another chat's; the ⓘ says so.
  expect(attributionWhy({ kind: 'inferred' }, 'Splash', false).join(' ')).toContain(ALTERNATING);
});

test('provider, model and counting withhold with their reasons', () => {
  const cases: Array<[SessionSnapshot, Partial<BodyOptions>, string]> = [
    [{ ...CHAT, model: 'cloud/model' }, {}, '1.withheld.other-provider'],
    [{ ...CHAT, model: 'splish/publisher/Other-8bit' }, {}, '1.withheld.model-differs'],
    [{ ...CHAT, model: undefined }, {}, '1.withheld.model-unknown'],
    [CHAT, { active: null }, '1.withheld.cannot-count'],
  ];
  for (const [session, reading, expected] of cases) {
    const s = setup();
    s.setBody(reading); s.run(0, 1_000); s.chat(1_000, true, session); s.run(1_000, 3_000, 1);
    s.poll(3_000, 0, [reply(1, 1_200, 2_900)]); s.chat(3_200, false, session); s.run(3_500, 5_000);
    expect(verdicts(s)).toEqual([expected]);
  }
});

test('clock skew ±5 s: stamps on the service clock (SnapshotClient offset) keep verdicts exact', async () => {
  const run = async (skewMs: number, corrected: boolean) => {
    const fake = fakeHost(), sent: string[] = [];
    let service = T0, current = body({ at: T0 });
    const client = new SnapshotClient({ serviceRequest: async () => ({ status: 200, body: JSON.stringify(current) }) }, () => service + skewMs);
    fake.ready(CHAT);
    const attribution = new Attribution({ host: fake.host, now: corrected ? () => client.now() : () => service + skewMs });
    const poll = async (ms: number, active = 0, items: CompletionV2[] = []) => {
      service = T0 + ms; current = body({ at: service, active, items });
      await attribution.read({ read: query => { sent.push(new URLSearchParams({ ...query.mark ? { mark: query.mark } : {},
        ...query.attr ? { attr: query.attr } : {} }).toString()); return client.read(query); } }, { frame: 'deadbeef', surface: 'panel' });
    };
    const polls = async (from: number, to: number, active = 0) => { for (let ms = from; ms < to; ms += 500) await poll(ms, active); };
    const chat = (ms: number, busy: boolean) => { service = T0 + ms; fake.transition({ ...CHAT, busy }); };
    await polls(0, 1_000); chat(1_000, true); await polls(1_000, 5_000, 1);
    await poll(5_000, 0, [reply(1, 1_200, 4_900)]); chat(5_300, false);
    await polls(5_500, 6_000); await polls(6_000, 9_000, 1); await poll(9_000, 0, [reply(2, 6_000, 8_900)]); await polls(9_500, 11_000);
    return sent.flatMap(value => { const query = parseSnapshotQuery(new URLSearchParams(value)); return 'attrs' in query ? query.attrs : []; })
      .map(({ seq, attr, reason }) => `${seq}.${attr}.${reason ?? '-'}`);
  };
  for (const skew of [-5_000, 0, 5_000]) expect(await run(skew, true)).toEqual(['1.inferred.-', '2.withheld.outside-turn']);
  // Why the offset matters: stamped on a frame clock 5 s fast, the post-turn request would land inside the turn.
  expect(await run(5_000, false)).toContain('2.inferred.-');
});

test('a switch mid-reply cancels Next reply at once; later steps are not observed', () => {
  const s = setup();
  s.run(0, 1_000);
  expect(s.attribution.arm()).toMatchObject({ kind: 'armed' });
  s.chat(1_000, true); s.run(1_000, 3_000, 1);
  s.at(3_000); s.fake.session({ ...OTHER, busy: false });
  expect(s.attribution.nextReply).toEqual({ kind: 'cancelled', reason: 'switched' });
  s.run(3_000, 5_000, 1); s.poll(5_000, 0, [reply(1, 1_200, 4_900)]); s.run(5_500, 7_000);
  expect(s.attribution.label({ seq: 1 })).toEqual({ kind: 'server-wide', reason: 'not-observed' });
  expect(verdicts(s)).toEqual([]);
});

test('Next reply: armed steps reach the wire as `armed` and win over the auto verdict', () => {
  const s = setup();
  s.run(0, 1_000); s.attribution.arm(); s.chat(1_000, true);
  s.run(1_000, 3_000, 1);
  expect(s.attribution.live()).toEqual({ kind: 'armed' });
  s.poll(3_000, 0, [reply(1, 1_200, 2_900)]); s.chat(3_200, false); s.run(3_500, 5_000);
  expect(verdicts(s)).toEqual(['1.armed.-']);
  expect(s.attribution.label({ seq: 1 })).toEqual({ kind: 'armed' });
  expect(s.attribution.nextReply).toMatchObject({ kind: 'result', attributed: true, summary: { steps: 1 } });
  expect(s.attribution.turn()).toMatchObject({ label: { kind: 'armed' } });
});

test('auto-labelling off: server-wide · auto-off, while Next reply still measures', () => {
  const s = setup({ auto: false });
  s.run(0, 1_000); s.chat(1_000, true); s.run(1_000, 3_000, 1);
  expect(s.attribution.live()).toEqual({ kind: 'server-wide', reason: 'auto-off' });
  s.poll(3_000, 0, [reply(1, 1_200, 2_900)]); s.chat(3_200, false); s.run(3_500, 5_000);
  s.attribution.arm(); s.chat(5_000, true); s.run(5_000, 7_000, 1); s.poll(7_000, 0, [reply(2, 5_200, 6_900)]); s.chat(7_200, false); s.run(7_500, 9_000);
  expect(verdicts(s)).toEqual(['1.withheld.auto-off', '2.armed.-']);
});

test('hidden: no listening, Next reply cancelled, readings broken; shown again it rejoins mid-turn', () => {
  const s = setup();
  s.run(0, 1_000); s.attribution.arm(); s.chat(1_000, true); s.run(1_000, 2_000, 1);
  s.attribution.setVisible(false);
  expect(s.attribution.nextReply).toEqual({ kind: 'cancelled', reason: 'hidden' });
  expect(s.fake.listeners()).toBe(1);                          // the SDK's own; the feed has let go
  expect(s.attribution.frame().connected).toBe(false);
  s.chat(4_000, false); s.chat(5_000, true);                   // missed while hidden
  s.attribution.setVisible(true); s.run(8_000, 10_000, 1);
  expect(s.attribution.frame().windows.at(-1)).toMatchObject({ startedAt: null });
  s.poll(10_000, 0, [reply(1, 5_200, 9_900)]); s.chat(10_300, false); s.run(10_500, 12_000);
  expect(s.attribution.label({ seq: 1 })).toEqual({ kind: 'server-wide', reason: 'joined-mid-turn' });
  expect(s.wire().marks.map(mark => mark.phase)).toEqual(['started', 'completed']);
});

test('a new service instance drops queued verdicts and marks; a completion the service already labelled is not re-sent', () => {
  const s = setup();
  s.run(0, 1_000); s.chat(1_000, true); s.run(1_000, 3_000, 1);
  s.at(3_000); s.attribution.observe(body({ at: T0 + 3_000, active: 1, instance: '0a1b2c3d' }));
  s.chat(3_100, false);
  expect(s.attribution.query().mark).toBe(`completed.${T0 + 3_100}.${tag8(CHAT.id, '0a1b2c3d')}`);
  const s2 = setup();
  s2.run(0, 1_000); s2.chat(1_000, true); s2.run(1_000, 3_000, 1);
  s2.poll(3_000, 0, [reply(1, 1_200, 2_900, { verdict: { attr: 'withheld', reason: 'overlap', at: T0 } })]); s2.run(3_500, 5_000);
  expect(verdicts(s2)).toEqual([]);
  expect(s2.attribution.label({ seq: 1, verdict: { attr: 'withheld', reason: 'overlap', at: T0 } })).toEqual({ kind: 'server-wide', reason: 'overlap' });
});

test('a runtime that stops answering cancels Next reply; a failed poll breaks the readings', () => {
  const s = setup();
  s.run(0, 1_000); s.attribution.arm(); s.chat(1_000, true); s.run(1_000, 2_000, 1);
  s.setBody({ state: 'failing' }); s.poll(2_000, 1);
  expect(s.attribution.nextReply).toEqual({ kind: 'cancelled', reason: 'unavailable' });
  expect(s.attribution.live()).toBeNull();
  s.setBody({}); s.attribution.arm(); s.run(2_500, 3_000, 1);
  s.at(3_000); s.attribution.observe(null);
  expect(s.attribution.nextReply).toEqual({ kind: 'cancelled', reason: 'unavailable' });
  s.run(3_000, 5_000, 1); s.poll(5_000, 0, [reply(1, 1_200, 4_900)]); s.chat(5_300, false); s.run(5_500, 7_000);
  expect(s.attribution.label({ seq: 1 })).toEqual({ kind: 'server-wide', reason: 'not-observed' });
});

test('live label, Watch and the local-chat test', () => {
  const s = setup();
  s.setBody({ choices: ['splish', 'omlx'] });
  s.run(0, 1_000);
  expect(s.attribution.live()).toBeNull();
  expect(s.attribution.chatIsLocal()).toBe(true);
  expect(s.attribution.watchable()).toBeNull();
  s.chat(1_000, true); s.run(1_000, 2_000, 1);
  expect(s.attribution.live()).toEqual({ kind: 'inferred' });
  s.run(2_000, 2_500, 2);
  expect(s.attribution.live()).toEqual({ kind: 'server-wide', reason: 'overlap' });
  const omlx = { ...CHAT, model: 'omlx/Qwen3.8-27B-4bit' };
  s.chat(2_500, false); s.run(2_500, 3_000); s.fake.session(omlx);
  expect(s.attribution.watchable()).toBe('omlx');
  s.chat(3_000, true, omlx); s.run(3_000, 4_000, 1);
  expect(s.attribution.live()).toEqual({ kind: 'server-wide', reason: 'other-provider' });
  s.fake.session({ ...CHAT, busy: true, model: 'cloud/model' });
  expect(s.attribution.chatIsLocal()).toBe(false);
  expect(s.attribution.watchable()).toBeNull();
  s.attribution.dispose();
  expect(s.attribution.frame().chat).toBeNull();
});

test('read(): marks and verdicts ride on the poll, stay queued until a parsed body, and a host error is a failed poll', async () => {
  const fake = fakeHost(), queries: Array<Record<string, string>> = [];
  let now = T0, status = 200, fail = false, current = body({ at: T0 });
  fake.ready(CHAT);
  const client = new SnapshotClient({ serviceRequest: async request => {
    queries.push(request.query ?? {});
    if (fail) throw new Error('HOST_TIMEOUT');
    return { status, body: JSON.stringify(current) };
  } }, () => now);
  const attribution = new Attribution({ host: fake.host, now: () => client.now() });
  const poll = (ms: number, active = 0) => { now = T0 + ms; current = body({ at: now, active }); return attribution.read(client, { frame: 'deadbeef', surface: 'status', tier: 'glance' }); };
  await poll(0); now = T0 + 400; fake.transition({ ...CHAT, busy: true });
  status = 404; await poll(500, 1);                             // a still-running older service: no body, nothing dropped
  status = 200; await poll(1_000, 1);
  expect(queries.map(query => query.mark ?? '')).toEqual(['', `started.${T0 + 400}.${tag8(CHAT.id, INSTANCE)}`, `started.${T0 + 400}.${tag8(CHAT.id, INSTANCE)}`]);
  expect(queries[2]).toMatchObject({ frame: 'deadbeef', surface: 'status', tier: 'glance' });
  fail = true;
  await expect(poll(1_500, 1)).rejects.toThrow('HOST_TIMEOUT');
  expect(attribution.activity.covered(T0 + 1_000, T0 + 1_500)).toBe(false);
  fail = false; await poll(2_000, 1);
  expect(queries.at(-1)!.mark).toBeUndefined();
});
