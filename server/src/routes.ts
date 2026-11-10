import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { ensureLocalUser, LOCAL_USER, requireUser, type AuthVars } from './lib/auth.js';
import { allLive, appendRow, clearConversation, emitBot, getBot, getBotRow, getRow, listBots, listRoutines, listRows, listTasks, toRoutine, updateRow } from './store.js';
import { enqueue, interrupt } from './agent/loop.js';
import { runRoutine, scheduleRoutine, unscheduleRoutine } from './routines.js';
import { dispatchRoomMessage } from './agent/rooms.js';
import { activeScreens, screenFor, screenOf, screenshot, stopScreen } from './computer.js';
import { env } from './env.js';
import { addApp, appBySlug, listApps, removeApp, testApp, type App } from './apps.js';
import { finishOAuth, startOAuth } from './oauth.js';
import { deletePolicy, expirePending, listPolicies, resolveApproval } from './agent/approvals.js';
import { BOT_EFFORTS, BOT_MODELS, type AvatarColor, type AvatarShape, type BotEffort, type BotModel } from './types.js';
import fs from 'node:fs';
import { bodyLimit } from 'hono/body-limit';
import { findUpload, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, saveUpload, UploadError } from './uploads.js';

export const api = new Hono<AuthVars>();

const SHAPES: AvatarShape[] = ['blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star'];
const COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

function hashPick<T>(id: string, list: T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return list[h % list.length];
}

const isBotModel = (m: unknown): m is BotModel => BOT_MODELS.includes(m as BotModel);
const isBotEffort = (e: unknown): e is BotEffort => BOT_EFFORTS.includes(e as BotEffort);

function createBot(userId: string, b: { name: string; label?: string; description?: string; instructions?: string; avatarShape?: string; avatarColor?: string; mode?: string; model?: string; effort?: string; isPrimary?: boolean }) {
  const id = newId('bot');
  const shape = SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, SHAPES.slice(0, 13));
  const color = COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, COLORS.filter((c) => c !== 'black'));
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,model,effort,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, b.name.trim().slice(0, 60) || 'New Bot', b.label ?? '', b.description ?? '', b.instructions ?? '', shape, color, b.mode === 'teammate' ? 'teammate' : 'personal', isBotModel(b.model) ? b.model : 'default', isBotEffort(b.effort) ? b.effort : 'medium', b.isPrimary ? 1 : 0, now(), now());
  hub.emit(userId, { type: 'roster' });
  return getBot(id)!;
}

/** First start: create the local user and their primary Bot. */
export function setupLocalUser() {
  if (!ensureLocalUser()) return;
  createBot(LOCAL_USER.id, { name: 'Quinn', label: 'Chief of Staff', description: 'Your main point of contact. Checks in proactively and coordinates work with your other Bots.', avatarShape: 'blob', avatarColor: 'black', isPrimary: true });
}

// Single user, no sign-in: the network (Tailscale) is the access control.
api.use('/*', requireUser);

api.get('/auth/me', (c) => c.json({ user: c.get('user'), devLogin: false }));

// ---------- events (SSE) ----------

api.get('/events', (c) => {
  const user = c.get('user');
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => { queue.push(JSON.stringify(ev)); wake?.(); });
    stream.onAbort(() => { unsub(); wake?.(); });
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now() }) });
    while (!stream.aborted) {
      if (!queue.length) {
        await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 20_000))]);
        wake = null;
        if (!queue.length) { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); continue; }
      }
      while (queue.length) await stream.writeSSE({ data: queue.shift()! });
    }
    unsub();
  });
});

// ---------- bots ----------

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

api.get('/bots', (c) => c.json({ bots: listBots(c.get('user').id), live: allLive(c.get('user').id) }));

api.post('/bots', async (c) => {
  const body = await c.req.json();
  return c.json({ bot: createBot(c.get('user').id, body) });
});

