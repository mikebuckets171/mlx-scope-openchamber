import { expect, test, type Page } from '@playwright/test';

// 1.5: less-used controls live in the ⋯ menu; open it (if closed) before using one.
const openMenu = async (frame: import('@playwright/test').FrameLocator): Promise<void> => {
  if (!(await frame.locator('#monitor-menu').evaluate(element => (element as HTMLDetailsElement).open))) await frame.locator('#monitor-menu > summary').click();
};
const menu = async (frame: import('@playwright/test').FrameLocator, selector: string): Promise<void> => { await openMenu(frame); await frame.locator(selector).click(); };

const open = async (page: Page, query = '') => {
  await page.goto(`/?connections=1&state=prefill&${query}`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#connection')).not.toHaveText('Connecting to local runtime');
  return frame;
};
// Each poll also names its frame, surface, probe tier and completion cursor; these tests check the selection only.
const selection = async (page: Page) => {
  const { provider, runtime } = await page.evaluate(() => (window as any).previewQueries.at(-1));
  return { provider, runtime };
};
const choose = async (page: Page, provider: string, runtime = '') => {
  const frame = page.frameLocator('iframe');
  await openMenu(frame); await frame.getByRole('button', {name:'Change connection',exact:true}).click();
  await frame.getByLabel('Connection', {exact:true}).selectOption(provider);
  await frame.getByLabel('Runtime', {exact:true}).selectOption(runtime);
  await frame.getByRole('button', {name:'Use connection',exact:true}).click();
};

test('configured runtime selection is stored without credentials and survives reload', async ({page}) => {
  const frame = await open(page);
  await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
  await choose(page,'studio');
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected');
  await expect(frame.locator('#catalog-list')).toContainText('Loaded');
  await expect(frame.locator('#catalog-list')).toContainText('32,768 context');
  await expect(frame.locator('#catalog-list')).toContainText('GGUF');
  await expect(frame.locator('#resident-section')).toBeHidden();
  await expect(frame.locator('#phase')).toHaveText('Connected');
  await expect(frame.locator('#prefill-progress')).toBeHidden();
  await expect(frame.locator('.readout')).toBeHidden();
  await expect(frame.locator('#cache-lens')).toBeHidden();
  await expect(frame.locator('#session-stats')).toBeHidden();
  await expect(frame.locator('#machine')).toBeVisible();
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('connection.selection')!))).toEqual({provider:'studio',runtime:null});
  expect(await selection(page)).toEqual({provider:'studio'});
  await page.reload();
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected');
  await choose(page,'omlx');
  await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
  await expect(frame.locator('#prefill-progress')).toBeVisible();
});

test('catalog availability never invents residency or request activity', async ({page}) => {
  const frame = await open(page);
  await choose(page,'mlx');
  await expect(frame.locator('#connection')).toHaveText('mlx-lm connected');
  await expect(frame.locator('#catalog-title')).toHaveText('Available models');
  // Unknown residency stays blank rather than claiming Loaded or printing "not reported" filler.
  await expect(frame.locator('#catalog-list .catalog-state')).toHaveText('');
  await expect(frame.locator('#catalog-list')).not.toContainText('not reported');
  await expect(frame.locator('#runtime-memory')).toBeHidden();
  await expect(frame.locator('#resident-section')).toBeHidden();
  await expect(frame.locator('.metrics')).toBeHidden();
  await choose(page,'vllm');
  await expect(frame.locator('#connection')).toHaveText('vllm-mlx connected');
  await expect(frame.locator('#catalog-section')).toBeHidden();
  await expect(frame.locator('#coverage-note')).toContainText('live request progress');
  await expect(frame.locator('#machine')).toBeVisible();
});

