// Pure checks behind scripts/verify-package.ts (plan §6 and §8.1), unit-tested in package-checks.test.ts.

/** The G1 exec freeze (SPIKES "Frozen permission set"): exactly these ten, in this order. */
export const EXEC_G1 = [
  '/usr/bin/vm_stat', '/usr/sbin/sysctl', '/usr/sbin/ioreg', '/usr/bin/notifyutil', '/usr/sbin/lsof', '/usr/bin/footprint',
  '~/.lmstudio/bin/lms', '~/.cache/lm-studio/bin/lms', '/opt/homebrew/bin/macmon', '/usr/local/bin/macmon',
] as const;
/** Bytes, 1 KB = 1,000 (the stricter reading of plan §6). */
// The theme-native layout and Session widget allow 2 KB above the original 2.0 view budget; probes stay unchanged.
// The bounded private prompt-progress consumer adds 10 KB to the service allowance; guest ceilings stay unchanged.
export const BUNDLE_CEILINGS = { 'panel/main.js': 264_000, 'service/main.js': 180_000, 'background/main.js': 25_000 } as const;
export const GUEST_BUNDLES = ['panel/main.js', 'background/main.js'] as const;
export const COMMAND = { name: 'scope', description: 'Attach a private MLX Scope diagnostics summary' } as const;
export const STATUS_SECTION = { entry: 'panel/index.html', title: 'MLX Scope', height: 72 } as const;
export const BACKGROUND_ENTRY = 'background/index.html';
export const SDK_VERSION = '2.0.4';
export const ENGINES_FLOOR = '>=2.0.4';

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Every way the manifest departs from the §6 set with the G1/S2 amendments (no capabilities, no sessions). */
export const manifestProblems = (pkg: unknown): string[] => {
  const root = obj(pkg), openchamber = obj(root?.openchamber), contributes = obj(openchamber?.contributes);
  const service = obj(contributes?.service), exec = obj(service?.permissions)?.exec;
  const problems: string[] = [];
  const expect = (ok: boolean, message: string): void => { if (!ok) problems.push(message); };
  expect(openchamber?.apiVersion === 1, 'openchamber.apiVersion must be 1');
  expect(obj(openchamber?.engines)?.openchamber === ENGINES_FLOOR, `engines.openchamber must be "${ENGINES_FLOOR}"`);
  expect(obj(root?.dependencies)?.['@openchamber/sdk'] === SDK_VERSION, `@openchamber/sdk must be pinned to ${SDK_VERSION}`);
  expect(!contributes || !('capabilities' in contributes), 'contributes.capabilities must be absent (S2: sessions dropped)');
  expect(same(contributes?.statusSection, STATUS_SECTION), `contributes.statusSection must be ${JSON.stringify(STATUS_SECTION)}`);
  expect(same(contributes?.background, { entry: BACKGROUND_ENTRY }), `contributes.background must be {"entry":"${BACKGROUND_ENTRY}"}`);
  expect(same(contributes?.commands, [COMMAND]), `contributes.commands must be exactly [${JSON.stringify(COMMAND)}]`);
  expect(contributes?.page === true, 'contributes.page must be true');
  expect(Array.isArray(contributes?.actions) && (contributes.actions as unknown[]).some(action =>
    obj(action)?.id === 'open-mlx-scope' && obj(action)?.where === 'session'), 'the open-mlx-scope session action must stay');
  expect(same(exec, EXEC_G1), `service exec must be exactly the ${EXEC_G1.length} G1 entries, in order`);
  return problems;
};

// A whole string literal that names an executable: an absolute bin path, or `~/.x/…/bin/y` / `.x/…/bin/y` under HOME.
// Matched between quotes directly (a path holds no quote), so a minified bundle needs no tokenizer.
const EXECUTABLE = /(?<=["'`])(\/(?:usr\/(?:local\/)?)?s?bin\/[\w.+-]+|\/usr\/libexec\/[\w.+-]+|\/opt\/[\w.+/-]*?\/s?bin\/[\w.+-]+|(?:~\/)?\.[\w-][\w.-]*(?:\/[\w.-]+)*\/s?bin\/[\w.+-]+)(?=["'`])/g;
/** String literals in a bundle that name an executable; HOME-relative ones as `~/…`, the manifest's spelling. */
export const spawnPaths = (bundle: string): string[] =>
  [...new Set([...bundle.matchAll(EXECUTABLE)].map(match => match[1]!.startsWith('.') ? `~/${match[1]}` : match[1]!))].sort();
/**
 * The two-way exec match (plan §6): every declared entry appears in the service bundle as the literal it spawns
 * (`~/…` entries as their HOME-relative form), and every executable literal in the bundle is declared.
 */
export const execMatch = (declared: readonly string[], bundle: string): { unspawned: string[]; undeclared: string[] } => {
  const found = spawnPaths(bundle);
  return { unspawned: declared.filter(entry => !found.includes(entry)), undeclared: found.filter(entry => !declared.includes(entry)) };
};

/** The CSP a page declares in its `<meta http-equiv="Content-Security-Policy">`, or null. */
export const cspOf = (html: string): string | null => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/http-equiv\s*=\s*["']content-security-policy["']/i.test(tag)) continue;
    return /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bcontent\s*=\s*'([^']*)'/i.exec(tag)?.[1] ?? null;
  }
  return null;
};

/**
 * Host-only code or private values a guest (panel or background) bundle must never contain. Exec paths are not on the
 * list: the approved needs-approval card shows them as text (2.0-mock "What the approval lists").
 */
export const GUEST_LEAKS = ['node:os', 'node:fs', 'node:child_process', 'MLX_SCOPE_API_KEY', 'LMS_API_SERVER_INFO_PATH', '/Users/'] as const;
export const guestLeaks = (bundle: string): string[] => GUEST_LEAKS.filter(secret => bundle.includes(secret));
/** The service may spawn and read config, but never reads OpenChamber's own settings (client tokens, relay keys). */
export const serviceLeaks = (bundle: string): string[] =>
  [/openchamber[\\/"'`, ]+settings\.json/i, /\/Users\//].filter(pattern => pattern.test(bundle)).map(String);

/** `--name: value` declarations of a CSS block, in order. */
export const tokenDeclarations = (css: string): Array<[string, string]> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;{\s])([-a-z0-9]+)\s*:\s*([^;{}]+);/g)].map(match => [match[1]!, match[2]!.trim()]);
/** The `:root { … }` block of a stylesheet (the first one). */
export const rootBlock = (css: string): string | null => /(^|\n):root\s*\{([^}]*)\}/.exec(css)?.[2] ?? null;