api.patch('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await c.req.json();
  const cols: Record<string, string> = { name: 'name', label: 'label', description: 'description', instructions: 'instructions', avatarShape: 'avatar_shape', avatarColor: 'avatar_color', mode: 'mode', effort: 'effort', model: 'model', pinned: 'pinned' };
  if (p.model !== undefined && !isBotModel(p.model)) return c.json({ error: 'Unknown model.' }, 400);
  if (p.effort !== undefined && !isBotEffort(p.effort)) return c.json({ error: 'Unknown thinking level.' }, 400);
  for (const [k, col] of Object.entries(cols)) {
    if (p[k] !== undefined) db.prepare(`UPDATE bots SET ${col}=?, updated_at=? WHERE id=?`).run(typeof p[k] === 'boolean' ? (p[k] ? 1 : 0) : p[k], now(), b.id);
  }
  emitBot(b.id);
  return c.json({ bot: getBot(b.id) });
});

api.delete('/bots/:id', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (b.is_primary) return c.json({ error: 'Make another Bot primary first.' }, 400);
  interrupt(b.id);
  expirePending(b.id);
  for (const sub of db.prepare('SELECT id FROM bots WHERE parent_bot_id=?').all(b.id) as { id: string }[]) {
    interrupt(sub.id);
    expirePending(sub.id);
    void stopScreen(sub.id, 'parent bot deleted');
    db.prepare('DELETE FROM bots WHERE id=?').run(sub.id);
  }
  for (const r of listRoutines(b.id)) unscheduleRoutine(r.id);
  void stopScreen(b.id, 'bot deleted');
  for (const room of db.prepare("SELECT id, members FROM bots WHERE user_id=? AND kind='room'").all(b.user_id) as { id: string; members: string | null }[]) {
    const ids: string[] = room.members ? JSON.parse(room.members) : [];
    if (ids.includes(b.id)) {
      const next = ids.filter((id) => id !== b.id);
      db.prepare('UPDATE bots SET members=?, description=?, updated_at=? WHERE id=?').run(JSON.stringify(next), `Group chat with ${next.length} Bots`, now(), room.id);
    }
  }
  db.prepare('DELETE FROM bots WHERE id=?').run(b.id);
  hub.emit(c.get('user').id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/primary', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET is_primary = (id = ?) WHERE user_id=?').run(b.id, user.id);
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/read', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET unread=0 WHERE id=?').run(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

// ---------- conversation ----------

api.get('/bots/:id/rows', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
  return c.json({ generation: b.generation, rows: listRows(b.id, { beforeSeq, limit: Number(c.req.query('limit') ?? 200) }) });
});

api.post('/bots/:id/messages', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { text: raw, attachments: names } = await c.req.json<{ text?: string; attachments?: string[] }>();
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (names !== undefined && !Array.isArray(names)) return c.json({ error: 'bad attachments' }, 400);
  if ((names?.length ?? 0) > MAX_ATTACHMENTS) return c.json({ error: `At most ${MAX_ATTACHMENTS} images per message.` }, 400);
  const files = [...new Set(names ?? [])].map((n) => findUpload(b.id, n));
  if (files.some((f) => !f)) return c.json({ error: 'An attached image is missing. Remove it and paste it again.' }, 400);
  const images = files as NonNullable<(typeof files)[number]>[];
  if (!text && !images.length) return c.json({ error: 'empty' }, 400);
  // A new message supersedes anything the Bot was waiting on (as in Grok Bot).
  expirePending(b.id);
  const attachments = images.map(({ abs: _abs, ...a }) => a);
  const row = appendRow(b.id, 'message', { type: 'message', role: 'user', text, ...(attachments.length ? { attachments } : {}) });
  const paths = images.map((f) => f.abs);
  // Group chats dispatch to their member Bots instead of running their own loop.
  if (b.kind === 'room') dispatchRoomMessage(b.id, text, enqueue, paths);
  // Any pending question card is answered by a free-text message.
  else enqueue(b.id, { type: 'user', text, images: paths });
  return c.json({ row });
});

