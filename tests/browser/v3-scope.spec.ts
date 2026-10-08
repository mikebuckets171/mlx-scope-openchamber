import { expect, test, type Page } from '@playwright/test';
import { chatKey } from '../../src/contract/chat-key.ts';

const queries = (page: Page) => page.evaluate(() => (window as any).previewQueries as Record<string, string>[]);
const newest = async (page: Page) => (await queries(page)).at(-1)!;

test('This chat follows the selected provider and sends only hashed chat and model identifiers', async ({ page }) => {
  await page.goto('/v2?state=decode&chat=local&surface=status');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('combobox', { name: 'Measurement scope' })).toHaveValue('chat');
  await expect.poll(async () => (await newest(page))?.provider).toBe('omlx');
  expect(await newest(page)).toMatchObject({ chat: chatKey('session', 'fixture-chat'), chatModel: chatKey('model', 'Example-27B-4bit'), chatBusy: '1' });
  await page.evaluate(() => (window as any).setPreviewSession({ id: 'second-private-session', title: 'Private title', busy: true, model: 'custom-provider/Another-Model' }));
  await expect.poll(async () => (await newest(page))?.provider).toBe('custom-provider');
  expect(await newest(page)).toMatchObject({ chat: chatKey('session', 'second-private-session'), chatModel: chatKey('model', 'Another-Model'), chatBusy: '1' });
  const sent = JSON.stringify(await queries(page));
  expect(sent).not.toMatch(/second-private-session|Private title|Another-Model|Example-27B/);
  await page.evaluate(() => (window as any).setPreviewSession({ id: 'second-private-session', title: 'Private title', busy: false, model: 'custom-provider/Another-Model' }));
  await expect.poll(async () => (await newest(page))?.chatBusy).toBeUndefined();
});

test('switching chat or model clears the old speed before polling and rejects its delayed response', async ({ page }) => {
  await page.goto('/v2?state=decode&chat=local');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await page.evaluate(() => { (window as any).previewDelay = true; });
  await frame.locator('#monitor-menu > summary').click();
  await frame.locator('#refresh').click();
  await expect.poll(() => page.evaluate(() => (window as any).previewDeferred.length)).toBe(1);
  await page.evaluate(() => {
    const w = window as any, body = w.ScopeStates.mockBody('decode', { now: Date.now() });
    body.runtime.request.decodeTps = 42; body.runtime.request.model = 'Second-Model';
    w.setPreviewPatch({ runtime: body.runtime });
    w.setPreviewSession({ id: 'new-chat', title: 'Another chat', busy: true, model: 'omlx/Second-Model' });
  });
  await expect(frame.locator('#rate')).toHaveCount(0);
  await page.evaluate(() => (window as any).previewDeferred.shift()());
  await expect(frame.locator('#rate')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).previewDeferred.length)).toBe(1);
  await page.evaluate(() => { const w = window as any; w.previewDelay = false; w.previewDeferred.splice(0).forEach((reply: () => void) => reply()); });
  await expect(frame.locator('#rate')).toHaveText('42.0');
  await expect(frame.locator('#model')).toContainText('Second-Model');
  expect(await newest(page)).toMatchObject({ chat: chatKey('session', 'new-chat'), chatModel: chatKey('model', 'Second-Model') });
});

test('scope choice persists across reload, keeps Whole engine independent, and follows again when changed back', async ({ page }) => {
  await page.goto('/v2?surface=status&state=decode&chat=local');
  const frame = page.frameLocator('iframe'), scope = frame.getByRole('combobox', { name: 'Measurement scope' });
  await expect(scope).toHaveValue('chat');
  await scope.selectOption('engine');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('pref.v2')!).measurementScope)).toBe('engine');
  await expect.poll(async () => (await newest(page))?.chat).toBeUndefined();
  expect((await newest(page))?.chatBusy).toBeUndefined();
  await page.reload();
  await expect(scope).toHaveValue('engine');
  await expect(frame.locator('.ws-measurement .ws-label')).toHaveText('Engine');
  await page.evaluate(() => (window as any).setPreviewSession({ id: 'cloud-chat', title: 'Cloud', busy: false, model: 'cloud-provider/cloud-model' }));
  await expect(frame.locator('#ws')).toHaveAttribute('data-mode', 'summary');
  await expect(scope).toHaveValue('engine');
  await scope.selectOption('chat');
  await expect(frame.locator('#ws')).toHaveAttribute('data-mode', 'non-local');
  await page.evaluate(() => (window as any).setPreviewSession({ id: 'local-again', title: 'Local', busy: true, model: 'omlx/Example-27B-4bit' }));
  await expect(scope).toHaveValue('chat');
  await expect.poll(async () => (await newest(page))?.chat).toBe(chatKey('session', 'local-again'));
});

