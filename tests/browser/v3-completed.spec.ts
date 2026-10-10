import { expect, test } from '@playwright/test';

for (const theme of ['light', 'obsidian']) for (const textSize of [16, 32]) {
  test(`completed native result keeps its real facts visible in ${theme} at ${textSize}px text`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 1100 });
    await page.goto(`/v2?surface=page&state=idle&chat=local&theme=${theme}&poll=500`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('.instrument-phase')).toBeVisible();
    await frame.locator('html').evaluate((e, size) => { (e as HTMLElement).style.fontSize = `${size}px`; }, textSize);
    await page.evaluate(() => {
      const w = window as any, now = Date.now(), body = w.ScopeStates.mockBody('idle', { now });
      const c = body.completions.items.at(-1);
      Object.assign(c, { seq: 58, basis: 'reported', startedAt: now - 49_000, finishedAt: now - 1_000,
        outputTokens: 1234, ttftMs: 850, decodeTps: 25.7 });
      body.completions.cursor = 58;
      w.setPreviewPatch({ completions: body.completions });
      w.setPreviewSession({ id: 'fixture-chat', busy: false, model: 'omlx/Example-27B-4bit' });
    });
    await expect(frame.locator('#rate')).toHaveText('25.7');
    await expect(frame.locator('.instrument-primary')).toHaveAttribute('data-live', 'false');
    const facts = frame.locator('#completed-facts');
    await expect(facts).toBeVisible();
    await expect(facts).toHaveAttribute('data-count', '3');
    await expect(facts).toContainText('1,234');
    await expect(facts).toContainText('48 s');
    await expect(facts).toContainText('0.85 s');
    await expect(facts.locator('strong[data-basis="derived"]')).toHaveText('48 s');
    await expect(frame.locator('#measurement-details')).not.toHaveAttribute('open');
    expect(await frame.locator('#scope').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });
}

for (const surface of ['status', 'page', 'compact']) for (const scope of ['chat', 'engine']) {
  test(`standalone failure clears ${scope} readings correctly on ${surface} while the runtime poll is held`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 950 });
    await page.clock.install();
    await page.addInitScript(({ scope, compact }) => {
      if (window.parent !== window) return;
      sessionStorage.setItem('pref.v2', JSON.stringify({ v: 2, history: false, measurementScope: scope }));
      if (compact) sessionStorage.setItem('view.compact', 'true');
    }, { scope, compact: surface === 'compact' });
    await page.goto(`/v2?surface=${surface === 'status' ? 'status' : 'page'}&state=decode&chat=local&poll=500`);
    const frame = page.frameLocator('iframe'), phase = surface === 'page' ? '.instrument-phase' : '.ws-phase';
    await expect(frame.locator('#rate')).toHaveText('26.4');
    // Establish a real lifecycle start after the initial busy replay.
    await page.evaluate(() => {
      const w = window as any;
      w.setPreviewSession({ id: 'fixture-chat', busy: false, model: 'omlx/Example-27B-4bit' });
      w.sendPreviewLifecycle('started');
    });
    await page.clock.fastForward(600);
    await expect(frame.locator('#rate')).toHaveText('26.4');
    await page.evaluate(() => { const w = window as any; w.previewDelay = true; w.sendPreviewLifecycle('failure'); });
    if (scope === 'engine') {
      await expect(frame.locator('#rate')).toHaveText('26.4');
      await expect(frame.locator(phase)).toHaveText('Generating');
    } else {
      await expect(frame.locator('#rate')).toHaveCount(0);
      await expect(frame.locator(phase)).toHaveText('Stopped');
    }
    // An end first called complete may sharpen to failure without a service response.
    await page.clock.fastForward(1);
    await page.evaluate(() => {
      const w = window as any; w.sendPreviewLifecycle('started'); w.sendPreviewLifecycle('completed'); w.sendPreviewLifecycle('failure');
    });
    if (scope === 'engine') {
      await expect(frame.locator('#rate')).toHaveText('26.4');
      await expect(frame.locator(phase)).toHaveText('Generating');
    } else {
      await expect(frame.locator('#rate')).toHaveCount(0);
      await expect(frame.locator(phase)).toHaveText('Stopped');
    }
    await expect.poll(() => page.evaluate(() => (window as any).previewDeferred.length)).toBeGreaterThan(0);
    await page.evaluate(() => {
      const w = window as any, now = Date.now(), body = w.ScopeStates.mockBody('idle', { now });
      const completion = body.completions.items.at(-1);
      Object.assign(completion, { seq: 59, basis: 'reported', finishedAt: now, decodeTps: 27.7 });
      body.completions.cursor = 59;
      w.previewDelay = false; w.setPreviewState('idle'); w.setPreviewPatch({ completions: body.completions });
      w.setPreviewSession({ id: 'next-idle-chat', busy: false, model: 'omlx/Example-27B-4bit' });
      w.previewDeferred.splice(0).forEach((reply: () => void) => reply());
    });
    await page.clock.fastForward(600);
    await expect(frame.locator('#rate')).toHaveText('27.7');
    await expect(frame.locator(surface === 'page' ? '.instrument-primary' : '.ws-measurement')).toHaveAttribute('data-live', 'false');
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });
}

