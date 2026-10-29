import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatDestination, createChatSource } from './chat-source.ts';
import { ChatTelemetry } from './chat-telemetry.ts';
import { createCompanionSetup } from './companion-setup.ts';
import { RuntimeClient } from './runtime-client.ts';
import { HostSampler } from './host/sampler.ts';
import { historySources, ServiceHistory } from './history/history.ts';
import { createExec } from './lib/argv.ts';
import { createScopeServer } from './server.ts';
import { MediaService } from './media/service.ts';
import { createMediaSetup } from './media/setup.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!Number.isInteger(port) || port < 1 || port > 65_535 || token.length === 0) {
  console.error('OpenChamber service port and token are required.');
  process.exit(1);
}
// Ten idle minutes without a view request end the process; OpenChamber starts it again on the next request. The
// measurement harness may shorten this (never below 5 s); nothing else sets it.
const IDLE_EXIT_MS = Math.max(5_000, Number(process.env.MLX_SCOPE_IDLE_EXIT_MS) || 600_000);
// One instance id per service start: the completion seqs, the frames' tags and the snapshot's service identity share it.
const instance = randomBytes(4).toString('hex');
const home = homedir();
const exec = createExec(home);
const client = new RuntimeClient({ exec });
const host = new HostSampler({ exec, now: Date.now, home });
const chat = new ChatTelemetry(home);
const companionSetup = createCompanionSetup({ home, bundleDirectory: resolve(dirname(fileURLToPath(import.meta.url)), '../bridge/opencode'), probe: () => chat.probe() });
const media = new MediaService({ home, env: process.env, exec });
const mediaSetup = createMediaSetup({ home, bundleDirectory: resolve(dirname(fileURLToPath(import.meta.url)), '../bridge/comfyui'), sources: () => media.configurations(), snapshot: () => media.snapshot(), invalidate: enabled => media.invalidate(enabled) });
// Everything the service remembers lives in memory and is filled only by view-driven reads (P5).
const history = new ServiceHistory(instance, { energy: (from, to) => host.energy(from, to) });
const server = createScopeServer(token, {
  read: (selection, request) => client.read(selection, request), host: context => host.sample(context), history,
  companionSetup,
  media,
  mediaSetup,
  connections: () => client.connections(),
  chatDestination: createChatDestination(client),
  chat: createChatSource(chat, client),
  ...historySources(history, { now: Date.now, readUsage: query => client.usage(query) }),
}, { instance, idleExitMs: IDLE_EXIT_MS, onIdle: () => stop() });
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error('MLX Scope could not start its local service.', error);
  process.exit(1);
});
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  client.dispose();
  host.dispose();
  // Remove this service's chat demand before exiting, so a helper stops observing at once rather than at expiry.
  void Promise.resolve().then(() => chat.dispose()).catch(() => {}).finally(() => server.close(() => process.exit(0)));
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 2_000).unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('exit', () => { client.dispose(); host.dispose(); });
server.listen(port, '127.0.0.1');
// An updated Scope brings the helper it installed up to date without waiting for Update chat speed.
void companionSetup.update();
