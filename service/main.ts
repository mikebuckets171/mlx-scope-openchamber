import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { RuntimeClient } from './runtime-client.ts';
import { HostSampler } from './host/sampler.ts';
import { historySources, ServiceHistory } from './history/history.ts';
import { createExec } from './lib/argv.ts';
import { createScopeServer } from './server.ts';

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
// Everything the service remembers lives in memory and is filled only by view-driven reads (P5).
const history = new ServiceHistory(instance, { energy: (from, to) => host.energy(from, to) });
const server = createScopeServer(token, {
  read: (selection, request) => client.read(selection, request), host: context => host.sample(context), history,
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
  server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 2_000).unref();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('exit', () => { client.dispose(); host.dispose(); });
server.listen(port, '127.0.0.1');
