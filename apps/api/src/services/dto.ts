import type { users } from '../db/schema.js';

export type UserRow = typeof users.$inferSelect;

export function toUserDto(user: UserRow): Omit<UserRow, 'passwordHash'> {
  const { passwordHash: _ignored, ...rest } = user;
  return rest;
}