test('Splash aggregate stats stay separate from request readings, process memory, and saved identity', async ({page}) => {
  await page.setViewportSize({width:320,height:900});
  const frame=await open(page);
  await choose(page,'splash');
  await expect(frame.locator('#connection')).toHaveText('Splash (standalone) connected');
  await expect(frame.locator('#phase')).toHaveText('Idle');
  await expect(frame.locator('#model')).toHaveText('Qwen3.8-27B-Splash');
  await expect(frame.locator('#splash-model-detail')).toHaveText('262,144-token context');
  await expect(frame.locator('#rate')).toHaveText('47.2');
  await expect(frame.locator('#unit')).toHaveText('tok/s · server decode, all requests');
  await expect(frame.locator('#activity')).toHaveText('Idle · ready for your next request.');
  await expect(frame.locator('.readout')).toBeVisible();
  await expect(frame.locator('.signal')).toBeHidden();
  await expect(frame.locator('.metrics')).toBeHidden();
  await expect(frame.locator('#coverage-note')).toBeHidden();
  await expect(frame.locator('#view-live')).not.toContainText(/unavailable|not reported|not ready|limited telemetry/i, {useInnerText:true});
  await frame.getByRole('tab',{name:'Server',exact:true}).click(); // 1.5: server detail lives in the Server tab
  await expect(frame.locator('#session-stats')).toBeVisible();
  await expect(frame.locator('#session-title')).toHaveText('Requests');
  await expect(frame.locator('#session-stats')).toBeInViewport();
  await expect(frame.locator('#average-prefill')).toHaveText('17');
  await expect(frame.locator('#average-cache')).toHaveText('1');
  await expect(frame.locator('#average-cache')).toHaveAttribute('data-warn','true');
  await expect(frame.locator('#session-stats-state')).toHaveText('Server decode is shared across all requests.');
  await expect(frame.locator('#runtime-memory')).toBeVisible();
  await expect(frame.locator('#runtime-memory-title')).toHaveText('GPU memory (Metal)');
  await expect(frame.locator('#process-label')).toHaveText('Now');
  await expect(frame.locator('#process-memory')).toHaveText('11.6 GiB');
  await expect(frame.locator('#model-label')).toHaveText('Peak');
  await expect(frame.locator('#model-memory')).toHaveText('12.1 GiB');
  await expect(frame.locator('#catalog-section')).toBeHidden();
  await expect(frame.locator('#cache-lens')).toBeHidden();
  expect(await frame.locator('main').evaluate(el=>document.documentElement.scrollWidth > innerWidth)).toBe(false);

  await frame.locator('#pause').click();
  await expect(frame.locator('#unit')).toHaveText('Frozen observation');
  await expect(frame.locator('#session-stats')).toHaveAttribute('data-stale','true');
  await expect(frame.locator('#session-stats-state')).toHaveText('Paused · last reading');
  await expect(frame.locator('#runtime-memory-source')).toHaveText('Frozen reading');
  await frame.locator('#pause').click();

  await openMenu(frame); await frame.getByRole('button',{name:'Share',exact:true}).click();
  await frame.getByRole('menuitem',{name:'Copy stats',exact:true}).click();
  await expect(frame.locator('#action-status')).toContainText('Stats copied');
  const shared=await page.evaluate(()=>(window as any).previewCopied as string);
  expect(shared).toContain('Splash server decode (all requests): 47.2 tok/s');
  expect(shared).toContain('Splash GPU memory (Metal) · now');
  expect(shared).not.toContain('not reported');
  expect(shared).not.toContain('Qwen3.8-27B-Splash');

  await menu(frame, '#save-snapshot');
  await expect(frame.locator('#action-status')).toContainText('Observation saved');
  await frame.getByRole('tab',{name:'Saved',exact:true}).click();
  await expect(frame.locator('#saved-list')).toContainText('Splash server decode (all requests)');
  await expect(frame.locator('#saved-list')).toContainText('Splash GPU memory (Metal) · peak');
  await expect(frame.locator('#saved-list')).not.toContainText('Qwen3.8-27B-Splash');
  expect(await page.evaluate(()=>(window as any).previewUnexpectedSends)).toBe(0);
});

