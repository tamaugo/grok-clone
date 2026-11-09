import type { MiddlewareHandler } from 'hono';
import { db, now } from '../db.js';
import type { User } from '../types.js';

/**
 * Single-user install: there is no sign-in. Access control is the network
 * (the server listens on localhost and is reachable only through Tailscale).
 */
export const LOCAL_USER: User = { id: 'usr_local', email: 'local@grokbot', name: process.env.GROKBOT_USER_NAME ?? 'You', avatarUrl: null };

export type AuthVars = { Variables: { user: User } };

/** Create the local user on first start. Returns true if it was just created. */
export function ensureLocalUser(): boolean {
  if (db.prepare('SELECT 1 FROM users WHERE id=?').get(LOCAL_USER.id)) return false;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(LOCAL_USER.id, LOCAL_USER.email, LOCAL_USER.name, now());
  return true;
}

export const requireUser: MiddlewareHandler<AuthVars> = async (c, next) => {
  c.set('user', LOCAL_USER);
  await next();
};
