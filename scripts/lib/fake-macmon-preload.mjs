// Measurement-only preload (`node --import`), used by scripts/measure-overhead.mjs for its macmon runs. It makes the
// measured service see an installed /opt/homebrew/bin/macmon and runs scripts/lib/fake-macmon.mjs in its place (one
// synthetic NDJSON line per second). The service's own code, argv and allowlist are unchanged; macmon itself never runs.
// Load it before spawn-log-preload.mjs so the spawn log records the executable the service asked for.
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const fake = process.env.MLX_SCOPE_MEASURE_FAKE_MACMON;
const MACMON = '/opt/homebrew/bin/macmon';
if (fake) {
  const access = fs.accessSync;
  fs.accessSync = function measuredAccess(file, mode) {
    return file === MACMON ? undefined : access.call(this, file, mode);
  };
  const spawn = cp.spawn;
  cp.spawn = function measuredMacmon(file, args, options) {
    return file === MACMON ? spawn.call(this, process.execPath, [fake, ...args], options) : spawn.apply(this, arguments);
  };
  syncBuiltinESMExports();
}
