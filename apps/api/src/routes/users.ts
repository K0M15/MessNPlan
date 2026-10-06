import { Router } from 'express';
import { and, eq, like, ne, or, sql } from 'drizzle-orm';
import { createUserSchema, paginationQuerySchema, updateUserSchema } from '@projectplaner/shared';
import { hashPassword } from '../auth/passwords.js';
import { db } from '../db/client.js';
import { refreshTokens, users } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { requireAuth, requireRole } from '../http/auth.js';
import { parse, parseId } from '../http/parse.js';
import { writeAudit } from '../services/audit.js';
import { toUserDto } from '../services/dto.js';

export function userRoutes(): Router {
  const router = Router();

  // Für alle angemeldeten Nutzer: Mitglieder-Suche (vor dem Admin-Gate).
  router.get('/lookup', requireAuth, async (req, res) => {
    const { q } = parse(paginationQuerySchema.pick({ q: true }), req.query);
    const search = q?.trim();
    const where = and(
      eq(users.isActive, true),
      search ? or(like(users.name, `%${search}%`), like(users.email, `%${search}%`)) : undefined,
    );

    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(where)
      .orderBy(users.name)
      .limit(20);

    res.json({ items: rows });
  });

  router.use(requireAuth, requireRole('admin'));

  router.get('/', async (req, res) => {
    const { page, pageSize, q } = parse(paginationQuerySchema, req.query);
    const where = q
      ? or(like(users.name, `%${q}%`), like(users.email, `%${q}%`))
      : undefined;

    const [rows, countRows] = await Promise.all([
      db
        .select()
        .from(users)
        .where(where)
        .orderBy(users.name)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ count: sql<number>`count(*)` }).from(users).where(where),
    ]);

    res.json({
      items: rows.map(toUserDto),
      page,
      pageSize,
      total: Number(countRows[0]?.count ?? 0),
    });
  });

  router.post('/', async (req, res) => {
    const input = parse(createUserSchema, req.body);
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existing) throw conflict('E-Mail-Adresse ist bereits vergeben');

    const [created] = await db
      .insert(users)
      .values({
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash: await hashPassword(input.password),
      })
      .$returningId();

    const [row] = await db.select().from(users).where(eq(users.id, created!.id)).limit(1);
    await writeAudit({
      userId: req.user!.id,
      entityType: 'user',
      entityId: created!.id,
      action: 'create',
    });
    res.status(201).json({ user: toUserDto(row!) });
  });

  router.get('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw notFound('Benutzer nicht gefunden');
    res.json({ user: toUserDto(row) });
  });

  router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const input = parse(updateUserSchema, req.body);
    const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!existing) throw notFound('Benutzer nicht gefunden');

    if (input.email && input.email !== existing.email) {
      const [emailTaken] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, input.email), ne(users.id, id)))
        .limit(1);
      if (emailTaken) throw conflict('E-Mail-Adresse ist bereits vergeben');
    }

    if (id === req.user!.id && (input.isActive === false || (input.role && input.role !== 'admin'))) {
      throw badRequest('Das eigene Admin-Konto kann nicht deaktiviert oder herabgestuft werden');
    }

    const losesAdmin =
      existing.role === 'admin' &&
      ((input.role !== undefined && input.role !== 'admin') || input.isActive === false);

    const updates: Partial<typeof users.$inferInsert> = {};
    if (input.email) updates.email = input.email;
    if (input.name) updates.name = input.name;
    if (input.role) updates.role = input.role;
    if (input.isActive !== undefined) updates.isActive = input.isActive;
    if (input.password) updates.passwordHash = await hashPassword(input.password);

    // Guard + Update in einer Transaktion mit Row-Locks: zwei gleichzeitige
    // Herabstufungen können so nicht den letzten Admin entfernen.
    await db.transaction(async (tx) => {
      if (losesAdmin) {
        const admins = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
          .for('update');
        const remaining = admins.filter((admin) => admin.id !== id);
        if (remaining.length === 0) {
          throw badRequest(
            input.isActive === false
              ? 'Der letzte aktive Administrator kann nicht deaktiviert werden'
              : 'Der letzte aktive Administrator kann nicht herabgestuft werden',
          );
        }
      }
      await tx.update(users).set(updates).where(eq(users.id, id));
    });

    if (input.isActive === false || input.password) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.userId, id));
    }

    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    await writeAudit({
      userId: req.user!.id,
      entityType: 'user',
      entityId: id,
      action: 'update',
      diff: input as Record<string, unknown>,
    });
    res.json({ user: toUserDto(row!) });
  });

  router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (id === req.user!.id) throw badRequest('Das eigene Konto kann nicht deaktiviert werden');

    const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!existing) throw notFound('Benutzer nicht gefunden');

    await db.transaction(async (tx) => {
      if (existing.role === 'admin') {
        const admins = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
          .for('update');
        const remaining = admins.filter((admin) => admin.id !== id);
        if (remaining.length === 0) {
          throw badRequest('Der letzte aktive Administrator kann nicht deaktiviert werden');
        }
      }
      await tx.update(users).set({ isActive: false }).where(eq(users.id, id));
    });

    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.userId, id));

    await writeAudit({
      userId: req.user!.id,
      entityType: 'user',
      entityId: id,
      action: 'deactivate',
    });
    res.status(204).end();
  });

  return router;
}