/** Raw image body (Content-Type is ignored; the type is sniffed). Returns the attachment to send with a message. */
api.post('/bots/:id/uploads', bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ error: 'Images can be at most 10 MB.' }, 413) }), async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    return c.json({ attachment: saveUpload(b.id, new Uint8Array(await c.req.arrayBuffer())) });
  } catch (e) {
    if (e instanceof UploadError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

api.get('/bots/:id/uploads/:name', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const f = findUpload(b.id, c.req.param('name'));
  if (!f) return c.json({ error: 'not found' }, 404);
  return c.body(new Uint8Array(fs.readFileSync(f.abs)), 200, {
    'Content-Type': f.mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

api.post('/bots/:id/interrupt', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  return c.json({ ok: true });
});

api.post('/bots/:id/fresh', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  expirePending(b.id);
  clearConversation(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

api.post('/approvals/:id', async (c) => {
  const { decision } = await c.req.json<{ decision: 'allow' | 'always' | 'deny' }>();
  try { resolveApproval(c.get('user').id, c.req.param('id'), decision); } catch { return c.json({ error: 'not found' }, 404); }
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/answer', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  const { answer } = await c.req.json<{ answer: string }>();
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return c.json({ error: 'not a question' }, 400);
  updateRow(b.id, row.seq, { ...row.body, status: 'answered', answer });
  appendRow(b.id, 'message', { type: 'message', role: 'user', text: answer });
  enqueue(b.id, { type: 'user', text: `[Answer to "${row.body.question}"] ${answer}` });
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/dismiss', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card') return c.json({ error: 'not a card' }, 400);
  updateRow(b.id, row.seq, { ...row.body, status: row.body.card === 'connect' ? 'skipped' : 'dismissed' } as any);
  if (row.body.card === 'connect') enqueue(b.id, { type: 'system', text: `The user skipped connecting ${row.body.toolkitName}. Continue without it.` });
  return c.json({ ok: true });
});

// ---------- routines / tasks / memories ----------

api.get('/bots/:id/routines', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ routines: listRoutines(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.patch('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(enabled ? 1 : 0, r.id);
  const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(r.id));
  enabled ? scheduleRoutine(next) : unscheduleRoutine(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ routine: next });
});

api.post('/routines/:id/run', (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  runRoutine(r.id);
  return c.json({ ok: true });
});

api.delete('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  unscheduleRoutine(r.id);
  db.prepare('DELETE FROM routines WHERE id=?').run(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ ok: true });
});

api.get('/bots/:id/tasks', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ tasks: listTasks(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.get('/tasks', (c) => {
  const rows = db.prepare('SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? ORDER BY t.updated_at DESC LIMIT 200').all(c.get('user').id) as any[];
  return c.json({ tasks: rows.map((r) => ({ id: r.id, botId: r.bot_id, title: r.title, state: r.state, note: r.note, updatedAt: r.updated_at })) });
});

api.get('/bots/:id/memories', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rows = db.prepare('SELECT * FROM memories WHERE bot_id=? ORDER BY created_at DESC').all(b.id) as any[];
  return c.json({ memories: rows.map((m) => ({ id: m.id, botId: m.bot_id, text: m.text, createdAt: m.created_at })) });
});

api.delete('/memories/:id', (c) => {
  db.prepare('DELETE FROM memories WHERE id=? AND bot_id IN (SELECT id FROM bots WHERE user_id=?)').run(c.req.param('id'), c.get('user').id);
  return c.json({ ok: true });
});

// ---------- computer (each Bot's headless browser on this VM) ----------

// Replies first, then exits non-zero so the supervisor (systemd, tsx watch) starts a fresh process on the newest code.
api.post('/restart', (c) => {
  setTimeout(() => process.exit(1), 300);
  return c.json({ ok: true });
});

api.get('/computer', (c) => c.json({ screens: activeScreens(), maxScreens: env.maxScreens, idleMinutes: env.screenIdleMin }));

api.post('/bots/:id/computer/start', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try { await screenFor(b.id); } catch (e: any) { return c.json({ error: e?.message ?? String(e) }, 409); }
  return c.json({ ok: true });
});

api.post('/bots/:id/computer/stop', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: await stopScreen(b.id) });
});

