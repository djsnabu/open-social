import { createApp } from './app.js';
import { readConfig } from './config.js';

process.umask(0o077);
const app = await createApp(readConfig());
app.server.listen(app.config.port, app.config.host, () => console.log(`Open Social: ${app.config.origin} (publishing ${app.config.publishingEnabled ? 'enabled' : 'disabled'})`));
const interval = setInterval(() => app.scheduler.tick().catch(() => console.error('Scheduler error; check the post status.')), 2000);
interval.unref();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  const closed = new Promise(resolve => app.server.close(resolve));
  while (app.scheduler.running) await new Promise(resolve => setTimeout(resolve, 100));
  await closed;
  app.db.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
