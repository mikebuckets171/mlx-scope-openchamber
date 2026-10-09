import type { HostClient } from '@openchamber/sdk';
import type { CompanionSetupStatus } from '../service/companion-setup.ts';
import { unavailableForHostError, unavailableForServiceResponse } from './host-errors.ts';
import { SetupRefresh } from './setup-refresh.ts';
import { html } from './render/html.ts';

const PATH = '/v2/companion/setup';
const STATES = ['disabled', 'pending', 'ready', 'incompatible', 'manual', 'error'];
/** Reject a stale service or malformed response before rendering any setup action. */
export function parseCompanionSetup(value: unknown): CompanionSetupStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!STATES.includes(String(v.state)) || typeof v.message !== 'string' || v.message.length > 1_000
    || ['configured', 'managed', 'canEnable', 'canDisable', 'live'].some(key => typeof v[key] !== 'boolean')
    || ['runtimeVersion', 'companionVersion', 'protocol'].some(key => v[key] !== null && (typeof v[key] !== 'string' || (v[key] as string).length > 100))) return null;
  return v as unknown as CompanionSetupStatus;
}
export const companionSetupMarkup = (): string => html`<div class="companion-setup" data-companion-setup>
  <p class="insight-note">Estimates delivery speed for local chats from streamed text and observable reasoning on your computer. Scope never saves chat content.</p>
  <p class="insight-note" data-companion-status role="status">Checking chat speed…</p>
  <div class="insight-actions"><button type="button" class="btn" data-companion-action="enable" hidden>Enable chat speed</button><button type="button" class="btn quiet" data-companion-action="disable" hidden>Disable and remove</button><button type="button" class="btn quiet" data-companion-action="check">Check status</button></div>
  <details class="setup-versions"><summary>Compatibility &amp; privacy</summary><p class="insight-note">Enable installs a small companion through OpenCode plugins. It preserves existing plugins and provider settings. No active chat is restarted.</p><p class="insight-note" data-companion-version hidden></p></details>
</div>`.markup;

/** Mount only in the expanded setup disclosure. No polling or writes occur until an explicit action. */
export function mountCompanionSetup(root: HTMLElement, host: Pick<HostClient, 'serviceRequest'>, changed: (status: CompanionSetupStatus | null) => void = () => {}) {
  root.innerHTML = companionSetupMarkup();
  const status = root.querySelector<HTMLElement>('[data-companion-status]')!;
  const version = root.querySelector<HTMLElement>('[data-companion-version]')!;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-companion-action]'));
  let disposed = false, pending = false, latest: CompanionSetupStatus | null = null;
  const activation = new SetupRefresh(() => request('check'));
  const paint = (): void => {
    for (const button of buttons) {
      const action = button.dataset.companionAction;
      button.disabled = pending;
      button.hidden = action === 'enable' ? !latest?.canEnable || latest.state === 'ready'
        : action === 'disable' ? !latest?.canDisable : false;
      if (action === 'enable') button.textContent = latest?.configured ? 'Update chat speed' : 'Enable chat speed';
      if (action === 'disable') button.textContent = latest?.managed ? 'Disable and remove' : 'Disable companion';
    }
    if (!pending && latest) status.textContent = latest.message;
    const parts = [latest?.runtimeVersion ? `OpenCode ${latest.runtimeVersion}` : '', latest?.companionVersion ? `Companion ${latest.companionVersion}` : ''].filter(Boolean);
    version.textContent = parts.join(' · '); version.hidden = parts.length === 0;
  };
  const request = async (action: 'enable' | 'disable' | 'check'): Promise<void> => {
    if (disposed || pending) return;
    pending = true;
    status.textContent = action === 'enable' ? 'Enabling chat speed…' : action === 'disable' ? 'Disabling chat speed…' : 'Checking chat speed…'; paint();
    try {
      const response = await host.serviceRequest({ method: action === 'check' ? 'GET' : 'POST', path: PATH,
        ...action === 'check' ? {} : { body: JSON.stringify({ action }) } });
      if (disposed) return;
      if (response.status !== 200) { latest = null; status.textContent = unavailableForServiceResponse(response.status).message; return; }
      const value = response.status === 200 ? parseCompanionSetup(JSON.parse(response.body)) : null;
      if (!value) throw new Error('unavailable');
      latest = value;
    } catch (error) {
      if (disposed) return;
      latest = null;
      status.textContent = unavailableForHostError(error).message;
    } finally { pending = false; if (!disposed) { paint(); changed(latest); activation.setPending(latest?.state === 'pending'); } }
  };
  const click = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-companion-action]') : null;
    if (!target || !root.contains(target)) return;
    const action = target.dataset.companionAction;
    if (action === 'check' || action === 'enable' && latest?.canEnable || action === 'disable' && latest?.canDisable) void request(action as 'check' | 'enable' | 'disable');
  };
  root.addEventListener('click', click);
  return { setVisible: (visible: boolean) => activation.setVisible(visible), get status() { return latest; }, refresh: () => request('check'), dispose: () => { disposed = true; activation.dispose(); root.removeEventListener('click', click); } };
}
