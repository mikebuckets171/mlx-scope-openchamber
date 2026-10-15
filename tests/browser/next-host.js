// Synthetic 2.3.3 features, deliberately enabled only by ?sdk=next.
window.previewNextCalls = [];
window.previewNextWrites = [];
window.previewDeviceReads = 0;
window.previewSubscriptions = new Map();
window.previewShellReads = [];
window.previewHeaderControls = [];
window.previewPopoverCollectorCalls = [];
window.previewForbiddenNextCalls = [];
window.previewDirectory = '/fixture/project';
window.nextPreviewReady = () => params.get('sdk') === 'next' ? {
  directory: window.previewDirectory,
  features: { deviceStorage: true, statusControls: true, popovers: true },
  ...(surface === 'popover' ? { popover: { id: 'fixture-popover', data: { title: 'Generating', value: '42 tok/s', detail: 'Engine measurement', facts: ['Output 84'], observedAt: Date.now(), designMode: 'next' } } } : {}),
} : {};
let deviceValues;
const devices = () => {
  if (!deviceValues) {
    deviceValues = JSON.parse(sessionStorage.getItem('fixture-device') || '{}');
    if (params.get('design') && !deviceValues['view.next']) deviceValues['view.next'] = { designMode: params.get('design'), workspace: false, shells: false };
  }
  return deviceValues;
};
window.setPreviewDevicePreferences = value => { devices()['view.next'] = value; sessionStorage.setItem('fixture-device', JSON.stringify(devices())); };
let childPopover = null, childOpening = null;
const closeChild = () => { childPopover?.remove(); childPopover = null; childOpening = null; };
window.handleNextPreview = (m, post) => {
  if (params.get('sdk') !== 'next') return false;
  const ok = payload => post({ type: 'result', id: m.id, ok: true, payload });
  const fail = code => post({ type: 'result', id: m.id, ok: false, code, error: 'Synthetic refusal' });
  const p = m.payload;
  if (['shell-stop', 'prompt', 'start-session', 'generate', 'file-write'].includes(m.type)) { window.previewForbiddenNextCalls.push(m.type); fail('NOT_GRANTED'); return true; }
  if (m.type === 'storage' && p.scope === 'device') {
    if (p.op === 'get') window.previewDeviceReads++;
    if (params.get('deviceStorage') === 'fail') { fail('HOST_REJECTED'); return true; }
    if (p.op === 'get' && params.get('deviceStorage') === 'held-read') {
      window.releasePreviewDeviceRead = () => ok({ storage: true, op: p.op, found: false }); return true;
    }
    const values = devices();
    if (p.op === 'set') { values[p.key] = p.value; window.previewNextWrites.push(p); sessionStorage.setItem('fixture-device', JSON.stringify(values)); }
    ok({ storage: true, op: p.op, ...(p.op === 'get' ? { found: p.key in values, ...(p.key in values ? { value: values[p.key] } : {}) } : {}) }); return true;
  }
  if (m.type === 'status-controls') {
    if (params.get('headers') === 'fail') { fail('UNSUPPORTED'); return true; }
    window.previewHeaderControls = p.controls;
    let controls = document.getElementById('fixture-status-controls');
    if (!controls) { controls = document.createElement('nav'); controls.id = 'fixture-status-controls'; frame.before(controls); }
    controls.replaceChildren(...p.controls.map(control => {
      const node = document.createElement(control.kind === 'select' ? 'select' : 'button');
      node.setAttribute('aria-label', control.label); node.disabled = !!control.disabled;
      if (control.kind === 'select') {
        node.replaceChildren(...control.options.map(item => { const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; return option; }));
        node.value = control.value;
      } else node.textContent = control.label;
      node.addEventListener(control.kind === 'select' ? 'change' : 'click', () => post({ type: 'status-control-event', payload: { id: control.id, ...(control.kind === 'select' ? { value: node.value } : {}) } }));
      return node;
    }));
    ok(null); return true;
  }
  if (m.type === 'workspace-unsubscribe' || m.type === 'shells-unsubscribe') { window.previewSubscriptions.delete(p.subscriptionId); return true; }
  if (m.type === 'workspace-subscribe' || m.type === 'shells-subscribe') {
    window.previewNextCalls.push(m.type); window.previewSubscriptions.set(p.subscriptionId, p);
    if (params.get('workspace') === 'denied') { window.previewSubscriptions.delete(p.subscriptionId); fail('NOT_GRANTED'); return true; }
    ok(null);
    if (m.type === 'workspace-subscribe') {
      const query = p.query;
      const record = { id: 'fixture-chat', title: 'Fixture active chat', projectId: 'fixture-project', directory: '/fixture/project', parentId: null,
        createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null, activity: 'running', outcome: null, items: [] };
      const snapshot = query.kind === 'projects' ? { kind: 'projects', state: 'ready', projects: [{ id: 'fixture-project', name: 'Fixture project', directory: '/fixture/project' }] }
        : { kind: 'sessions', state: 'ready', projectId: 'fixture-project', coverage: [{ directory: '/fixture/project', state: 'ready' }], sessions: [record, { ...record, id: 'fixture-child', title: 'Fixture subagent', parentId: record.id, activity: 'waiting-question' }] };
      post({ type: 'workspace', payload: { subscriptionId: p.subscriptionId, snapshot } });
    } else post({ type: 'shells', payload: { subscriptionId: p.subscriptionId, snapshot: { kind: 'shells', scope: p.scope,
      shells: [{ id: 'fixture-shell', sessionID: 'fixture-chat', command: 'fixture_private_command_canary', startedAt: Date.now(), background: true }], ended: [] } } });
    return true;
  }
  if (m.type === 'shell-output') {
    window.previewShellReads.push(p);
    const output = params.get('output') === 'unicode' ? '🙂漢é'.repeat(5000) + 'fixture_utf8_tail'
      : params.get('output') === 'empty' ? '' : 'fixture_private_output_canary '.repeat(1000);
    ok({ output, cursor: 20, skipped: true }); return true;
  }
  if (m.type === 'popover-open') {
    closeChild(); childOpening = p;
    childPopover = document.createElement('iframe'); childPopover.title = 'Scope detail popover'; childPopover.sandbox = 'allow-scripts';
    childPopover.style.cssText = 'position:fixed;right:8px;top:30px;width:320px;height:280px;background:#10151b;border:1px solid #718096;z-index:10';
    document.body.append(childPopover); childPopover.src = '/panel/index.html'; ok(null); return true;
  }
  if (['popover-anchor', 'popover-close', 'close'].includes(m.type)) { if (m.type !== 'popover-anchor') closeChild(); ok(null); return true; }
  return false;
};
window.addEventListener('message', event => {
  if (event.source !== childPopover?.contentWindow || event.data?.channel !== 'openchamber.sdk') return;
  const m = event.data, send = message => event.source.postMessage({ channel: 'openchamber.sdk', v: 1, ...message }, '*');
  if (m.type === 'hello') {
    send({ type: 'ready', payload: { theme: window.previewTheme, locale: 'en-US', directory: null, session: null, surface: 'popover', connection: { connected: false, account: '' }, settings: {}, item: null, popover: { id: childOpening.id, data: childOpening.data } } }); return;
  }
  if (['service-request', 'storage', 'workspace-subscribe', 'shells-subscribe'].includes(m.type)) window.previewPopoverCollectorCalls.push(m.type);
  if (m.type === 'popover-close' || m.type === 'close') { closeChild(); frame.focus(); }
  else send({ type: 'result', id: m.id, ok: true, payload: null });
});
