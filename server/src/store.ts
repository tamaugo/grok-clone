import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import type { Bot, LiveState, Row, RowBody, RowKind, Routine, Task } from './types.js';
import { Cron } from 'croner';

// ---------- bots ----------

export function toBot(r: any): Bot {
  const last = db
    .prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind IN ('message','card','event') ORDER BY seq DESC LIMIT 1")
    .get(r.id, r.generation) as any;
  let lastPreview: string | null = null;
  if (last) {
    const b = JSON.parse(last.body) as RowBody;
    lastPreview =
      b.type === 'message' ? b.text : b.type === 'card' ? (b.card === 'approval' ? `Waiting for you: ${b.title}` : b.card === 'question' ? b.question : `Connect ${b.toolkitName}`) : b.type === 'event' ? b.text : null;
  }
  return {
    id: r.id,
    name: r.name,
    label: r.label,
    description: r.description,
    instructions: r.instructions,
    avatarShape: r.avatar_shape,
    avatarColor: r.avatar_color,
    mode: r.mode,
    isPrimary: !!r.is_primary,
    kind: r.kind === 'room' ? 'room' : 'agent',
    pinned: !!r.pinned,
    effort: r.effort,
    generation: r.generation,
    unread: r.unread,
    lastPreview: lastPreview ? lastPreview.slice(0, 140) : null,
    lastActivityAt: last?.created_at ?? r.updated_at,
    createdAt: r.created_at,
  };
}

export const getBotRow = (id: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(id) as any;
export const getBot = (id: string) => {
  const r = getBotRow(id);
  return r ? toBot(r) : null;
};
export const listBots = (userId: string) =>
  (db.prepare('SELECT * FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC').all(userId) as any[]).map(toBot);

export function emitBot(botId: string) {
  const r = getBotRow(botId);
  if (r) hub.emit(r.user_id, { type: 'bot', bot: toBot(r) });
}

// ---------- rows ----------

function toRow(r: any): Row {
  return { botId: r.bot_id, generation: r.generation, seq: r.seq, updatedSeq: r.updated_seq, kind: r.kind, body: JSON.parse(r.body), createdAt: r.created_at };
}

function bumpRev(botId: string): number {
  db.prepare('UPDATE bots SET rev = rev + 1, updated_at=? WHERE id=?').run(now(), botId);
  return (db.prepare('SELECT rev FROM bots WHERE id=?').get(botId) as any).rev;
}

/** Append a new row. Returns its seq. When `generation` is given, drops writes if the conversation was cleared or the Bot was removed. */
export function appendRow(botId: string, kind: RowKind, body: RowBody, generation?: number): Row {
  const tx = db.transaction(() => {
    const b = db.prepare('SELECT user_id, generation, next_seq FROM bots WHERE id=?').get(botId) as any;
    if (!b || (generation !== undefined && b.generation !== generation)) return null;
    const seq = b.next_seq;
    db.prepare('UPDATE bots SET next_seq = next_seq + 1 WHERE id=?').run(botId);
    const rev = bumpRev(botId);
    const t = now();
    db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)').run(botId, b.generation, seq, rev, kind, JSON.stringify(body), t);
    return { userId: b.user_id as string, row: { botId, generation: b.generation, seq, updatedSeq: rev, kind, body, createdAt: t } as Row };
  });
  const res = tx();
  if (!res) return { botId, generation: generation ?? 0, seq: 0, updatedSeq: 0, kind, body, createdAt: now() };
  hub.emit(res.userId, { type: 'rows', botId, generation: res.row.generation, rows: [res.row] });
  return res.row;
}

/** Rewrite an existing row's body (e.g. streaming text, card status). */
export function updateRow(botId: string, seq: number, body: RowBody, generation?: number): Row | null {
  const tx = db.transaction(() => {
    const b = db.prepare('SELECT user_id, generation FROM bots WHERE id=?').get(botId) as any;
    if (!b || (generation !== undefined && b.generation !== generation)) return null;
    const existing = db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(botId, b.generation, seq) as any;
    if (!existing) return null;
    const rev = bumpRev(botId);
    db.prepare('UPDATE rows SET body=?, updated_seq=? WHERE bot_id=? AND generation=? AND seq=?').run(JSON.stringify(body), rev, botId, b.generation, seq);
    return { userId: b.user_id as string, row: { ...toRow(existing), body, updatedSeq: rev } as Row };
  });
  const res = tx();
  if (!res) return null;
  hub.emit(res.userId, { type: 'rows', botId, generation: res.row.generation, rows: [res.row] });
  return res.row;
}