/** Current frame of the Bot's screen; 204 while it's asleep (never wakes it). */
api.get('/bots/:id/screenshot', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!screenOf(b.id)) return c.body(null, 204);
  try {
    const img = await screenshot(b.id);
    return c.body(new Uint8Array(img), 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
  } catch {
    return c.body(null, 204);
  }
});

// ---------- connected apps (MCP servers) and permissions ----------

api.get('/apps', (c) => c.json({ apps: listApps() }));

/** A Bot that asked for this app (through a connect card) gets told it's ready. */
function tellBotAppConnected(userId: string, app: App, botId?: string, seq?: number) {
  if (!botId || !seq || !ownBot(userId, botId)) return;
  const row = getRow(botId, Number(seq));
  if (row?.body.type === 'card' && row.body.card === 'connect') updateRow(botId, row.seq, { ...row.body, status: 'connected' });
  enqueue(botId, { type: 'system', text: `The user connected ${app.name}. Its tools are named mcp__app_${app.slug}__<tool>. Continue with what you were doing.` });
}

api.post('/apps', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const app = addApp(body);
  if (typeof app === 'string') return c.json({ error: app }, 400);
  const test = await testApp(app.slug);
  hub.emit(c.get('user').id, { type: 'connections' });
  const { botId, seq } = body as { botId?: string; seq?: number };
  if (test.ok) tellBotAppConnected(c.get('user').id, app, botId, seq);
  return c.json({ app, test });
});

/** Start a sign-in for an app that uses OAuth. The browser then opens `authUrl`. */
api.post('/apps/oauth/start', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await startOAuth(body, String(body.origin ?? ''), { botId: body.botId, seq: body.seq }));
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 400);
  }
});

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const oauthPage = (title: string, text: string, close: boolean) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title>` +
  `<body style="font-family:-apple-system,system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;margin:0;text-align:center;padding:24px">` +
  `<h1 style="font-size:17px;margin:0 0 6px">${escapeHtml(title)}</h1><p style="font-size:14px;opacity:.7;margin:0;max-width:420px">${escapeHtml(text)}</p><p style="font-size:14px;margin:16px 0 0"><a href="/" style="color:inherit">Back to your Bots</a></p>${close ? '<script>setTimeout(() => window.close(), 1200)</script>' : ''}`;

/** The app sends the browser here after the sign-in. */
api.get('/apps/oauth/callback', async (c) => {
  const { code, state, error, error_description: detail } = c.req.query();
  if (error || !code || !state) return c.html(oauthPage('Sign-in cancelled', detail || error || 'The app did not finish the sign-in. You can close this tab and try again.', false), 400);
  try {
    const { app, botId, seq } = await finishOAuth(state, code);
    const test = await testApp(app.slug);
    if (!test.ok) {
      removeApp(app.slug);
      return c.html(oauthPage(`Couldn’t connect ${app.name}`, test.error || 'The app did not answer after the sign-in.', false), 502);
    }
    hub.emit(c.get('user').id, { type: 'connections' });
    tellBotAppConnected(c.get('user').id, app, botId, seq);
    return c.html(oauthPage(`${app.name} is connected`, 'You can close this tab and go back to your Bots.', true));
  } catch (e: any) {
    return c.html(oauthPage('Sign-in failed', String(e?.message ?? e).slice(0, 300), false), 400);
  }
});

api.post('/apps/:slug/test', async (c) => {
  if (!appBySlug(c.req.param('slug'))) return c.json({ error: 'not found' }, 404);
  return c.json(await testApp(c.req.param('slug')));
});

api.delete('/apps/:slug', (c) => {
  removeApp(c.req.param('slug'));
  hub.emit(c.get('user').id, { type: 'connections' });
  return c.json({ ok: true });
});

api.get('/policies', (c) => c.json({ policies: listPolicies(c.get('user').id) }));
api.delete('/policies/:tool', (c) => {
  deletePolicy(c.get('user').id, c.req.param('tool'));
  return c.json({ ok: true });
});
