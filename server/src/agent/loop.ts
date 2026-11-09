import { db, now } from '../db.js';
import { env } from '../env.js';
import { appendRow, emitBot, getBotRow, getRow, setLive, updateRow } from '../store.js';
import type { MessageBody, ToolCallBody } from '../types.js';
import { systemPrompt } from './prompt.js';
import { runClaude } from './claude.js';
import { openTurn } from './mcp.js';
import { activityFor, MCP_PREFIX, type ToolCtx } from './tools.js';

export type Trigger =
  | { type: 'user'; text: string }
  | { type: 'routine'; routineId: string; name: string; prompt: string }
  | { type: 'bot'; fromBotId: string; fromName: string; text: string; depth: number }
  | { type: 'system'; text: string };

// ---------- per-bot serial queue ----------

const queues = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();

export function enqueue(botId: string, trigger: Trigger) {
  const prev = queues.get(botId) ?? Promise.resolve();
  const next = prev.then(() => runTurn(botId, trigger)).catch((e) => console.error('[agent] turn failed', botId, e));
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
}

export function interrupt(botId: string) {
  aborts.get(botId)?.abort();
}

export const isBotBusy = (botId: string) => queues.has(botId);

function enqueueBotMessage(fromBotId: string, toBotId: string, text: string, depth: number) {
  const from = getBotRow(fromBotId);
  appendRow(toBotId, 'message', { type: 'message', role: 'user', text, from: { kind: 'bot', id: fromBotId, name: from.name } });
  enqueue(toBotId, { type: 'bot', fromBotId, fromName: from.name, text, depth });
}

function triggerText(t: Trigger): string {
  switch (t.type) {
    case 'user': return t.text;
    case 'routine': return `[Routine "${t.name}" is running now. Do this:]\n${t.prompt}`;
    case 'bot': return `[Message from ${t.fromName}, another Bot on the team. Reply to them with send_to_bot if they asked you something.]\n${t.text}`;
    case 'system': return `[System notice] ${t.text}`;
  }
}

// ---------- the turn ----------

async function runTurn(botId: string, trigger: Trigger) {
  const bot = getBotRow(botId);
  if (!bot) return;
  const ctrl = new AbortController();
  aborts.set(botId, ctrl);
  const ctx: ToolCtx = { userId: bot.user_id, botId, enqueueBotMessage, depth: trigger.type === 'bot' ? trigger.depth : 0, turn: { suppressReply: false } };
  const mcp = openTurn(ctx);
  const stream = new TranscriptWriter(botId, ctx);
  setLive(botId, { isRunning: true, activity: { kind: 'thinking', since: now() }, awaiting: null, startedAt: now() });

  try {
    const base = {
      botId,
      prompt: triggerText(trigger),
      systemPrompt: await systemPrompt(bot.user_id, botId),
      effort: bot.effort ?? 'medium',
      mcpUrl: `http://127.0.0.1:${env.port}/mcp`,
      mcpToken: mcp.token,
      signal: ctrl.signal,
      onQueued: (reason: string) => setLive(botId, { isRunning: true, activity: { kind: 'waiting_on_command', detail: reason, since: now() } }),
      onEvent: (ev: any) => stream.handle(ev),
    };
    let res = await runClaude({ ...base, sessionId: bot.claude_session ?? null });
    if (res.resumeFailed) {
      // The saved session is gone (e.g. Claude's history was cleared): start a new one.
      db.prepare('UPDATE bots SET claude_session=NULL WHERE id=?').run(botId);
      res = await runClaude({ ...base, sessionId: null });
    }
    if (res.sessionId) db.prepare('UPDATE bots SET claude_session=? WHERE id=? AND generation=?').run(res.sessionId, botId, bot.generation);
    stream.finish();
    if (res.isError) {
      const limit = /limit|quota|rate/i.test(res.resultText);
      appendRow(botId, 'notice', { type: 'notice', text: limit ? `Claude usage limit hit: ${res.resultText}` : `Claude reported an error: ${res.resultText || 'unknown error'}`, tone: limit ? 'warn' : 'error' });
    }
  } catch (e: any) {
    stream.finish('Stopped');
    const msg = ctrl.signal.aborted ? 'Stopped.' : `Something went wrong: ${e?.message ?? e}`;
    appendRow(botId, 'notice', { type: 'notice', text: msg, tone: ctrl.signal.aborted ? 'info' : 'error' });
    if (!ctrl.signal.aborted) console.error('[agent]', e);
  } finally {
    mcp.close();
    aborts.delete(botId);
    setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null });
    emitBot(botId);
  }
}