test('a loading Splash server says so once and shows no decode rate', async ({page}) => {
  const frame=await open(page,'splashReady=0');
  await choose(page,'splash');
  await expect(frame.locator('#connection')).toHaveText('Splash (standalone) · loading model');
  await expect(frame.locator('#phase')).toHaveText('Loading');
  await expect(frame.locator('#rate')).toHaveText('Loading');
  await expect(frame.locator('#unit')).toHaveText('Splash is loading the model');
  await expect(frame.locator('#activity')).toBeHidden();
  await expect(frame.locator('#view-live')).not.toContainText(/unavailable|not ready|residency/i, {useInnerText:true});
});

test('Splash in Bionic is named, lists its Splash models, and shows only reported readings', async ({page}) => {
  const frame=await open(page,'bionic=decode');
  await choose(page,'bionic');
  await expect(frame.locator('#connection')).toHaveText('Splash via Bionic connected');
  await expect(frame.locator('#phase')).toHaveText('Generating');
  await expect(frame.locator('#model')).toHaveText('qwen3.8-27b-splash-levels');
  await expect(frame.locator('#rate')).toHaveText('Generating');
  await expect(frame.locator('#unit')).toHaveText('Exact speed when it finishes · last 38.6 tok/s');
  await expect(frame.locator('#activity')).toBeHidden();
  await expect(frame.locator('.signal')).toBeHidden();
  await expect(frame.locator('#recent-speed')).toBeHidden();
  await expect(frame.locator('#context')).toHaveText('7%');
  await expect(frame.locator('#context-detail')).toHaveText('18.4K / 262.1K · last response');
  await expect(frame.locator('#reuse')).toHaveText('61%');
  await expect(frame.locator('#queue')).toHaveText('running now');
  await expect(frame.locator('#catalog-title')).toHaveText('Splash models');
  await expect(frame.locator('#catalog-count')).toHaveText('5 Splash · 1 loaded');
  await expect(frame.locator('#catalog-list .catalog-row').first()).toContainText('local/qwen3.8-27b-splash-levels');
  await expect(frame.locator('#catalog-list .catalog-row').first()).toContainText('Loaded');
  await expect(frame.locator('#catalog-list .catalog-format[data-format="splash"]')).toHaveCount(5);
  await expect(frame.locator('#cache-scope')).toHaveText('Last response');
  await expect(frame.locator('#cache-request-state')).toHaveText('61.2% of input reused · last response');
  await expect(frame.locator('#runtime-details')).toBeHidden();
  await expect(frame.locator('#resident-list')).not.toContainText('—');
  await expect(frame.locator('#view-live')).not.toContainText(/unavailable|not reported|limited telemetry|LM Studio/i, {useInnerText:true});

  await openMenu(frame); await frame.getByRole('button',{name:'Change connection',exact:true}).click();
  await expect(frame.getByLabel('Connection',{exact:true}).locator('option[value="bionic"]')).toHaveText('Splash (Bionic)');
  await expect(frame.getByLabel('Connection',{exact:true}).locator('option[value="splash"]')).toHaveText('Inco AI Splash');
  await expect(frame.locator('#connection-choice-note')).toContainText('Using Splash in Bionic? Keep Automatic.');
});

test('Splash in Bionic with no model loaded says what to do next', async ({page}) => {
  const frame=await open(page,'bionic=none');
  await choose(page,'bionic');
  await expect(frame.locator('#connection')).toHaveText('Splash via Bionic connected · no model loaded');
  await expect(frame.locator('#model')).toHaveText('No model loaded');
  await expect(frame.locator('#activity')).toContainText('Load a Splash model in Bionic to start.');
  await expect(frame.locator('#catalog-count')).toHaveText('5 Splash · 0 loaded');
  await expect(frame.locator('#view-live')).not.toContainText(/unavailable|not reported/i, {useInnerText:true});
});

