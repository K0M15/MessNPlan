import pino from 'pino';
import { config, isDevelopment, isTest } from './config.js';

export const logger = pino({
  level: isTest ? 'silent' : config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.body.password',
      '*.password',
      '*.passwordHash',
      '*.accessTokenEnc',
      '*.refreshTokenEnc',
    ],
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
