import type { ProblemDetails } from '@projectplaner/shared';

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly errors?: ValidationIssue[];

  constructor(
    status: number,
    title: string,
    detail?: string,
    options?: { type?: string; errors?: ValidationIssue[] },
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
    this.status = status;
    this.title = title;
    this.type = options?.type ?? 'about:blank';
    this.errors = options?.errors;
  }

  toProblem(instance?: string): ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.message && this.message !== this.title ? { detail: this.message } : {}),
      ...(instance ? { instance } : {}),
      ...(this.errors ? { errors: this.errors } : {}),
    };
  }
}

export const badRequest = (detail?: string) =>
  new ApiError(400, 'Bad Request', detail, { type: 'urn:projectplaner:bad-request' });

export const unauthorized = (detail?: string) =>
  new ApiError(401, 'Unauthorized', detail ?? 'Anmeldung erforderlich', {
    type: 'urn:projectplaner:unauthorized',
  });

export const forbidden = (detail?: string) =>
  new ApiError(403, 'Forbidden', detail ?? 'Keine Berechtigung', {
    type: 'urn:projectplaner:forbidden',
  });

export const notFound = (detail?: string) =>
  new ApiError(404, 'Not Found', detail, { type: 'urn:projectplaner:not-found' });

export const conflict = (detail?: string) =>
  new ApiError(409, 'Conflict', detail, { type: 'urn:projectplaner:conflict' });

export const unprocessable = (errors: ValidationIssue[], detail?: string) =>
  new ApiError(422, 'Unprocessable Entity', detail ?? 'Validierung fehlgeschlagen', {
    type: 'urn:projectplaner:validation',
    errors,
  });

export const tooManyRequests = (detail?: string) =>
  new ApiError(429, 'Too Many Requests', detail, { type: 'urn:projectplaner:rate-limit' });
