import { Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { loginSchema } from '@projectplaner/shared';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  generateRefreshToken,
  hashToken,
  refreshTokenExpiry,
  signAccessToken,
} from '../auth/tokens.js';
import { db } from '../db/client.js';
import { refreshTokens, users } from '../db/schema.js';
import { isDevelopment } from '../config.js';
import { forbidden, tooManyRequests, unauthorized } from '../errors.js';
import {
  clearAuthCookies,
  REFRESH_COOKIE,
  requireAuth,
  setAuthCookies,
} from '../http/auth.js';
import { parse } from '../http/parse.js';
import { toUserDto } from '../services/dto.js';

let dummyHash: string | null = null;
async function getDummyHash(): Promise<string> {
  dummyHash ??= await hashPassword('timing-equalization-placeholder');
  return dummyHash;
}

export function authRoutes(): Router {
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    // In Entwicklung (und damit auch E2E-Läufen gegen den Dev-Stack) großzügiger.
    limit: isDevelopment ? 100 : 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(tooManyRequests('Zu viele Login-Versuche, bitte warten')),
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    const hashToCheck = user?.passwordHash ?? (await getDummyHash());
    const passwordOk = await verifyPassword(hashToCheck, password);

    if (!user || !passwordOk) {
      throw unauthorized('E-Mail oder Passwort ist falsch');
    }
    if (!user.isActive) {
      throw forbidden('Benutzerkonto ist deaktiviert');
    }

    const accessToken = await signAccessToken(user);
    const refreshToken = generateRefreshToken();
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshTokenExpiry(),
      ip: req.ip?.slice(0, 45),
      userAgent: req.headers['user-agent']?.slice(0, 255),
    });

    setAuthCookies(res, accessToken, refreshToken);
    res.json({ user: toUserDto(user) });
  });

  router.post('/refresh', async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) throw unauthorized('Kein Refresh-Token vorhanden');

    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(token)))
        .limit(1);

      if (!row || row.expiresAt.getTime() <= Date.now()) {
        return { kind: 'invalid' as const };
      }

      if (row.revokedAt) {
        // Reuse eines bereits rotierten Tokens → gesamte Token-Familie widerrufen.
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.userId, row.userId), isNull(refreshTokens.revokedAt)));
        return { kind: 'reuse' as const };
      }

      // Konditionales Widerrufen: bei parallelen Requests gewinnt genau einer.
      const [revoked] = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)));

      if (revoked.affectedRows === 0) {
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.userId, row.userId), isNull(refreshTokens.revokedAt)));
        return { kind: 'reuse' as const };
      }

      const [user] = await tx.select().from(users).where(eq(users.id, row.userId)).limit(1);
      if (!user || !user.isActive) return { kind: 'invalid' as const };

      // Rotation: alter Token ist widerrufen, neuer wird in derselben Transaktion ausgegeben.
      const newRefresh = generateRefreshToken();
      await tx.insert(refreshTokens).values({
        userId: user.id,
        tokenHash: hashToken(newRefresh),
        expiresAt: refreshTokenExpiry(),
        ip: req.ip?.slice(0, 45),
        userAgent: req.headers['user-agent']?.slice(0, 255),
      });
      return { kind: 'ok' as const, user, newRefresh };
    });

    if (outcome.kind === 'reuse') {
      clearAuthCookies(res);
      throw unauthorized('Refresh-Token wurde bereits verwendet – alle Sitzungen wurden beendet');
    }
    if (outcome.kind === 'invalid') {
      clearAuthCookies(res);
      throw unauthorized('Refresh-Token ungültig oder abgelaufen');
    }

    setAuthCookies(res, await signAccessToken(outcome.user), outcome.newRefresh);
    res.json({ user: toUserDto(outcome.user) });
  });

  router.post('/logout', async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (token) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.tokenHash, hashToken(token)));
    }
    clearAuthCookies(res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
    if (!user || !user.isActive) throw unauthorized();
    res.json({ user: toUserDto(user) });
  });

  return router;
}
