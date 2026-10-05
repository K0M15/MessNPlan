import { Router } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { tagCreateSchema, tagUpdateSchema, taskTagsSchema } from '@projectplaner/shared';
import { db } from '../db/client.js';
import { tags, taskTags } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { requireAuth } from '../http/auth.js';
import { parse, parseId } from '../http/parse.js';
import { ensureProjectAccess, ensureTaskAccess } from '../services/access.js';

export function tagRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/projects/:projectId/tags', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!);

    const tagRows = await db
      .select()
      .from(tags)
      .where(eq(tags.projectId, projectId))
      .orderBy(tags.name);

    const ids = tagRows.map((t) => t.id);
    const counts = new Map<number, number>();
    if (ids.length > 0) {
      const countRows = await db
        .select({ tagId: taskTags.tagId, count: sql<number>`count(*)` })
        .from(taskTags)
        .where(inArray(taskTags.tagId, ids))
        .groupBy(taskTags.tagId);
      for (const row of countRows) counts.set(row.tagId, Number(row.count));
    }

    res.json({
      items: tagRows.map((tag) => ({ ...tag, usageCount: counts.get(tag.id) ?? 0 })),
    });
  });

  router.post('/projects/:projectId/tags', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!, 'planner');
    const input = parse(tagCreateSchema, req.body);

    const [existing] = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.projectId, projectId), eq(tags.name, input.name)))
      .limit(1);
    if (existing) throw conflict('Ein Tag mit diesem Namen existiert bereits');

    const [created] = await db
      .insert(tags)
      .values({
        projectId,
        name: input.name,
        color: input.color ?? '#64748b',
      })
      .$returningId();
    const [tag] = await db.select().from(tags).where(eq(tags.id, created!.id)).limit(1);
    res.status(201).json({ tag: { ...tag!, usageCount: 0 } });
  });

  router.patch('/tags/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
    if (!existing) throw notFound('Tag nicht gefunden');
    await ensureProjectAccess(existing.projectId, req.user!, 'planner');
    const input = parse(tagUpdateSchema, req.body);

    if (input.name && input.name !== existing.name) {
      const [nameTaken] = await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.projectId, existing.projectId), eq(tags.name, input.name)))
        .limit(1);
      if (nameTaken) throw conflict('Ein Tag mit diesem Namen existiert bereits');
    }

    await db
      .update(tags)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
      })
      .where(eq(tags.id, id));

    const [tag] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
    res.json({ tag });
  });

  router.delete('/tags/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
    if (!existing) throw notFound('Tag nicht gefunden');
    await ensureProjectAccess(existing.projectId, req.user!, 'planner');
    await db.delete(tags).where(eq(tags.id, id));
    res.status(204).end();
  });

  router.put('/tasks/:id/tags', async (req, res) => {
    const id = parseId(req.params.id);
    const { task } = await ensureTaskAccess(id, req.user!, 'member');
    const input = parse(taskTagsSchema, req.body);

    if (input.tagIds.length > 0) {
      const rows = await db
        .select({ id: tags.id, projectId: tags.projectId })
        .from(tags)
        .where(inArray(tags.id, input.tagIds));
      if (rows.length !== input.tagIds.length) throw badRequest('Unbekannte Tag-ID');
      if (rows.some((t) => t.projectId !== task.projectId)) {
        throw badRequest('Tags gehören zu einem anderen Projekt');
      }
    }

    await db.transaction(async (tx) => {
      await tx.delete(taskTags).where(eq(taskTags.taskId, id));
      if (input.tagIds.length > 0) {
        await tx.insert(taskTags).values(input.tagIds.map((tagId) => ({ taskId: id, tagId })));
      }
    });

    const rows = await db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(taskTags)
      .innerJoin(tags, eq(tags.id, taskTags.tagId))
      .where(eq(taskTags.taskId, id));
    res.json({ tags: rows });
  });

  return router;
}
