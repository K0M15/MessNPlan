import pino from 'pino';
import { config, isDevelopment, isTest } from './config.js';

/**
 * Pfade, deren Werte nie in Logs erscheinen dürfen. Wichtig:
 * `res.headers["set-cookie"]` enthält pp_at/pp_rt (Access-/Refresh-Token).
 */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.accessTokenEnc',
  '*.refreshTokenEnc',
] as const;

export const logger = pino({
  level: isTest ? 'silent' : config.LOG_LEVEL,
  redact: {
    paths: [...LOG_REDACT_PATHS],
    censor: '[redacted]',
  },
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});
