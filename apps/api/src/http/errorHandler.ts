import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger.js';
import { ApiError, conflict, unprocessable } from '../errors.js';

interface HttpErrorLike {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  type?: unknown;
  message?: unknown;
}

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
};

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    type: 'urn:projectplaner:not-found',
    title: 'Not Found',
    status: 404,
    detail: `Route ${req.method} ${req.path} existiert nicht`,
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    if (err.status >= 500) {
      logger.error({ err, path: req.path }, err.title);
    }
    res
      .status(err.status)
      .type('application/problem+json')
      .json(err.toProblem(req.originalUrl));
    return;
  }

  if (err instanceof ZodError) {
    const apiError = unprocessable(
      err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
    res
      .status(apiError.status)
      .type('application/problem+json')
      .json(apiError.toProblem(req.originalUrl));
    return;
  }

  if (err && typeof err === 'object') {
    const httpErr = err as HttpErrorLike;

    // Doppelte Schlüssel (Unique-Index) → 409 statt 500
    if (httpErr.code === 'ER_DUP_ENTRY') {
      const apiError = conflict('Ein Eintrag mit diesen Werten existiert bereits');
      res
        .status(apiError.status)
        .type('application/problem+json')
        .json(apiError.toProblem(req.originalUrl));
      return;
    }

    // Body-Parser- und ähnliche Fehler mit HTTP-Status (z. B. ungültiges JSON → 400)
    const rawStatus =
      typeof httpErr.status === 'number'
        ? httpErr.status
        : typeof httpErr.statusCode === 'number'
          ? httpErr.statusCode
          : null;
    if (rawStatus !== null && rawStatus >= 400 && rawStatus < 500) {
      const parseFailed = httpErr.type === 'entity.parse.failed';
      const apiError = new ApiError(
        rawStatus,
        STATUS_TITLES[rawStatus] ?? 'Bad Request',
        parseFailed
          ? 'Ungültiger JSON-Body'
          : typeof httpErr.message === 'string'
            ? httpErr.message
            : undefined,
      );
      res
        .status(apiError.status)
        .type('application/problem+json')
        .json(apiError.toProblem(req.originalUrl));
      return;
    }
  }

  logger.error({ err, path: req.path }, 'Unbehandelter Fehler');
  res.status(500).type('application/problem+json').json({
    type: 'urn:projectplaner:internal',
    title: 'Internal Server Error',
    status: 500,
    detail: 'Unerwarteter Fehler. Bitte Logs prüfen.',
  });
}
