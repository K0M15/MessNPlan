import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { Role } from '@projectplaner/shared';
import { REALTIME_EVENTS } from '@projectplaner/shared';
import { verifyAccessToken } from './auth/tokens.js';
import { allowedOrigins } from './config.js';
import { ACCESS_COOKIE } from './http/auth.js';
import { logger } from './logger.js';
import { ensureProjectAccess } from './services/access.js';
import type { AuthUser } from './http/auth.js';

interface PresenceUser {
  userId: number;
  name: string;
  role: Role;
  selection: { taskId: number | null };
}

const presence = new Map<number, Map<string, PresenceUser>>();

let io: Server | null = null;

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function presenceList(projectId: number): PresenceUser[] {
  return [...(presence.get(projectId)?.values() ?? [])];
}

function emitPresence(projectId: number): void {
  io?.to(`project:${projectId}`).emit(REALTIME_EVENTS.PRESENCE_STATE, presenceList(projectId));
}

function removeFromPresence(socketId: string): void {
  for (const [projectId, users] of presence) {
    if (users.delete(socketId)) {
      if (users.size === 0) presence.delete(projectId);
      emitPresence(projectId);
    }
  }
}

export function initRealtime(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: allowedOrigins, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const token = cookies[ACCESS_COOKIE];
      if (!token) return next(new Error('unauthorized'));
      const payload = await verifyAccessToken(token);
      if (!payload) return next(new Error('unauthorized'));
      socket.data.user = {
        id: Number(payload.sub),
        email: payload.email,
        name: payload.name,
        role: payload.role,
      } satisfies AuthUser;
      return next();
    } catch (err) {
      logger.warn({ err }, 'Socket-Authentifizierung fehlgeschlagen');
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as AuthUser;
    logger.debug({ userId: user.id }, 'Socket verbunden');

    socket.on('project:join', async (projectId: unknown) => {
      const id = Number(projectId);
      if (!Number.isInteger(id) || id <= 0) return;
      try {
        await ensureProjectAccess(id, user, 'viewer');
      } catch {
        socket.emit('error:forbidden', { projectId: id });
        return;
      }
      await socket.join(`project:${id}`);
      const users = presence.get(id) ?? new Map<string, PresenceUser>();
      users.set(socket.id, { userId: user.id, name: user.name, role: user.role, selection: { taskId: null } });
      presence.set(id, users);
      emitPresence(id);
    });

    socket.on('project:leave', async (projectId: unknown) => {
      const id = Number(projectId);
      await socket.leave(`project:${id}`);
      const users = presence.get(id);
      if (users?.delete(socket.id)) {
        if (users.size === 0) presence.delete(id);
        emitPresence(id);
      }
    });

    socket.on('presence:selection', (payload: { projectId?: unknown; taskId?: unknown }) => {
      const projectId = Number(payload?.projectId);
      if (!Number.isInteger(projectId) || projectId <= 0) return;
      const users = presence.get(projectId);
      const entry = users?.get(socket.id);
      if (!entry) return;
      const taskId = payload.taskId === null || payload.taskId === undefined ? null : Number(payload.taskId);
      entry.selection = { taskId: Number.isInteger(taskId) ? taskId : null };
      socket.to(`project:${projectId}`).emit(REALTIME_EVENTS.PRESENCE_SELECTION, {
        userId: user.id,
        selection: entry.selection,
      });
    });

    socket.on('disconnect', () => {
      removeFromPresence(socket.id);
    });
  });

  return io;
}

/** Broadcast an alle Nutzer, die ein Projekt geöffnet haben. */
export function broadcastToProject(projectId: number, event: string, payload: unknown): void {
  io?.to(`project:${projectId}`).emit(event, payload);
}

export async function closeRealtime(): Promise<void> {
  if (!io) return;
  await io.close();
  io = null;
  presence.clear();
}
