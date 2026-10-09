import { describe, expect, it } from 'bun:test';
import { companionSetupMarkup, parseCompanionSetup } from './companion-setup.ts';

describe('companion setup surface', () => {
  const valid = { state: 'disabled', message: 'Enable estimates.', configured: false, managed: false, canEnable: true, canDisable: false,
    runtimeVersion: null, companionVersion: null, protocol: null, live: false } as const;
  it('requires the complete service contract before offering a write', () => {
    expect(parseCompanionSetup(valid)).toEqual(valid);
    expect(parseCompanionSetup({ ...valid, canEnable: 'yes' })).toBeNull();
    expect(parseCompanionSetup({ state: 'disabled' })).toBeNull();
    expect(parseCompanionSetup({ ...valid, state: 'unknown' })).toBeNull();
    expect(parseCompanionSetup({ ...valid, message: 'a'.repeat(1001) })).toBeNull();
  });
  it('explains the optional setup and hides mutations until status is validated', () => {
    const markup = companionSetupMarkup();
    expect(markup).toContain('local chats');
    expect(markup).toContain('observable reasoning on your computer');
    expect(markup).toContain('never saves chat content');
    expect(markup).toContain('OpenCode plugins');
    expect(markup).toContain('data-companion-action="enable" hidden');
    expect(markup).toContain('data-companion-action="disable" hidden');
    expect(markup).toContain('role="status"');
  });
});
