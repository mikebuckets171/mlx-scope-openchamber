import { expect, test } from 'bun:test';
import { readHostMessage } from '@openchamber/sdk';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

type PreviewEvent = { source: unknown; data: Record<string, unknown> };

// Exercise the actual development fixture, not a duplicate protocol object.
// Only this repository's trusted inline script is evaluated in the test context.
test.each(['storage', 'clipboard'] as const)('preview %s failures match the pinned SDK wire contract', kind => {
  const html = readFileSync(new URL('../tests/browser/host.html', import.meta.url), 'utf8');
  const source = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!source) throw Error('Preview script missing');
  const replies: unknown[] = [];
  const listeners: Array<(event: PreviewEvent) => void> = [];
  const contentWindow = { postMessage: (message: unknown) => replies.push(message) };
  const context = {
    document: { querySelector: () => ({ contentWindow }) }, URLSearchParams,
    location: { search: `?${kind}=fail`, origin: 'http://127.0.0.1:9999' },
    window: { addEventListener: (_type: string, listener: (event: PreviewEvent) => void) => listeners.push(listener) },
  };
  runInNewContext(source, context, { timeout: 500 });
  expect(listeners).toHaveLength(1);
  listeners[0]!({ source: contentWindow, data: {
    channel: 'openchamber.sdk', v: 1, id: 'fixture-failure',
    type: kind === 'storage' ? 'storage' : 'clipboard-write',
    payload: { op: 'set', key: 'view.compact', value: true, text: 'Fixture reading' },
  } });
  expect(replies).toHaveLength(1);
  expect(readHostMessage(replies[0])).toMatchObject({
    type: 'result', id: 'fixture-failure', ok: false,
    code: 'HOST_REJECTED', error: `Fixture ${kind} failure`,
  });
});
