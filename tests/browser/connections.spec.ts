import { expect, test, type Page } from '@playwright/test';

const open = async (page: Page, query = '') => {
  await page.goto(`/?connections=1&state=prefill&${query}`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#connection')).not.toHaveText('Connecting to local runtime');
  return frame;
};
const choose = async (page: Page, provider: string, runtime = '') => {
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', {name:'Change connection',exact:true}).click();
  await frame.getByLabel('Connection', {exact:true}).selectOption(provider);
  await frame.getByLabel('Runtime', {exact:true}).selectOption(runtime);
  await frame.getByRole('button', {name:'Use connection',exact:true}).click();
};

test('configured runtime selection is stored without credentials and survives reload', async ({page}) => {
  const frame = await open(page);
  await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
  await choose(page,'studio');
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected · limited telemetry');
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
  expect(await page.evaluate(()=>(window as any).previewQueries.at(-1))).toEqual({provider:'studio'});
  await page.reload();
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected · limited telemetry');
  await choose(page,'omlx');
  await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
  await expect(frame.locator('#prefill-progress')).toBeVisible();
});

test('catalog availability never invents residency or request activity', async ({page}) => {
  const frame = await open(page);
  await choose(page,'mlx');
  await expect(frame.locator('#connection')).toHaveText('mlx-lm connected · limited telemetry');
  await expect(frame.locator('#catalog-title')).toHaveText('Available models');
  await expect(frame.locator('#catalog-list')).toContainText('Load state not reported');
  await expect(frame.locator('#catalog-list')).toContainText('Context not reported');
  await expect(frame.locator('#resident-section')).toBeHidden();
  await expect(frame.locator('.metrics')).toBeHidden();
  await choose(page,'vllm');
  await expect(frame.locator('#connection')).toHaveText('vllm-mlx connected · limited telemetry');
  await expect(frame.locator('#catalog-section')).toBeHidden();
  await expect(frame.locator('#coverage-note')).toContainText('Live request progress');
  await expect(frame.locator('#machine')).toBeVisible();
});

test('connection setup supports keyboard dismissal and an explicit runtime for custom providers', async ({page}) => {
  const frame = await open(page);
  const change = frame.getByRole('button',{name:'Change connection',exact:true});
  await change.focus(); await change.press('Enter');
  await expect(frame.locator('#connection-setup')).toBeVisible();
  await frame.getByLabel('Connection',{exact:true}).focus();
  await frame.getByLabel('Connection',{exact:true}).press('Escape');
  await expect(frame.locator('#connection-setup')).toBeHidden();
  await expect(change).toBeFocused();
  await choose(page,'custom','lmstudio');
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected · limited telemetry');
  expect(await page.evaluate(()=>(window as any).previewQueries.at(-1))).toEqual({provider:'custom',runtime:'lmstudio'});
});

test('storage failure keeps the selected connection usable and first-run failure keeps host readings', async ({page}) => {
  let frame = await open(page,'storage=fail');
  await choose(page,'studio');
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected · limited telemetry');
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
  await frame.locator('#refresh').click();
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
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected · limited telemetry');
  await frame.getByRole('tab',{name:'Saved',exact:true}).click();
  const saved=await page.evaluate(()=>(window as any).previewRequests);
  await choose(page,'mlx'); await page.waitForTimeout(700);
  expect(await page.evaluate(()=>(window as any).previewRequests)).toBe(saved);
  await frame.getByRole('tab',{name:'Live',exact:true}).click();
  await expect(frame.locator('#connection')).toHaveText('mlx-lm connected · limited telemetry');
});

test('a late response from the previous connection cannot repaint its readings', async ({page}) => {
  const frame=await open(page);
  await page.evaluate(()=>(window as any).previewDelay=true);
  await frame.locator('#refresh').click();
  await expect.poll(()=>page.evaluate(()=>(window as any).previewDeferred.length)).toBe(1);
  await choose(page,'studio');
  await page.evaluate(()=>{(window as any).previewDelay=false;(window as any).previewDeferred.splice(0).forEach((reply:()=>void)=>reply());});
  await expect(frame.locator('#connection')).toHaveText('LM Studio connected · limited telemetry');
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
  await frame.locator('#refresh').click();
  await frame.getByRole('tab',{name:'Compare',exact:true}).click();
  await frame.locator('#capture-start').click();
  await expect(frame.locator('#capture-speed')).toContainText('tok/s');
  await frame.locator('#capture-stop').click();
  await frame.locator('#capture-pin').click();
  await page.evaluate(()=>(window as any).previewAutoProvider='studio');
  await frame.locator('#refresh').click();
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
  await frame.locator('#runtime-details summary').click();
  await expect(frame.locator('#process-label')).toHaveText('vllm-mlx process footprint');
});

test('a recreated connection clears observations even when provider, runtime and model stay the same', async ({page}) => {
  const frame = await open(page);
  await page.evaluate(() => (window as any).setPreviewState('decode'));
  await frame.locator('#refresh').click();
  await frame.getByRole('tab', {name:'Compare', exact:true}).click();
  await frame.locator('#capture-start').click();
  await expect(frame.locator('#capture-speed')).toContainText('tok/s');
  await frame.locator('#capture-stop').click();
  await frame.locator('#capture-pin').click();
  await expect(frame.locator('#capture-baseline')).toBeVisible();
  await page.evaluate(() => (window as any).setPreviewState('idle'));
  await frame.locator('#refresh').click();
  await expect(frame.locator('#recent-count')).toHaveText('1 / 8');
  await page.evaluate(() => {
    (window as any).previewGeneration = '00000000-0000-4000-8000-000000000002';
    (window as any).setPreviewState('decode');
  });
  await frame.locator('#refresh').click();
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
  await expect(frame.locator('#capture-results')).toBeHidden();
  await expect(frame.locator('#recent-count')).toHaveText('0 / 8');
  await frame.getByRole('button', {name:'Share', exact:true}).click();
  await frame.getByRole('menuitem', {name:'Copy stats', exact:true}).click();
  expect(await page.evaluate(() => (window as any).previewCopied)).not.toContain('00000000-0000-4000-8000');
});
