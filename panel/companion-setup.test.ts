import { describe, expect, it } from 'bun:test';
import { companionCompatibilityMarkup, companionSetupMarkup, parseCompanionSetup } from './companion-setup.ts';
import { featureSupport } from '../bridge/opencode/compatibility.js';

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
    expect(markup).toContain('local and cloud chats');
    expect(markup).toContain('observable reasoning on your computer');
    expect(markup).toContain('never saves chat content');
    expect(markup).toContain('OpenCode plugins');
    expect(markup).toContain('data-companion-action="enable" hidden');
    expect(markup).toContain('data-companion-action="disable" hidden');
    expect(markup).toContain('role="status"');
  });
  it('keeps legacy status usable and discards malformed optional compatibility metadata', () => {
    for (const compatibility of [[], {}, { profile: null, activity: 'unknown', features: {} }, { profile: null, activity: 'listening', features: {} }])
      expect(parseCompanionSetup({ ...valid, compatibility })).toEqual(valid);
    const legacy = companionCompatibilityMarkup(valid);
    expect(legacy).toContain('Feature qualification was not reported');
    expect(legacy).not.toContain('<ul>');
    expect(legacy).toContain('bun run qualify:compatibility');
    expect(legacy).toContain('does not qualify a live host');
  });
  it('shows independent features and activity without trusting contradictory qualification', () => {
    const features = featureSupport('2.0.25'); features['http-delivery'].available = true;
    features['websocket-delivery'] = { support: 'unavailable', available: false };
    const compatibility = { profile: 'opencode-2.0.25-v1', activity: 'awaiting-demand', features } as const;
    const parsed = parseCompanionSetup({ ...valid, runtimeVersion: '2.0.25', compatibility })!;
    expect(parsed.compatibility).toEqual(compatibility);
    const markup = companionCompatibilityMarkup(parsed);
    expect(markup).toContain('HTTP delivery: qualified · available');
    expect(markup).toContain('WebSocket delivery: unavailable');
    expect(markup).toContain('Ready for the next observed step');
    expect(parseCompanionSetup({ ...valid, runtimeVersion: '2.0.26', compatibility })?.compatibility).toBeUndefined();
  });
});