// ---------- Claude stream-json events -> transcript rows ----------

class TranscriptWriter {
  private msgSeq: number | null = null;
  private text = '';
  private lastFlush = 0;
  private inText = false;
  /** Message ids whose text arrived as deltas (so the full message isn't posted twice). */
  private streamed = new Set<string>();
  private currentMsgId = '';
  /** tool_use id -> transcript row seq */
  private tools = new Map<string, number>();

  constructor(private botId: string, private ctx: ToolCtx) {}

  handle(ev: any) {
    if (ev.parent_tool_use_id) return; // Claude's own helper agents: keep the transcript to the top level
    switch (ev.type) {
      case 'stream_event': return this.onStream(ev.event);
      case 'assistant': return this.onAssistant(ev.message);
      case 'user': return this.onToolResults(ev.message);
    }
  }

  private onStream(e: any) {
    if (!e) return;
    if (e.type === 'message_start') this.currentMsgId = e.message?.id ?? '';
    else if (e.type === 'content_block_start') {
      if (e.content_block?.type === 'text') { this.inText = true; this.text = ''; this.msgSeq = null; this.streamed.add(this.currentMsgId); }
      else if (e.content_block?.type === 'thinking') setLive(this.botId, { activity: { kind: 'thinking', since: now() } });
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && this.inText) {
      this.text += e.delta.text;
      if (this.msgSeq === null || Date.now() - this.lastFlush > 120) this.flush(true);
    } else if (e.type === 'content_block_stop' && this.inText) {
      this.inText = false;
      this.finalizeText();
    }
  }

  private flush(streaming: boolean) {
    if (this.ctx.turn.suppressReply || !this.text.trim()) return;
    const b: MessageBody = { type: 'message', role: 'assistant', text: this.text, streaming };
    if (this.msgSeq === null) {
      this.msgSeq = appendRow(this.botId, 'message', b).seq;
      setLive(this.botId, { activity: { kind: 'working', since: now() } });
    } else updateRow(this.botId, this.msgSeq, b);
    this.lastFlush = Date.now();
  }

  private finalizeText() {
    this.flush(false);
    if (this.msgSeq !== null) db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(this.botId);
    this.msgSeq = null;
    this.text = '';
  }

  private onAssistant(message: any) {
    for (const block of message?.content ?? []) {
      if (block.type === 'text' && !this.streamed.has(message.id) && block.text?.trim()) {
        this.text = block.text;
        this.msgSeq = null;
        this.finalizeText();
      } else if (block.type === 'tool_use' && !this.tools.has(block.id)) {
        const name = String(block.name).startsWith(MCP_PREFIX) ? String(block.name).slice(MCP_PREFIX.length) : String(block.name);
        const act = activityFor(name);
        const row = appendRow(this.botId, 'tool-call', { type: 'tool-call', callId: block.id, name, label: act.label, status: 'running', args: block.input } satisfies ToolCallBody);
        this.tools.set(block.id, row.seq);
        const detail = name === 'send_to_bot' ? String(block.input?.bot_name ?? '') : undefined;
        setLive(this.botId, { activity: { kind: name === 'send_to_bot' ? 'messaging_named' : act.kind, detail, since: now() } });
      }
    }
  }

  private onToolResults(message: any) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const seq = this.tools.get(block.tool_use_id);
      if (seq === undefined) continue;
      const row = getRow(this.botId, seq);
      if (!row || row.body.type !== 'tool-call') continue;
      const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c: any) => c?.text ?? '').join(' ');
      updateRow(this.botId, seq, { ...row.body, status: block.is_error ? 'error' : 'done', summary: block.is_error ? text.slice(0, 200) : undefined });
      this.tools.delete(block.tool_use_id);
      setLive(this.botId, { activity: { kind: 'thinking', since: now() } });
    }
  }

  /** Close any streaming text and mark unfinished tool calls. */
  finish(reason?: string) {
    if (this.inText) { this.inText = false; this.finalizeText(); }
    for (const seq of this.tools.values()) {
      const row = getRow(this.botId, seq);
      if (row?.body.type === 'tool-call') updateRow(this.botId, seq, { ...row.body, status: 'error', summary: reason ?? 'Did not finish' });
    }
    this.tools.clear();
  }
}
