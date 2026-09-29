// Fails when files headed for the public repository carry private data: home paths, credentials, real
// request or session identifiers, or private-network addresses. Fixtures, receipts and spike notes must be
// synthetic or scrubbed (see CONTRIBUTING.md). Bundles and images are not scanned.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const ROOTS = ['tests/', 'docs/', 'scripts/', 'service/', 'panel/', 'src/', 'README.md', 'CHANGELOG.md', 'PRIVACY.md', 'SECURITY.md', 'CONTRIBUTING.md'];
const SKIP = /(^|\/)(main\.js|.*\.(png|jpe?g|gif|ico|zip|svg))$/;
const RULES: Array<{ name: string; pattern: RegExp; allow?: RegExp }> = [
  { name: 'home path', pattern: /\/Users\/[A-Za-z0-9._-]+/g, allow: /^\/Users\/(someone|fixture|USER)$/ },
  { name: 'home path', pattern: /\/home\/[a-z][A-Za-z0-9._-]*/g, allow: /^\/home\/(someone|fixture|user)$/ },
  { name: 'credential', pattern: /\b(?:sk-[A-Za-z0-9]{16,}|gh[opsu]_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,})/g },
  { name: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/g },
  { name: 'api_key value', pattern: /"api_key"\s*:\s*"[^"]{6,}"/g, allow: /"api_key"\s*:\s*"(do-not-export|redacted|fixture[^"]*)"/ },
  { name: 'UUID', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, allow: /^0{8}-/ },
  { name: 'private network address', pattern: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/g },
];

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter(file => file && ROOTS.some(root => file === root || file.startsWith(root)) && !SKIP.test(file));
const findings: string[] = [];
for (const file of tracked) {
  let text: string;
  try { if (statSync(file).size > 4_000_000) continue; text = readFileSync(file, 'utf8'); } catch { continue; }
  text.split('\n').forEach((line, index) => {
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        if (rule.allow?.test(match[0])) continue;
        findings.push(`${file}:${index + 1}: ${rule.name}: ${match[0].slice(0, 12)}…`);
      }
    }
  });
}
if (findings.length) {
  console.error(`Private data in files headed for the repository (${findings.length}):\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`PASS: ${tracked.length} files free of home paths, credentials, identifiers and private addresses.`);
