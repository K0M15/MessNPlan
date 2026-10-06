import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS } from './logger.js';

/**
 * Regressionstest für CWE-532: pino-http loggt Response-Header, darunter
 * `set-cookie` mit pp_at/pp_rt – diese dürfen nie im Klartext erscheinen.
 */
describe('Log-Redaction', () => {
  it('redigiert Set-Cookie-Header (Access-/Refresh-Token) in Response-Logs', () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const testLogger = pino(
      { redact: { paths: [...LOG_REDACT_PATHS], censor: '[redacted]' } },
      stream,
    );

    testLogger.info(
      {
        res: {
          statusCode: 200,
          headers: {
            'set-cookie': [
              'pp_at=SECRET_ACCESS_TOKEN; Path=/; HttpOnly',
              'pp_rt=SECRET_REFRESH_TOKEN; Path=/api/v1/auth; HttpOnly',
            ],
          },
        },
      },
      'request completed',
    );

    const output = chunks.join('');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('SECRET_ACCESS_TOKEN');
    expect(output).not.toContain('SECRET_REFRESH_TOKEN');
  });

  it('redigiert Cookie- und Authorization-Request-Header', () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const testLogger = pino(
      { redact: { paths: [...LOG_REDACT_PATHS], censor: '[redacted]' } },
      stream,
    );

    testLogger.info(
      { req: { headers: { cookie: 'pp_at=SECRET', authorization: 'Bearer SECRET' } } },
      'request',
    );

    const output = chunks.join('');
    expect(output).not.toContain('SECRET');
    expect(output).toContain('[redacted]');
  });
});
