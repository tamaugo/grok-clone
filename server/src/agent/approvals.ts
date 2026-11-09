import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow, getBotRow, getRow, setLive, toolRows, updateRow } from '../store.js';
import { appBySlug, APP_PREFIX } from '../apps.js';

/**
 * Approvals (Grok Bot: "Bots ask before doing anything that changes data in an app").
 * Claude Code calls our permission_prompt MCP tool before any tool that isn't pre-allowed.
 * A Bot's own computer, shell and files always run; tools from connected apps run freely
 * when they read data, and otherwise post an approval card and wait for the user.
 */

export type ApprovalDecision = 'allow' | 'always' | 'deny';

const waiting = new Map<string, (status: 'allowed' | 'always' | 'denied' | 'expired') => void>();
const APPROVAL_TIMEOUT_MS = 30 * 60_000;

const READ_WORDS = new Set('get list search read fetch find query retrieve view describe count lookup check show download export status info resolve ask'.split(' '));

/** "API-post-search", "list_issues", "getUser" -> words, to tell reading tools from ones that change data. */
const toolWords = (tool: string) => tool.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const isReadOnly = (tool: string) => toolWords(tool).some((w) => READ_WORDS.has(w)) && !toolWords(tool).some((w) => WRITE_WORDS.has(w));
// HTTP verbs (post, put, patch) are left out: "API-post-search" reads, "API-post-page" asks because nothing in it reads.
const WRITE_WORDS = new Set('create update delete remove send write add set move archive merge publish invite cancel refund pay'.split(' '));

/** "mcp__app_github__create_issue" -> { slug: 'github', tool: 'create_issue' } */
export function parseAppTool(name: string): { slug: string; tool: string } | null {
  const m = name.match(new RegExp(`^mcp__${APP_PREFIX}([a-z0-9-]+)__(.+)$`));
  return m ? { slug: m[1], tool: m[2] } : null;
}

export const policyKey = (slug: string, tool: string) => `${slug}:${tool}`;

export function policyFor(userId: string, slug: string, tool: string): 'always_allow' | 'needs_approval' | 'blocked' {
  const p = db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, policyKey(slug, tool)) as any;
  if (p?.mode) return p.mode;
  return isReadOnly(tool) ? 'always_allow' : 'needs_approval';
}

export const humanizeTool = (tool: string) => tool.replace(/[_-]+/g, ' ').trim().toLowerCase();

function describeArgs(args: any): string {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args)
    .filter(([, v]) => typeof v !== 'object' || v === null)
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 160)}`)
    .join('\n')
    .slice(0, 1200);
}

/** Decide whether a tool call may run. Resolves when the user answers (or right away when no approval is needed). */
export async function requestPermission(botId: string, toolName: string, input: any, toolUseId?: string): Promise<{ allow: boolean; expired?: boolean; message?: string }> {
  const app = parseAppTool(toolName);
  if (!app) return { allow: true }; // the Bot's own tools, shell, files and computer
  const bot = getBotRow(botId);
  if (!bot) return { allow: false, expired: true, message: 'This Bot was removed.' };
  const mode = policyFor(bot.user_id, app.slug, app.tool);
  if (mode === 'always_allow') return { allow: true };
  if (mode === 'blocked') return { allow: false, message: 'The user does not allow this action. Do not retry it.' };

  const info = appBySlug(app.slug);
  const id = newId('apr');
  const card = appendRow(botId, 'card', {
    type: 'card', card: 'approval', approvalId: id,
    title: `Allow ${bot.name} to ${humanizeTool(app.tool)}?`,
    detail: describeArgs(input), tool: policyKey(app.slug, app.tool), toolkit: app.slug, toolkitName: info?.name ?? app.slug, logo: info?.logo ?? undefined,
    args: input, status: 'pending',
  });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,tool,status,created_at) VALUES (?,?,?,?,?,?)').run(id, botId, card.seq, policyKey(app.slug, app.tool), 'pending', now());
  const step = toolUseId ? toolRows.get(toolUseId) : undefined;
  const markStep = (status: 'awaiting-approval' | 'running' | 'denied') => {
    const r = step && getRow(step.botId, step.seq);
    if (r?.body.type === 'tool-call') updateRow(step!.botId, step!.seq, { ...r.body, status, summary: status === 'denied' ? 'Not allowed' : r.body.summary });
  };
  markStep('awaiting-approval');
  setLive(botId, { activity: { kind: 'waiting_for_you', since: now() }, awaiting: { reason: `${info?.name ?? app.slug}: ${humanizeTool(app.tool)}`, since: now() } });
  hub.emit(bot.user_id, { type: 'tasks', botId });

  const status = await new Promise<'allowed' | 'always' | 'denied' | 'expired'>((resolve) => {
    const t = setTimeout(() => finish(id, 'expired'), APPROVAL_TIMEOUT_MS);
    waiting.set(id, (s) => { clearTimeout(t); resolve(s); });
  });
  setLive(botId, { activity: { kind: 'thinking', since: now() }, awaiting: null });
  markStep(status === 'allowed' || status === 'always' ? 'running' : 'denied');
  if (status === 'allowed' || status === 'always') return { allow: true };
  return {
    allow: false,
    expired: status === 'expired',
    message: status === 'expired'
      ? 'The user did not approve this in time (or sent a new message instead). Stop here without writing a reply.'
      : 'The user declined this action. Do not retry it. Find another way, or tell the user what you could not do.',
  };
}

function finish(id: string, status: 'allowed' | 'always' | 'denied' | 'expired') {
  const ap = db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as any;
  if (!ap || ap.status !== 'pending') return;
  db.prepare('UPDATE approvals SET status=?, resolved_at=? WHERE id=?').run(status, now(), id);
  const card = getRow(ap.bot_id, ap.row_seq);
  if (card?.body.type === 'card' && card.body.card === 'approval') updateRow(ap.bot_id, ap.row_seq, { ...card.body, status });
  waiting.get(id)?.(status);
  waiting.delete(id);
}

/** The user answered an approval card. */
export function resolveApproval(userId: string, id: string, decision: ApprovalDecision) {
  const ap = db.prepare('SELECT a.*, b.user_id FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=?').get(id) as any;
  if (!ap || ap.user_id !== userId) throw new Error('not found');
  if (decision === 'always') db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run(userId, ap.tool);
  finish(id, decision === 'deny' ? 'denied' : decision === 'always' ? 'always' : 'allowed');
}

/** A new message supersedes anything the Bot was waiting on. */
export function expirePending(botId: string) {
  for (const ap of db.prepare("SELECT id FROM approvals WHERE bot_id=? AND status='pending'").all(botId) as any[]) finish(ap.id, 'expired');
}

/** Approvals left pending by a restart can't be answered any more. */
export function expireStaleApprovals() {
  for (const ap of db.prepare("SELECT id FROM approvals WHERE status='pending'").all() as any[]) {
    if (!waiting.has(ap.id)) finish(ap.id, 'expired');
  }
}

export const listPolicies = (userId: string) => db.prepare('SELECT tool, mode FROM policies WHERE user_id=?').all(userId) as { tool: string; mode: string }[];
export const deletePolicy = (userId: string, tool: string) => db.prepare('DELETE FROM policies WHERE user_id=? AND tool=?').run(userId, tool);