export function getRow(botId: string, seq: number, generation?: number): Row | null {
  const b = getBotRow(botId);
  if (!b || (generation !== undefined && b.generation !== generation)) return null;
  const r = db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(botId, b.generation, seq);
  return r ? toRow(r) : null;
}

export function listRows(botId: string, opts: { beforeSeq?: number; limit?: number; afterRev?: number } = {}): Row[] {
  const b = getBotRow(botId);
  if (!b) return [];
  if (opts.afterRev !== undefined) {
    return (db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND updated_seq>? ORDER BY seq ASC').all(botId, b.generation, opts.afterRev) as any[]).map(toRow);
  }
  const limit = Math.min(opts.limit ?? 200, 500);
  const rows = (opts.beforeSeq
    ? db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq<? ORDER BY seq DESC LIMIT ?').all(botId, b.generation, opts.beforeSeq, limit)
    : db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? ORDER BY seq DESC LIMIT ?').all(botId, b.generation, limit)) as any[];
  return rows.reverse().map(toRow);
}

export function clearConversation(botId: string) {
  const b = getBotRow(botId);
  if (!b) return;
  // A fresh conversation also starts a fresh Claude Code session.
  db.prepare('UPDATE bots SET generation = generation + 1, next_seq = 1, claude_session = NULL WHERE id=?').run(botId);
  hub.emit(b.user_id, { type: 'cleared', botId, generation: b.generation + 1 });
}

// ---------- tool rows ----------

/** Claude tool_use id -> transcript row, so approvals can mark the step they're holding up. */
export const toolRows = new Map<string, { botId: string; seq: number }>();

// ---------- live state ----------

const live = new Map<string, LiveState>();

export function getLive(botId: string): LiveState {
  return live.get(botId) ?? { botId, isRunning: false, activity: null, awaiting: null, startedAt: null };
}

export function setLive(botId: string, patch: Partial<LiveState>) {
  const next = { ...getLive(botId), ...patch, botId };
  live.set(botId, next);
  const b = getBotRow(botId);
  if (b) hub.emit(b.user_id, { type: 'live', state: next });
}

export const allLive = (userId: string) => listBots(userId).map((b) => getLive(b.id));

// ---------- routines / tasks ----------

export function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [m, h, dom, mon, dow] = p;
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? new Date(2000, 0, 1, +h, +m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
  if (time && dom === '*' && mon === '*' && dow === '*') return `Every day at ${time}`;
  if (time && dom === '*' && mon === '*' && dow === '1-5') return `Weekdays at ${time}`;
  if (time && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][+dow]} at ${time}`;
  if (m === '0' && h === '*') return 'Every hour';
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m.slice(2)} minutes`;
  if (m === '0' && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return `Every ${h.slice(2)} hours`;
  return expr;
}

export function toRoutine(r: any): Routine {
  let nextRunAt: number | null = null;
  try {
    nextRunAt = r.enabled ? new Cron(r.schedule, { timezone: r.timezone, paused: true }).nextRun()?.getTime() ?? null : null;
  } catch { /* invalid cron */ }
  return {
    id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone,
    enabled: !!r.enabled, nextRunAt, lastRunAt: r.last_run_at, description: describeCron(r.schedule),
  };
}

export const listRoutines = (botId: string) => (db.prepare('SELECT * FROM routines WHERE bot_id=? ORDER BY created_at').all(botId) as any[]).map(toRoutine);

export const toTask = (r: any): Task => ({ id: r.id, botId: r.bot_id, title: r.title, state: r.state, note: r.note, updatedAt: r.updated_at });
export const listTasks = (botId: string) => (db.prepare('SELECT * FROM tasks WHERE bot_id=? ORDER BY updated_at DESC').all(botId) as any[]).map(toTask);