for (const chat of ['local']) {
  test(`completed ${chat} chat shows step timing without borrowing runtime facts`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 1100 });
    await page.goto(`/v2?surface=page&state=decode&chat=${chat}&poll=500`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('.instrument-phase')).toBeVisible();
    await frame.locator('html').evaluate(e => { (e as HTMLElement).style.fontSize = '32px'; });
    await page.evaluate(() => {
      const now = Date.now();
      (window as any).setPreviewSession({ id: 'fixture-chat', busy: false, model: 'omlx/Example-27B-4bit' });
      (window as any).setPreviewPatch({ chat: { scope: 'chat', basis: 'reported-output', timingBasis: 'completed-step',
        phase: 'complete', tokensPerSecond: 7.2, observedAtMs: now, expiresAtMs: now + 5_000,
        observation: { startedAtMs: now - 3_000, endedAtMs: now }, freshness: 'last' } });
    });
    await expect(frame.locator('#rate')).toHaveText('7.2');
    await expect(frame.locator('.instrument-source')).toContainText('Last chat · avg.');
    const facts = frame.locator('#completed-facts');
    await expect(facts).toBeVisible();
    await expect(facts).toHaveAttribute('data-count', '1');
    await expect(facts).toContainText('Last chat result');
    await expect(facts).toContainText('Step duration');
    await expect(facts).toContainText('3.0 s');
    await expect(facts).not.toContainText('Output');
    await expect(facts).not.toContainText('First token');
    await expect(frame.locator('#engine-facts')).toHaveCount(0);
    expect(await frame.locator('#scope').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });
}