test('connection setup supports keyboard dismissal and an explicit runtime for custom providers', async ({page}) => {
  const frame = await open(page);
  const change = frame.getByRole('button',{name:'Change connection',exact:true});
  await openMenu(frame); await change.focus(); await change.press('Enter');
  await expect(frame.locator('#connection-setup')).toBeVisible();
  await frame.getByLabel('Connection',{exact:true}).focus();
  await frame.getByLabel('Connection',{exact:true}).press('Escape');
  await expect(frame.locator('#connection-setup')).toBeHidden();
  // 1.5: Change connection sits in the ⋯ menu, which closes; focus returns to the menu button.
  await expect(frame.locator('#monitor-menu > summary')).toBeFocused();
  await choose(page,'custom','lmstudio');
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected');
  expect(await selection(page)).toEqual({provider:'custom',runtime:'lmstudio'});
});

test('storage failure keeps the selected connection usable and first-run failure keeps host readings', async ({page}) => {
  let frame = await open(page,'storage=fail');
  await choose(page,'studio');
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected');
  await expect(frame.locator('#action-status')).toContainText('could not save the preference');
  frame = await open(page,'setup=missing');
  await expect(frame.locator('#connection-diagnosis')).toBeVisible();
  await expect(frame.locator('#connection-message')).toContainText('Add a local provider');
  await expect(frame.locator('#instrument')).toBeHidden();
  await expect(frame.locator('#machine')).toBeVisible();
  await frame.getByRole('button',{name:'Choose connection',exact:true}).click();
  await expect(frame.getByLabel('Connection',{exact:true})).toBeFocused();
});

test('switching during pause or Saved preserves suspension and discards old observations', async ({page}) => {
  const frame = await open(page);
  await page.evaluate(()=>(window as any).setPreviewState('decode'));
  await menu(frame, '#refresh');
  await frame.getByRole('tab',{name:'Compare',exact:true}).click();
  await frame.locator('#capture-start').click();
  await expect(frame.locator('#capture-speed')).toContainText('tok/s');
  await frame.locator('#capture-stop').click(); await frame.locator('#capture-pin').click();
  await frame.locator('#pause').click();
  const before=await page.evaluate(()=>(window as any).previewRequests);
  await choose(page,'studio');
  await expect(frame.locator('#pause')).toHaveAttribute('aria-pressed','true');
  await expect(frame.locator('#capture-results')).toBeHidden();
  await page.waitForTimeout(700);
  expect(await page.evaluate(()=>(window as any).previewRequests)).toBe(before);
  await frame.locator('#pause').click();
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected');
  await frame.getByRole('tab',{name:'Saved',exact:true}).click();
  const saved=await page.evaluate(()=>(window as any).previewRequests);
  await choose(page,'mlx'); await page.waitForTimeout(700);
  expect(await page.evaluate(()=>(window as any).previewRequests)).toBe(saved);
  await frame.getByRole('tab',{name:'Live',exact:true}).click();
  await expect(frame.locator('#connection')).toHaveText('mlx-lm connected');
});

test('a late response from the previous connection cannot repaint its readings', async ({page}) => {
  const frame=await open(page);
  await page.evaluate(()=>(window as any).previewDelay=true);
  await menu(frame, '#refresh');
  await expect.poll(()=>page.evaluate(()=>(window as any).previewDeferred.length)).toBe(1);
  await choose(page,'studio');
  await page.evaluate(()=>{(window as any).previewDelay=false;(window as any).previewDeferred.splice(0).forEach((reply:()=>void)=>reply());});
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected');
  await expect(frame.locator('#prefill-progress')).toBeHidden();
  await expect(frame.locator('#recent-count')).toHaveText('0 / 8');
});

