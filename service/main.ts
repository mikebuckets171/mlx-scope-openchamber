import { homedir } from 'node:os';
import { RuntimeClient } from './runtime-client.ts';
import { LMStudioActivityStream } from './lmstudio-activity.ts';
import { HostSampler } from './host/sampler.ts';
import { createExec } from './lib/argv.ts';
import { createScopeServer } from './server.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!Number.isInteger(port) || port < 1 || port > 65_535 || token.length === 0) {
  console.error('OpenChamber service port and token are required.');
  process.exit(1);
}
const client = new RuntimeClient({ lmstudioActivity: new LMStudioActivityStream() });
const home = homedir();
const host = new HostSampler({ exec: createExec(home), now: Date.now, home });
const server = createScopeServer(token, {
  read: selection => client.read(selection), host: context => host.sample(context), completionHead: () => client.completionHead,
});
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
