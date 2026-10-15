import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { minifyGuest } from './minify-guest.ts';
import { internStrings } from './intern-strings.ts';

test('guest compression is deterministic and preserves bridge keys, getter reads and frame-local variables', async () => {
  const source = `(() => {
    let reads = 0;
    const rates = { get promptTps() { reads += 1; return 1200; }, promptWindowMs: 2350, decodeTps: 43.8, windowMs: 4000 };
    capture({ rates: { ...rates }, getter: rates.promptTps, reads });
  })();`;
  const run = (code: string) => {
    const results: unknown[] = [], context = { capture: (value: unknown) => results.push(value) };
    runInNewContext(code, context);
    return { results: JSON.parse(JSON.stringify(results)), globals: Object.keys(context) };
  };
  const compressed = await minifyGuest(source);
  expect(await minifyGuest(source)).toBe(compressed);
  expect(compressed.length).toBeLessThan(source.length);
  expect(run(compressed)).toEqual(run(source));
  expect(run(compressed).globals).toEqual(['capture']);
});

test('a dynamic SDK script still works after function compression', async () => {
  const source = `(() => {
    function install(document) { document.installed += 1; }
    capture('(' + install.toString() + ')(document);');
  })();`;
  const scripts: string[] = [];
  runInNewContext(await minifyGuest(source), { capture: (script: string) => scripts.push(script) });
  const document = { installed: 0 };
  runInNewContext(scripts[0]!, { document });
  expect(document.installed).toBe(1);
});