for (const surface of ['status', 'page']) test(`a rejected scope preference remains usable and reports that it was not saved on ${surface}`, async ({ page }) => {
  await page.goto(`/v2?surface=${surface}&state=decode&chat=local&storage=fail`);
  const frame = page.frameLocator('iframe'), scope = frame.getByRole('combobox', { name: 'Measurement scope' });
  await expect(scope).toHaveValue('chat');
  await scope.selectOption('engine');
  await expect(scope).toHaveValue('engine');
  await expect(frame.locator(surface === 'status' ? '#ws-action-error' : '#action-status')).toContainText('could not save the preference');
  await expect(frame.locator('#rate')).toBeVisible();
  const before = (await queries(page)).length;
  await expect.poll(async () => (await queries(page)).length).toBeGreaterThan(before);
});

test('chat estimate, reasoning, tool waiting, short completion, and cancellation use explicit states', async ({ page }) => {
  await page.goto('/v2?surface=status&state=splash-decode&chat=local');
  const frame = page.frameLocator('iframe');
  const phase = async (phase: string, rate?: number) => page.evaluate(({ phase, rate }) => {
    const w = window as any, now = Date.now(), complete = phase === 'complete';
    w.setPreviewPatch({ chat: { scope: 'chat', basis: complete ? 'reported-output' : 'estimated-characters',
      timingBasis: complete ? 'completed-step' : 'delivery-window', phase, tokensPerSecond: rate,
      observedAtMs: now, expiresAtMs: now + 5_000, observation: { startedAtMs: now - 3_000, endedAtMs: now }, freshness: complete ? 'last' : 'live' } });
  }, { phase, rate });
  await phase('reasoning', 17.8);
  await expect(frame.locator('.ws-phase')).toHaveText('Reasoning');
  await expect(frame.locator('.ws-measurement .ws-label')).toHaveText('Chat · est.');
  await expect(frame.locator('#rate')).toHaveText('17.8');
  for (const [state, label] of [['tool', 'Using tools'], ['waiting', 'Waiting'], ['complete', 'Complete'], ['cancelled', 'Stopped']]) {
    await phase(state!);
    await expect(frame.locator('.ws-phase')).toHaveText(label!);
    await expect(frame.locator('.ws-measurement')).toHaveCount(0);
  }
  await phase('complete', 15.3);
  await expect(frame.locator('.ws-measurement .ws-label')).toHaveText('Last chat · avg.');
  await expect(frame.locator('.ws-measurement')).toHaveAttribute('data-live', 'false');
});

test('an unknown provider echoed by an unavailable connection never makes a cloud chat local', async ({ page }) => {
  await page.goto('/v2?state=decode&surface=status&chat=cloud');
  const frame = page.frameLocator('iframe');
  await page.evaluate(() => {
    const w = window as any, body = w.ScopeStates.mockBody('decode', { now: Date.now() });
    body.connection.id = 'cloud-provider';
    body.connection.choices = [{ id: 'omlx', label: 'Local oMLX', runtime: 'omlx' }];
    w.setPreviewPatch({ connection: body.connection, status: { state: 'unconfigured', reason: 'configuration_missing', params: {} } });
  });
  await expect.poll(() => page.evaluate(() => (window as any).previewRequests)).toBeGreaterThan(1);
  await expect(frame.locator('#ws')).toHaveAttribute('data-mode', 'non-local');
  await expect(frame.locator('#ws')).toHaveText('This chat is not using a local model');
});
