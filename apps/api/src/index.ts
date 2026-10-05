import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { closeDatabase } from './db/client.js';
import { logger } from './logger.js';
import { closeRealtime, initRealtime } from './realtime.js';

const app = createApp();
const server = http.createServer(app);
initRealtime(server);

server.listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT, env: config.NODE_ENV }, 'ProjectPlaner-API gestartet');
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Fahre API herunter');

  const forceExit = setTimeout(() => {
    logger.warn('Erzwungenes Beenden nach Timeout');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeRealtime();
  await closeDatabase();
  logger.info('Shutdown abgeschlossen');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled Rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught Exception – beende Prozess');
  process.exit(1);
});