test('parse failure never overwrites the SDK bundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-minify-'));
  try {
    const path = join(dir, 'guest.js'), source = '(() => { invalid syntax } )();';
    await writeFile(path, source);
    const process = Bun.spawn([Bun.which('bun')!, join(import.meta.dir, 'minify-guest.ts'), path], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect(exitCode).not.toBe(0);
    expect(await readFile(path, 'utf8')).toBe(source);
    await expect(minifyGuest('')).rejects.toThrow('no bundle');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('repeated strings share values without changing wire keys, directives or serialized callbacks', async () => {
  const source = `(() => {
    'use strict';
    function install(document) { document.push('Repeated string used inside a serialized function'); document.push('Repeated string used inside a serialized function'); }
    capture({ key: 'A long repeated bridge value', ['A long repeated bridge value']: 'A long repeated bridge value', text: 'A long repeated bridge value', last: 'A long repeated bridge value' });
    capture('(' + install.toString() + ')(document)');
  })();`;
  const run = (code: string) => {
    const values: unknown[] = [], context = { capture: (value: unknown) => values.push(value) };
    runInNewContext(code, context);
    const document: string[] = [];
    runInNewContext(String(values[1]), { document });
    return { value: JSON.parse(JSON.stringify(values[0])), document, globals: Object.keys(context) };
  };
  const compressed = await minifyGuest(source);
  expect(run(compressed)).toEqual(run(source));
  expect(await minifyGuest(source)).toBe(compressed);
});


test('pooled literals retain token boundaries beside keywords', async () => {
  const source = `(() => {
    const x = {'A long repeated value': true};
    switch ('A long repeated value') { case 'A long repeated value': capture('A long repeated value' in x); }
    capture(typeof x === 'object');
  })();`;
  const values: unknown[] = [];
  runInNewContext(await minifyGuest(source), { capture: (value: unknown) => values.push(value) });
  expect(values).toEqual([true, true]);
});

test('property-name interning preserves exact keys, getters, optional access and prototype semantics', async () => {
  const source = `(() => {
    const x = { __proto__: null, veryLongMeasurementProperty: 12, get veryLongMeasurementGetter() { return this.veryLongMeasurementProperty; } };
    x.veryLongMeasurementProperty += 3;
    x.veryLongMeasurementProperty += x.veryLongMeasurementGetter;
    capture([x.veryLongMeasurementProperty, x?.veryLongMeasurementProperty, x.veryLongMeasurementGetter, x?.veryLongMeasurementGetter, Object.keys(x), Object.getPrototypeOf(x)]);
    const y = null; capture(y?.veryLongMeasurementProperty);
  })();`;
  const run = (code: string) => { const out: unknown[] = []; runInNewContext(code, { capture: (x: unknown) => out.push(x) }); return JSON.stringify(out); };
  expect(run(await minifyGuest(source))).toBe(run(source));
});


test('the actual SDK scrollbar installer remains self-contained when serialized from the minified bundle', async () => {
  const sdk = (await readFile(new URL('../node_modules/@openchamber/sdk/dist/scrollbar-style.js', import.meta.url), 'utf8')).replace(/\bexport /g, '');
  const scripts: string[] = [];
  runInNewContext(await minifyGuest(`(() => { ${sdk}; capture(GUEST_SCROLLBAR_SCRIPT); })();`), { capture: (value: string) => scripts.push(value) });
  class Element {
    attrs = new Set<string>();
    hasAttribute(name: string) { return this.attrs.has(name); }
    setAttribute(name: string) { this.attrs.add(name); }
    removeAttribute(name: string) { this.attrs.delete(name); }
  }
  let listener: (event: { target: unknown }) => void = () => {};
  let registrations = 0;
  const root = new Element(), pending = new Map<number, () => void>();
  let seq = 0;
  const document = { documentElement: root, addEventListener: (type: string, value: typeof listener) => { expect(type).toBe('scroll'); listener = value; registrations++; } };
  const context = { document, Element, setTimeout: (fn: () => void) => { pending.set(++seq, fn); return seq; }, clearTimeout: (id: number) => pending.delete(id) };
  runInNewContext(scripts[0]!, context); runInNewContext(scripts[0]!, context);
  expect(registrations).toBe(1); expect(root.attrs.has('data-oc-scrollbar-activity')).toBe(true);
  listener({ target: document }); expect(root.attrs.has('data-oc-scrolling')).toBe(true);
  listener({ target: document }); expect(pending.size).toBe(1);
  for (const fn of pending.values()) fn();
  expect(root.attrs.has('data-oc-scrolling')).toBe(false);
});

test('escaped object-member serializers and computed toString calls keep callback source self-contained', async () => {
  const source = `(() => {
    const callbacks = { install: (document) => {
      document.push('Repeated callback value that must remain self-contained');
      document.push('Repeated callback value that must remain self-contained');
      document.push('Repeated callback value that must remain self-contained');
      document.push('Repeated callback value that must remain self-contained');
    }};
    capture(callbacks);
    capture('(' + callbacks.install['toString']() + ')(document)');
  })();`;
  const run = (code: string) => {
    let script = '';
    runInNewContext(code, { capture: (value: unknown) => { if (typeof value === 'string') script = value; } });
    const document: string[] = []; runInNewContext(script, { document }); return document;
  };
  expect(run(await minifyGuest(source))).toEqual(run(source));
});

test('serialized member aliases preserve separately declared callbacks and later assignments', async () => {
  const source = `(() => {
    function install(document) {
      document.push('Repeated callback value that must remain self-contained');
      document.push('Repeated callback value that must remain self-contained');
      document.push('Repeated callback value that must remain self-contained');
      document.push('Repeated callback value that must remain self-contained');
    }
    const callbacks = {};
    const alias = callbacks;
    callbacks.install = install;
    capture(callbacks); capture(alias);
    capture('(' + alias.install.toString() + ')(document)');
  })();`;
  const run = (code: string) => {
    let script = '';
    runInNewContext(code, { capture: (value: unknown) => { if (typeof value === 'string') script = value; } });
    const document: string[] = []; runInNewContext(script, { document }); return document;
  };
  expect(run(await minifyGuest(source))).toEqual(run(source));
});

test('serialized direct aliases and spread members remain independent of the string pool', async () => {
  const source = `(() => {
    const install = (document) => {
      document.push('Repeated callback value that must remain self-contained');
      document.push('Repeated callback value that must remain self-contained');
      document.push('Repeated callback value that must remain self-contained');
      document.push('Repeated callback value that must remain self-contained');
    };
    const callbacks = { install };
    const spread = { ...callbacks };
    const alias = install;
    capture(callbacks); capture(spread); capture(alias);
    capture('(' + alias.toString() + ')(document)');
    capture('(' + spread.install.toString() + ')(document)');
  })();`;
  const run = (code: string) => {
    const scripts: string[] = [];
    runInNewContext(code, { capture: (value: unknown) => { if (typeof value === 'string') scripts.push(value); } });
    const document: string[] = []; for (const script of scripts) runInNewContext(script, { document }); return document;
  };
  expect(run(await minifyGuest(source))).toEqual(run(source));
});

test('serializer protection resolves lexical bindings without shielding a shadowed numeric or object name', () => {
  const source = `(() => {
    function serialize() {
      const r = { install: (document) => {
        document.push('Serialized callback string must remain independent');
        document.push('Serialized callback string must remain independent');
        document.push('Serialized callback string must remain independent');
      }};
      capture('(' + r.install.toString() + ')(document)');
    }
    function numeric() { const r = 10; capture(r.toString()); }
    function unrelated() { const r = {
      first: 'A large repeated value outside the protected binding',
      second: 'A large repeated value outside the protected binding',
      third: 'A large repeated value outside the protected binding',
      fourth: 'A large repeated value outside the protected binding'
    }; capture(r); }
    serialize(); numeric(); unrelated();
  })();`;
  const pooled = internStrings(source);
  expect(pooled.match(/A large repeated value outside the protected binding/g)).toHaveLength(1);
  expect(pooled.match(/Serialized callback string must remain independent/g)).toHaveLength(3);
  const results: unknown[] = []; runInNewContext(pooled, { capture: (value: unknown) => results.push(value) });
  const document: string[] = []; runInNewContext(String(results[0]), { document }); expect(document).toHaveLength(3);
  expect(results[1]).toBe('10');
});
