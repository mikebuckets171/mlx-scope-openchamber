// Measurement-only stand-in for `macmon pipe -i 1000`, started by fake-macmon-preload.mjs in place of macmon: one
// synthetic fixture NDJSON line per second until the service stops it. It reads no sensor, SMC or IOReport.
import { readFileSync } from 'node:fs';

const line = readFileSync(new URL('../../tests/fixtures/host/macos-27/macmon-pipe.normal.txt', import.meta.url), 'utf8').split('\n')[0];
const tick = () => { process.stdout.write(`${line}\n`); setTimeout(tick, 1_000); };
tick();
