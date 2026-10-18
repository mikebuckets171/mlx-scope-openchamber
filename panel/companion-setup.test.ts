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
    expect(legacy).toContain('Feature checks were not reported');
    expect(legacy).not.toContain('<ul>');
    expect(legacy).toContain('bun run qualify:compatibility');
    expect(legacy).toContain('does not qualify a live host');
  });
  it('shows what each running check has shown, never a support claim as working', () => {
    const features = featureSupport('2.0.32');
    features['http-delivery'] = { support: 'compatible', available: true, check: { state: 'passed' } };
    features['websocket-delivery'] = { support: 'compatible', available: true, check: { state: 'waiting' } };
    features['prompt-progress'] = { support: 'compatible', available: false, check: { state: 'failed', reason: 'session-header' } };
    const compatibility = { profile: 'opencode-2.0.32-v1', mode: 'qualified', activity: 'awaiting-demand', features } as const;
    const parsed = parseCompanionSetup({ ...valid, runtimeVersion: '2.0.32', compatibility })!;
    expect(parsed.compatibility).toEqual(compatibility);
    const markup = companionCompatibilityMarkup(parsed);
    expect(markup).toContain('OpenCode 2.0.32 · qualified');
    expect(markup).toContain('HTTP delivery: working');
    expect(markup).toContain('WebSocket delivery: waiting for the next reply');
    expect(markup).toContain('Prompt progress: paused · Splash requests no longer identify the chat');
    expect(markup).not.toContain('Managed reload');
    expect(markup).toContain('Ready for the next observed step');
    const unsupported = { ...compatibility, features: featureSupport('2.0.32') };
    expect(parseCompanionSetup({ ...valid, runtimeVersion: '2.1.0', compatibility: unsupported })?.compatibility).toBeUndefined();
  });
  it('labels a self-checked version as not yet qualified and ignores an unknown mode', () => {
    const features = featureSupport('2.0.33'); features['http-delivery'] = { support: 'compatible', available: true, check: { state: 'waiting' } };
    const parsed = parseCompanionSetup({ ...valid, runtimeVersion: '2.0.33', compatibility: { profile: null, mode: 'self-checked', activity: 'listening', features } })!;
    expect(companionCompatibilityMarkup(parsed)).toContain('OpenCode 2.0.33 · self-checked, not yet qualified');
    expect(companionCompatibilityMarkup(parsed)).toContain('token accounting are unverified');
    const unknown = parseCompanionSetup({ ...valid, runtimeVersion: '2.0.33', compatibility: { profile: null, mode: 'trusted', activity: 'listening', features } })!;
    expect(unknown.compatibility && 'mode' in unknown.compatibility).toBe(false);
    expect(companionCompatibilityMarkup(unknown)).not.toContain('qualified.');
  });
});
