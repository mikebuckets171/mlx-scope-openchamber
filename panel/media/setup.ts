import { paragraph } from '../render/views/parts.ts';
import type { HostClient } from '../host/types.ts';
import { parseMediaSetup, type MediaSetupStatus, type MediaSetupAction, type MediaSetupState } from '../../src/contract/media-setup.ts';
import { unavailableForHostError, unavailableForServiceResponse } from '../host-errors.ts';
import { SetupRefresh } from '../setup-refresh.ts';
import { flag, html, morph } from '../render/html.ts';

// Shared markup keeps every setup action on the same disabled and escaping rules.
const setupButton = (action: string, label: string, pending: boolean, source?: string, quiet = false) =>
  html`<button class="btn${quiet ? ' quiet' : ''}" type="button" data-media-setup="${action}"${source ? html` data-source="${source}"` : ''}${flag('disabled', pending)}>${label}</button>`;

const STATE_LABELS: Partial<Record<MediaSetupState, string>> = { ready: 'Ready', pending: 'Installed · awaiting startup', available: 'Basic monitoring',
  ambiguous: 'Choose installation', offline: 'Offline', error: 'Check connection' };

export const mediaSetupMarkup = (status: MediaSetupStatus | null, pending: boolean) => html`<label class="media-enabled"><input type="checkbox" data-media-enabled${flag('checked', status?.enabled !== false)}${flag('disabled', pending || !status)}>Monitor media</label>${paragraph('Supported local tools connect automatically. Detailed progress uses a small optional helper; installation never restarts a running tool.')}
  ${status ? status.sources.length ? status.sources.map(source => html`<div class="media-setup-source" data-key="${source.id}"><div class="section-heading"><h4>${source.label}</h4><span class="media-state">${source.enabled === false ? 'Monitoring off' : source.state === 'unsupported' ? source.kind && source.kind !== 'comfyui' ? 'Tracking unavailable' : 'Basic monitoring only' : STATE_LABELS[source.state] ?? 'Check connection'}</span></div>${paragraph(source.message)}
  ${source.locations.length > 1 ? html`<label for="media-location-${source.id}">Installation</label><select id="media-location-${source.id}" data-media-location="${source.id}"><option value="">Choose the installation you use</option>${source.locations.map(location => html`<option value="${location.id}">${location.label}</option>`)}</select>` : ''}
  ${source.enabled === false || source.canEnable || source.canDisable ? html`<div class="insight-actions">${source.enabled === false ? setupButton('resume', 'Enable monitoring', pending, source.id) : ''}${source.canEnable ? setupButton('enable', source.managed ? 'Update progress helper' : 'Enable detailed media progress', pending, source.id) : ''}${source.canDisable ? setupButton('disable', 'Disable and remove helper', pending, source.id, true) : ''}</div>` : ''}
  ${source.helperVersion || source.runtimeVersion ? html`<details class="setup-versions"><summary>Connection details</summary>${paragraph(html`${source.runtimeVersion ? `Runtime ${source.runtimeVersion}` : ''}${source.runtimeVersion && source.helperVersion ? ' · ' : ''}${source.helperVersion ? `Helper ${source.helperVersion}` : ''}`)}${source.enabled !== false ? setupButton('pause', 'Pause monitoring this connection', pending, source.id, true) : ''}</details>` : ''}</div>`) : paragraph(status.enabled === false ? 'Media monitoring is off. Turn it on to discover local tools.' : 'No supported local media tool found yet. Start your existing tool, then check again. A custom ComfyUI address can be added under Advanced.') : paragraph('Checking local media tools…')}
  <div class="insight-actions">${setupButton('check', 'Check media connections', pending, undefined, true)}</div>`;

export const mediaAdvancedMarkup = html`<form id="media-configure" class="media-configure"><h3>Add a ComfyUI connection</h3>${paragraph('Only needed when automatic discovery misses your installation.')}<label for="media-origin">Local server address</label><input id="media-origin" name="origin" type="url" placeholder="http://127.0.0.1:8188" required autocomplete="off"><label for="media-installation">ComfyUI folder <span class="insight-note">optional · for helper setup</span></label><input id="media-installation" name="installation" type="text" placeholder="Folder containing main.py" autocomplete="off"><button class="btn" type="submit">Connect ComfyUI</button></form>`;

