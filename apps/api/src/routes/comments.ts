import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { commentCreateSchema, REALTIME_EVENTS } from '@projectplaner/shared';
import { db } from '../db/client.js';
import { comments, users } from '../db/schema.js';
import { forbidden, notFound } from '../errors.js';
import { requireAuth, type AuthUser } from '../http/auth.js';
import { parse, parseId } from '../http/parse.js';
import { broadcastToProject } from '../realtime.js';
import { ensureTaskAccess, getProjectRole } from '../services/access.js';

const commentSelection = {
  id: comments.id,
  taskId: comments.taskId,
  userId: comments.userId,
  userName: users.name,
  body: comments.body,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
};

async function assertCanModify(
  commentUserId: number | null,
  taskId: number,
  user: AuthUser,
): Promise<void> {
  if (commentUserId === user.id) return;
  const { task } = await ensureTaskAccess(taskId, user, 'member');
  const role = await getProjectRole(task.projectId, user);
  if (role !== 'admin' && role !== 'planner') {
    throw forbidden('Nur der Autor oder ein Planer kann diesen Kommentar ändern');
  }
}

export function commentRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/tasks/:id/comments', async (req, res) => {
    const id = parseId(req.params.id);
    await ensureTaskAccess(id, req.user!);

    const rows = await db
      .select(commentSelection)
      .from(comments)
      .leftJoin(users, eq(users.id, comments.userId))
      .where(eq(comments.taskId, id))
      .orderBy(asc(comments.createdAt));

    res.json({ items: rows });
  });

  router.post('/tasks/:id/comments', async (req, res) => {
    const id = parseId(req.params.id);
    const { task } = await ensureTaskAccess(id, req.user!, 'member');
    const input = parse(commentCreateSchema, req.body);

    const [created] = await db
      .insert(comments)
      .values({ taskId: id, userId: req.user!.id, body: input.body })
      .$returningId();

    broadcastToProject(task.projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: id,
      projectId: task.projectId,
      action: 'comment-created',
    });

    const [row] = await db
      .select(commentSelection)
      .from(comments)
      .leftJoin(users, eq(users.id, comments.userId))
      .where(eq(comments.id, created!.id))
      .limit(1);
    res.status(201).json({ comment: row });
  });

  router.patch('/comments/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    if (!existing) throw notFound('Kommentar nicht gefunden');
    await assertCanModify(existing.userId, existing.taskId, req.user!);
    const input = parse(commentCreateSchema, req.body);

    await db.update(comments).set({ body: input.body }).where(eq(comments.id, id));

    const [row] = await db
      .select(commentSelection)
      .from(comments)
      .leftJoin(users, eq(users.id, comments.userId))
      .where(eq(comments.id, id))
      .limit(1);
    res.json({ comment: row });
  });

  router.delete('/comments/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    if (!existing) throw notFound('Kommentar nicht gefunden');
    await assertCanModify(existing.userId, existing.taskId, req.user!);
    await db.delete(comments).where(eq(comments.id, id));
    res.status(204).end();
  });

  return router;
}