for (const surface of ['status', 'page', 'compact']) {
  test(`a same-model idle chat switch keeps the previous native result engine-wide on ${surface}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 950 });
    await page.clock.install();
    if (surface === 'compact') await page.addInitScript(() => {
      if (window.parent === window) sessionStorage.setItem('view.compact', 'true');
    });
    await page.goto(`/v2?surface=${surface === 'status' ? 'status' : 'page'}&state=decode&chat=local&poll=500`);
    const frame = page.frameLocator('iframe'), label = surface === 'page' ? '.instrument-source' : '.ws-label';
    await expect(frame.locator('#rate')).toHaveText('26.4');
    await page.clock.fastForward(5_100);
    await page.evaluate(() => {
      const w = window as any, now = Date.now(), body = w.ScopeStates.mockBody('idle', { now });
      const completion = body.completions.items.at(-1);
      Object.assign(completion, { seq: 59, basis: 'reported', startedAt: now - 3_000, finishedAt: now - 1_000,
        decodeTps: 27.7, verdict: { attr: 'inferred', at: now } });
      body.completions.cursor = 59;
      w.setPreviewState('idle'); w.setPreviewPatch({ completions: body.completions });
      w.setPreviewSession({ id: 'fixture-chat', busy: false, model: 'omlx/Example-27B-4bit' });
    });
    await page.clock.fastForward(600);
    await expect(frame.locator('#rate')).toHaveText('27.7');
    await expect(frame.locator(label)).toContainText('Last chat · matched · avg.');
    await page.evaluate(() => (window as any).setPreviewSession({ id: 'different-idle-chat', busy: false, model: 'omlx/Example-27B-4bit' }));
    await page.clock.fastForward(600);
    await expect(frame.locator('#rate')).toHaveText('27.7');
    await expect(frame.locator(label)).toContainText('Last engine · avg.');
    await expect(frame.locator(label)).not.toContainText('chat · matched');
    await expect(frame.locator(surface === 'page' ? '.instrument-primary' : '.ws-measurement')).toHaveAttribute('data-live', 'false');
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });
}


for (const surface of ['status', 'page']) for (const chat of ['local']) {
  test(`idle completed ${chat} result survives telemetry expiry on ${surface} and clears on a new reply`, async ({ page }) => {
    await page.clock.install();
    await page.goto(`/v2?surface=${surface}&state=idle&chat=${chat}&poll=500`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator(surface === 'status' ? '.ws-phase' : '.instrument-phase')).toBeVisible();
    await page.evaluate(() => {
      const w = window as any, now = Date.now();
      w.setPreviewSession({ id: 'fixture-chat', busy: false, model: 'omlx/Example-27B-4bit' });
      w.setPreviewPatch({ chat: { scope: 'chat', basis: 'reported-output', timingBasis: 'completed-step', phase: 'complete',
        tokensPerSecond: 7.2, observedAtMs: now, expiresAtMs: now + 5_000,
        observation: { startedAtMs: now - 3_000, endedAtMs: now }, freshness: 'last' } });
    });
    await page.clock.fastForward(600);
    await expect(frame.locator('#rate')).toHaveText('7.2');
    await page.evaluate(() => (window as any).setPreviewPatch({ chat: null }));
    await page.clock.fastForward(21_000);
    await expect(frame.locator('#rate')).toHaveText('7.2');
    await expect(frame.locator(surface === 'status' ? '.ws-measurement' : '.instrument-primary')).toHaveAttribute('data-live', 'false');
    await expect(frame.locator(surface === 'status' ? '.ws-label' : '.instrument-source')).toContainText('Last chat · avg.');
    if (surface === 'page') {
      await expect(frame.locator('#completed-facts')).toContainText('Step duration');
      await expect(frame.locator('.instrument-measure time')).toContainText('Finished');
      await expect(frame.locator('.instrument-measure time')).not.toContainText('just now');
    }
    await page.evaluate(() => {
      const w = window as any; w.previewHold = true;
      w.setPreviewSession({ id: 'fixture-chat', busy: true, model: 'omlx/Example-27B-4bit' });
    });
    await expect(frame.locator('#rate')).toHaveCount(0);
    await expect(frame.locator('#completed-facts')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });
}

for (const surface of ['status', 'page']) {
  test(`an in-flight completed result cannot return after a new reply starts on ${surface}`, async ({ page }) => {
    await page.clock.install();
    await page.goto(`/v2?surface=${surface}&state=idle&chat=local&poll=500`);
    await page.evaluate(() => (window as any).setPreviewSession({ id: 'fixture-chat', busy: false, model: 'omlx/Example-27B-4bit' }));
    const frame = page.frameLocator('iframe');
    await page.evaluate(() => {
      const now = Date.now();
      (window as any).setPreviewPatch({ chat: { scope: 'chat', basis: 'reported-output', timingBasis: 'completed-step', phase: 'complete',
        tokensPerSecond: 7.2, observedAtMs: now, expiresAtMs: now + 5_000,
        observation: { startedAtMs: now - 3_000, endedAtMs: now }, freshness: 'last' } });
    });
    await page.clock.fastForward(600);
    await expect(frame.locator('#rate')).toHaveText('7.2');
    await page.evaluate(() => { (window as any).previewDelay = true; });
    await page.clock.fastForward(600);
    await expect.poll(() => page.evaluate(() => (window as any).previewDeferred.length)).toBeGreaterThan(0);
    await page.evaluate(() => {
      const w = window as any;
      w.setPreviewSession({ id: 'fixture-chat', busy: true, model: 'omlx/Example-27B-4bit' });
    });
    await expect(frame.locator('#rate')).toHaveCount(0);
    await page.evaluate(() => {
      const w = window as any; w.setPreviewPatch({ chat: null }); w.previewDelay = false;
      w.previewDeferred.splice(0).forEach((reply: () => void) => reply());
    });
    await page.clock.fastForward(600);
    await expect(frame.locator('#rate')).toHaveCount(0);
    await expect(frame.locator('#completed-facts')).toHaveCount(0);
    await expect(frame.locator(surface === 'status' ? '.ws-phase' : '.instrument-phase')).toHaveText('Waiting');
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });
}


for (const surface of ['status', 'page']) for (const oldPhase of ['generating', 'complete']) {
  test(`lifecycle start clears an old ${oldPhase} chat reading on ${surface} before a held poll responds`, async ({ page }) => {
    await page.clock.install();
    await page.goto(`/v2?surface=${surface}&state=idle&chat=local&poll=500`);
    await page.evaluate(() => (window as any).setPreviewSession({ id: 'fixture-chat', busy: false, model: 'omlx/Example-27B-4bit' }));
    const frame = page.frameLocator('iframe');
    await page.evaluate(phase => {
      const now = Date.now(), complete = phase === 'complete';
      (window as any).setPreviewPatch({ chat: { scope: 'chat', basis: complete ? 'reported-output' : 'estimated-characters',
        timingBasis: complete ? 'completed-step' : 'delivery-window', phase, tokensPerSecond: 7.2,
        observedAtMs: now, expiresAtMs: now + 5_000,
        observation: { startedAtMs: now - 3_000, endedAtMs: now }, freshness: complete ? 'last' : 'live' } });
    }, oldPhase);
    await page.clock.fastForward(600);
    await expect(frame.locator('#rate')).toHaveText('7.2');
    await page.evaluate(() => { const w = window as any; w.previewHold = true; w.sendPreviewLifecycle('started'); });
    // The host busy snapshot has not changed and the service supplies no new response.
    await expect(frame.locator('#rate')).toHaveCount(0);
    await expect(frame.locator('#completed-facts')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });
}

for (const surface of ['status', 'page']) {
  test(`a late busy hint preserves the newer completed step after lifecycle start on ${surface}`, async ({ page }) => {
    await page.clock.install();
    await page.goto(`/v2?surface=${surface}&state=idle&chat=local&poll=500`);
    const frame = page.frameLocator('iframe'), phase = surface === 'status' ? '.ws-phase' : '.instrument-phase';
    // The idle session must reach a mounted panel; an update sent before it subscribes is not replayed.
    await expect(frame.locator(phase)).toBeVisible();
    await page.evaluate(() => (window as any).setPreviewSession({ id: 'fixture-chat', busy: false, model: 'omlx/Example-27B-4bit' }));
    await page.evaluate(() => {
      const now = Date.now();
      (window as any).setPreviewPatch({ chat: { scope: 'chat', basis: 'reported-output', timingBasis: 'completed-step', phase: 'complete',
        tokensPerSecond: 7.2, observedAtMs: now, expiresAtMs: now + 5_000,
        observation: { startedAtMs: now - 3_000, endedAtMs: now }, freshness: 'last' } });
    });
    await page.clock.fastForward(600);
    await expect(frame.locator('#rate')).toHaveText('7.2');
    await page.evaluate(() => { const w = window as any; w.previewDelay = true; w.sendPreviewLifecycle('started'); });
    await expect(frame.locator('#rate')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).previewDeferred.length)).toBeGreaterThan(0);
    await page.clock.fastForward(1_100);
    await page.evaluate(() => {
      const w = window as any, now = Date.now(); w.previewDelay = false;
      w.setPreviewPatch({ chat: { scope: 'chat', basis: 'reported-output', timingBasis: 'completed-step', phase: 'complete',
        tokensPerSecond: 9.8, observedAtMs: now, expiresAtMs: now + 5_000,
        observation: { startedAtMs: now - 1_000, endedAtMs: now }, freshness: 'last' } });
      w.previewDeferred.splice(0).forEach((reply: () => void) => reply());
    });
    await page.clock.fastForward(600);
    // Its completed packet arrived, but the lifecycle window is still open.
    await expect(frame.locator(phase)).toHaveText('Waiting');
    await page.clock.fastForward(1_000);
    await page.evaluate(() => (window as any).setPreviewSession({ id: 'fixture-chat', busy: true, model: 'omlx/Example-27B-4bit' }));
    await page.clock.fastForward(600);
    await expect(frame.locator('#rate')).toHaveCount(0);
    await page.evaluate(() => (window as any).setPreviewPatch({ chat: null }));
    await page.clock.fastForward(6_500);
    await page.evaluate(() => {
      const w = window as any; w.sendPreviewLifecycle('completed');
      w.setPreviewSession({ id: 'fixture-chat', busy: false, model: 'omlx/Example-27B-4bit' });
    });
    await expect(frame.locator('#rate')).toHaveText('9.8');
    await expect(frame.locator(surface === 'status' ? '.ws-measurement' : '.instrument-primary')).toHaveAttribute('data-live', 'false');
    await expect(frame.locator(surface === 'status' ? '.ws-label' : '.instrument-source')).toContainText('Last chat · avg.');
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });

  test(`hidden ${surface} lifecycle callbacks make no runtime requests`, async ({ page }) => {
    await page.goto(`/v2?surface=${surface}&state=idle&chat=local&frame=hidden`);
    await expect(page.frameLocator('iframe').locator('#scope')).toBeAttached();
    await page.evaluate(() => (window as any).sendPreviewLifecycle('started'));
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as any).previewRequests)).toBe(0);
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });
}
