import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatDestination, createChatSource } from './chat-source.ts';
import { ChatTelemetry } from './chat-telemetry.ts';
import { createCompanionSetup } from './companion-setup.ts';
import { RuntimeClient } from './runtime-client.ts';
import { HostSampler } from './host/sampler.ts';
import { historySources, ServiceHistory } from './history/history.ts';
import { createExec, localVideoCancelArgv } from './lib/argv.ts';
import { createScopeServer } from './server.ts';
import { MediaService } from './media/service.ts';
import { createMediaSetup } from './media/setup.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!Number.isInteger(port) || port < 1 || port > 65_535 || token.length === 0) {
  console.error('OpenChamber service port and token are required.');
  process.exit(1);
}
// One instance id per service start: the completion seqs, the frames' tags and the snapshot's service identity share it.
const instance = randomBytes(4).toString('hex');
const home = homedir();
const exec = createExec(home);
const client = new RuntimeClient({ exec });
const host = new HostSampler({ exec, now: Date.now, home });
const chat = new ChatTelemetry(home);
const companionSetup = createCompanionSetup({ home, bundleDirectory: resolve(dirname(fileURLToPath(import.meta.url)), '../bridge/opencode'), probe: () => chat.probe() });
const media = new MediaService({ home, env: process.env, cancelLocalVideo: async id => {
  const argv = localVideoCancelArgv(id, home); if (!argv) return false;
  const text = await exec(argv); if (!text) return false;
  try { const result = JSON.parse(text); return result?.ok === true && result?.id === id && ['cancelling', 'cancelled'].includes(result?.state); } catch { return false; }
}, localVideoDirectory: join(home, '.config/opencode/state/video-queue') });
const mediaSetup = createMediaSetup({ home, bundleDirectory: resolve(dirname(fileURLToPath(import.meta.url)), '../bridge/comfyui'), sources: () => media.configurations(), invalidate: enabled => media.invalidate(enabled) });
// Everything the service remembers lives in memory and is filled only by view-driven reads (P5).
const history = new ServiceHistory(instance, { energy: (from, to) => host.energy(from, to) });
const server = createScopeServer(token, {
  read: (selection, request) => client.read(selection, request), host: context => host.sample(context), history,
  companionSetup,
  media,
  mediaSetup,
  chatDestination: createChatDestination(client),
  chat: createChatSource(chat, client),
  ...historySources(history, { now: Date.now, readUsage: query => client.usage(query) }),
}, { instance });
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error('MLX Scope could not start its local service.', error);
  process.exit(1);
});
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  client.dispose();
  host.dispose();
  void chat.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 2_000).unref();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('exit', () => { client.dispose(); host.dispose(); });
server.listen(port, '127.0.0.1');
