import { OmlxClient } from './omlx-client.ts';
import { SystemSampler } from './system.ts';
import { createScopeServer } from './server.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!Number.isInteger(port) || port < 1 || port > 65_535 || token.length === 0) {
  console.error('OpenChamber service port and token are required.');
  process.exit(1);
}
const client = new OmlxClient();
const system = new SystemSampler();
const server = createScopeServer(token, {
  snapshot: () => client.snapshot(), system: () => system.sample(),
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error('MLX Scope could not start its local service.', error);
  process.exit(1);
});
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 2_000).unref();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
server.listen(port, '127.0.0.1');
