// The SDK's `@openchamber/sdk/ui` entry also evaluates every UI primitive's stylesheet (≈ 17 KB the bundler cannot drop:
// its `tone()` calls might have side effects). The panel uses only the host-theme helper, so it imports that module alone,
// from the pinned SDK (2.0.4, bun.lock).
import { applyHostReady as applySdkHostReady, type ThemeRoot } from '../node_modules/@openchamber/sdk/dist/ui/theme.js';

/** Replace the whole palette on each ready event. A missing host token must clear its previous CSS value so the
 * panel's current-theme fallback can apply. SDK 2.0.4's guest bridge trusts the host payload without checking tokens. */
export const applyHostReady = (context: Parameters<typeof applySdkHostReady>[0], root: ThemeRoot): void => {
  applySdkHostReady(context, {
    dataset: root.dataset,
    style: {
      get colorScheme() { return root.style.colorScheme; },
      set colorScheme(value: string) { root.style.colorScheme = value; },
      setProperty: (name, value) => root.style.setProperty(name, typeof value === 'string' ? value : ''),
    },
  });
};