test('inventory observations compare host resources without inventing output', async ({page}) => {
  const frame=await open(page);
  await choose(page,'studio');
  await expect(frame.locator('#connection')).toContainText('LM Studio connected');
  await frame.getByRole('tab',{name:'Compare',exact:true}).click();
  await expect(frame.locator('#recent-generations')).toBeHidden();
  await frame.locator('#capture-start').click();
  await expect(frame.locator('#capture')).toHaveAttribute('data-recording','true');
  await expect(frame.locator('#capture-cpu')).toContainText('%');
  await expect(frame.locator('#capture-host-memory')).toContainText('GiB');
  await expect(frame.locator('#capture-resource-coverage')).toContainText(/[2-9] CPU/);
  await frame.locator('#capture-stop').click();
  await expect(frame.locator('#capture-speed')).toHaveText('—');
  await expect(frame.locator('#capture-memory')).toHaveText('—');
  await expect(frame.locator('#capture-requests')).toHaveText('—');
  await frame.locator('#capture-pin').click();
  await expect(frame.locator('#capture-baseline')).toBeVisible();
  await expect(frame.locator('#capture-reference-cpu')).toContainText('%');
  await frame.locator('#capture-save').click();
  await frame.getByRole('tab',{name:'Saved',exact:true}).click();
  await expect(frame.locator('#saved-list')).toContainText('Capture');
});

test('automatic discovery target changes clear references and old history', async ({page}) => {
  const frame=await open(page);
  await page.evaluate(()=>(window as any).setPreviewState('decode'));
  await menu(frame, '#refresh');
  await frame.getByRole('tab',{name:'Compare',exact:true}).click();
  await frame.locator('#capture-start').click();
  await expect(frame.locator('#capture-speed')).toContainText('tok/s');
  await frame.locator('#capture-stop').click();
  await frame.locator('#capture-pin').click();
  await page.evaluate(()=>(window as any).previewAutoProvider='studio');
  await menu(frame, '#refresh');
  await expect(frame.locator('#connection')).toContainText('LM Studio connected');
  await expect(frame.locator('#capture-results')).toBeHidden();
  await expect(frame.locator('#recent-count')).toHaveText('0 / 8');
});

test('detailed vllm-mlx readings retain the prefill hierarchy and runtime labels', async ({page}) => {
  const frame=await open(page,'vllm=live');
  await choose(page,'vllm');
  await expect(frame.locator('#connection')).toHaveText('vllm-mlx connected');
  await expect(frame.locator('#prefill-remaining')).toBeVisible();
  await expect(frame.locator('#prefill-counts')).toContainText('5,824 / 9,100');
  await expect(frame.locator('#estimate-source')).toHaveText('vllm-mlx estimate · may change');
  await expect(frame.locator('#catalog-section')).toBeHidden();
  await frame.getByRole('tab',{name:'Server',exact:true}).click(); // 1.5: server detail lives in the Server tab
  await frame.locator('#runtime-details summary').click();
  await expect(frame.locator('#process-label')).toHaveText('vllm-mlx process footprint');
});

test('a recreated connection clears observations even when provider, runtime and model stay the same', async ({page}) => {
  const frame = await open(page);
  await page.evaluate(() => (window as any).setPreviewState('decode'));
  await menu(frame, '#refresh');
  await frame.getByRole('tab', {name:'Compare', exact:true}).click();
  await frame.locator('#capture-start').click();
  await expect(frame.locator('#capture-speed')).toContainText('tok/s');
  await frame.locator('#capture-stop').click();
  await frame.locator('#capture-pin').click();
  await expect(frame.locator('#capture-baseline')).toBeVisible();
  await page.evaluate(() => (window as any).setPreviewState('idle'));
  await menu(frame, '#refresh');
  await expect(frame.locator('#recent-count')).toHaveText('1 / 8');
  await page.evaluate(() => {
    (window as any).previewGeneration = '00000000-0000-4000-8000-000000000002';
    (window as any).setPreviewState('decode');
  });
  await menu(frame, '#refresh');
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
  await expect(frame.locator('#capture-results')).toBeHidden();
  await expect(frame.locator('#recent-count')).toHaveText('0 / 8');
  await openMenu(frame); await frame.getByRole('button', {name:'Share', exact:true}).click();
  await frame.getByRole('menuitem', {name:'Copy stats', exact:true}).click();
  expect(await page.evaluate(() => (window as any).previewCopied)).not.toContain('00000000-0000-4000-8000');
});