/** Metadata only; no periodic installation probing and no mutation without an explicit button. */
export function mountMediaSetup(root: HTMLElement, advanced: HTMLElement, host: Pick<HostClient, 'serviceRequest'>, changed: (status: MediaSetupStatus) => void) {
  let status: MediaSetupStatus | null = null, pending = false, disposed = false, pendingEnabled: boolean | null = null;
  root.innerHTML = '<p class="media-setup-message insight-note" role="status" hidden></p><div class="media-setup-content"></div>';
  const message = root.querySelector<HTMLElement>('[role="status"]')!, content = root.querySelector<HTMLElement>('.media-setup-content')!;
  advanced.innerHTML = mediaAdvancedMarkup.markup;
  const activation = new SetupRefresh(() => request());
  const form = advanced.querySelector<HTMLFormElement>('form')!;
  const paint = (): void => { const shown = status && pendingEnabled !== null ? { ...status, enabled: pendingEnabled } : status; morph(content, mediaSetupMarkup(shown, pending)); const enabled = content.querySelector<HTMLInputElement>('[data-media-enabled]'); if (enabled) enabled.checked = shown?.enabled !== false; for (const control of Array.from(form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button'))) control.disabled = pending; };
  const report = (text: string): void => { message.textContent = text; message.hidden = !text; };
  const request = async (action?: MediaSetupAction): Promise<void> => {
    if (pending || disposed) return;
    pending = true; pendingEnabled = action?.action === 'set-enabled' && !action.sourceId ? action.enabled : null; report(action ? action.action === 'enable' ? 'Installing progress helper…' : action.action === 'disable' ? 'Removing progress helper…' : 'Checking connection…' : ''); paint();
    try {
      const response = await host.serviceRequest({ method: action ? 'POST' : 'GET', path: '/v2/media/setup', ...action ? { body: JSON.stringify(action) } : {} });
      if (disposed) return;
      const next = response.status === 200 ? parseMediaSetup(JSON.parse(response.body)) : null;
      if (!next) {
        let detail: string | null = null;
        try { const value = JSON.parse(response.body); if (value?.error === 'setup_failed' && typeof value.message === 'string' && value.message.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value.message)) detail = value.message; } catch {}
        report(detail ?? (response.status === 400 ? 'That connection could not be verified. Check the local address and installation folder.' : unavailableForServiceResponse(response.status).message)); return;
      }
      status = next; report(''); changed(next);
    } catch (error) { if (!disposed) report(unavailableForHostError(error).message); }
    finally { pending = false; pendingEnabled = null; if (!disposed) { paint(); activation.setPending(status?.enabled !== false && (status?.sources.some(source => source.state === 'pending') ?? false)); } }
  };
  const click = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-media-setup]') : null;
    if (!button || !root.contains(button)) return;
    const action = button.dataset.mediaSetup;
    if (action === 'check') { void request(); return; }
    const source = status?.sources.find(source => source.id === button.dataset.source);
    if (source && (action === 'resume' || action === 'pause')) { void request({ action: 'set-enabled', sourceId: source.id, enabled: action === 'resume' }); return; }
    if (!source || action === 'enable' && !source.canEnable || action === 'disable' && !source.canDisable || !['enable', 'disable'].includes(action ?? '')) return;
    const installation = root.querySelector<HTMLSelectElement>(`[data-media-location="${source.id}"]`), location = installation?.value;
    if (action === 'enable' && source.locations.length > 1 && !location) { report('Choose the ComfyUI installation you use.'); installation?.focus(); return; }
    void request({ action: action as 'enable' | 'disable', sourceId: source.id, ...location ? { locationId: location } : {} });
  };
  const toggle = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.hasAttribute('data-media-enabled')) void request({ action: 'set-enabled', enabled: target.checked });
  };
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const origin = (form.elements.namedItem('origin') as HTMLInputElement).value.trim(), installationPath = (form.elements.namedItem('installation') as HTMLInputElement).value.trim();
    void request({ action: 'configure', origin, ...installationPath ? { installationPath } : {} });
  };
  root.addEventListener('click', click); root.addEventListener('change', toggle); form.addEventListener('submit', submit); paint();
  return { setVisible: (visible: boolean) => activation.setVisible(visible), refresh: () => request(), get status() { return status; }, dispose: () => { disposed = true; activation.dispose(); root.removeEventListener('click', click); root.removeEventListener('change', toggle); form.removeEventListener('submit', submit); } };
}
