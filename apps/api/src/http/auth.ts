import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@projectplaner/shared';
import { verifyAccessToken } from '../auth/tokens.js';
import { config, isOriginAllowed } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const ACCESS_COOKIE = 'pp_at';
export const REFRESH_COOKIE = 'pp_rt';

const REFRESH_PATH = '/api/v1/auth';

const cookieBase = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: config.COOKIE_SECURE,
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...cookieBase,
    path: '/',
    maxAge: config.ACCESS_TOKEN_TTL * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...cookieBase,
    path: REFRESH_PATH,
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: REFRESH_PATH });
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  if (!token) {
    next(unauthorized());
    return;
  }
  const payload = await verifyAccessToken(token);
  if (!payload) {
    next(unauthorized('Token ungültig oder abgelaufen'));
    return;
  }
  req.user = {
    id: Number(payload.sub),
    email: payload.email,
    name: payload.name,
    role: payload.role,
  };
  next();
}

/** Erlaubt Zugriff für die angegebenen globalen Rollen (admin immer). */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (req.user.role === 'admin' || roles.includes(req.user.role)) {
      next();
      return;
    }
    next(forbidden());
  };
}

/** Origin-Prüfung für zustandsändernde Requests (CSRF-Schutz neben SameSite=strict). */
export function originCheck(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (!origin) {
    // Requests ohne Origin (z. B. Server-zu-Server, Tests) sind erlaubt,
    // solange sie kein Cookie vortäuschen können – Browser senden immer Origin.
    next();
    return;
  }
  if (isOriginAllowed(origin)) {
    next();
    return;
  }
  next(forbidden('Origin nicht erlaubt'));
}
