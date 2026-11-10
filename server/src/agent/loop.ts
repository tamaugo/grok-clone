import { db, now } from '../db.js';
import { env } from '../env.js';
import { appendRow, emitBot, getBotRow, getRow, setLive, toolRows, updateRow } from '../store.js';
import { lastShotThumbnail } from '../computer.js';
import { noteCheckinOutcome } from '../proactive.js';
import type { MessageBody, ToolCallBody } from '../types.js';
import { systemPrompt } from './prompt.js';
import { runClaude } from './claude.js';
import { openTurn } from './mcp.js';
import { formatClock, isUsageLimit, retryDelayMs } from './limits.js';
import { refreshOAuthTokens } from '../oauth.js';
import { activityFor, MCP_PREFIX, type ToolCtx } from './tools.js';

export type Trigger =
  | { type: 'user'; text: string }
  | { type: 'routine'; routineId: string; name: string; prompt: string }
  | { type: 'bot'; fromBotId: string; fromName: string; text: string; depth: number }
  | { type: 'system'; text: string };

// ---------- per-bot serial queue ----------

const queues = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();
const cancelEpochs = new Map<string, number>();

/** A turn that hit Claude's usage limit and is being tried again. */
interface Retry { tries: number; firstAt: number }

export function enqueue(botId: string, trigger: Trigger, retry?: Retry) {
  // A new message from the user replaces any turn waiting to be retried.
  if (trigger.type === 'user' && !retry) cancelRetries(botId);
  const epoch = cancelEpochs.get(botId) ?? 0;
  const prev = queues.get(botId) ?? Promise.resolve();
  const next = prev
    .then(() => { if ((cancelEpochs.get(botId) ?? 0) === epoch) return runTurn(botId, trigger, retry); })
    .catch((e) => console.error('[agent] turn failed', botId, e));
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
}

export function interrupt(botId: string) {
  cancelRetries(botId);
  cancelEpochs.set(botId, (cancelEpochs.get(botId) ?? 0) + 1);
  aborts.get(botId)?.abort();
}

// ---------- usage limits: wait for the reset, then run the same turn again ----------

const MAX_LIMIT_TRIES = 5;
const MAX_LIMIT_WAIT_MS = 6 * 3600_000;
const retryTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

function cancelRetries(botId: string) {
  for (const t of retryTimers.get(botId) ?? []) clearTimeout(t);
  retryTimers.delete(botId);
}

/** Returns when the turn will run again, or null when it has been retried enough. */
function scheduleRetry(botId: string, generation: number, trigger: Trigger, prev: Retry | undefined, limitText: string): number | null {
  const retry: Retry = { tries: (prev?.tries ?? 0) + 1, firstAt: prev?.firstAt ?? now() };
  const at = now() + retryDelayMs(limitText);
  if (retry.tries > MAX_LIMIT_TRIES || at - retry.firstAt > MAX_LIMIT_WAIT_MS) return null;
  const timers = retryTimers.get(botId) ?? new Set();
  retryTimers.set(botId, timers);
  const t = setTimeout(() => {
    timers.delete(t);
    // Skip if the Bot was removed or its conversation was cleared while waiting.
    if (getBotRow(botId)?.generation === generation) enqueue(botId, trigger, retry);
  }, at - now());
  t.unref();
  timers.add(t);
  return at;
}

export const isBotBusy = (botId: string) => queues.has(botId);

function enqueueBotMessage(fromBotId: string, toBotId: string, text: string, depth: number) {
  const from = getBotRow(fromBotId);
  if (!from) return;
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

async function runTurn(botId: string, trigger: Trigger, retry?: Retry) {
  const bot = getBotRow(botId);
  if (!bot) return;
  const generation = bot.generation as number;
  const ctrl = new AbortController();
  aborts.set(botId, ctrl);
  const ctx: ToolCtx = { userId: bot.user_id, botId, enqueueBotMessage, depth: trigger.type === 'bot' ? trigger.depth : 0, turn: { suppressReply: false, stayedSilent: false } };
  const mcp = openTurn(ctx);
  const stream = new TranscriptWriter(botId, generation, ctx);
  setLive(botId, { isRunning: true, activity: { kind: 'thinking', since: now() }, awaiting: null, startedAt: now() });

  try {
    const base = {
      botId,
      prompt: triggerText(trigger),
      systemPrompt: await systemPrompt(bot.user_id, botId),
      effort: bot.effort ?? 'medium',
      model: bot.model ?? 'default',
      mcpUrl: `http://127.0.0.1:${env.port}/mcp`,
      mcpToken: mcp.token,
      signal: ctrl.signal,
      onQueued: (reason: string) => setLive(botId, { isRunning: true, activity: { kind: 'waiting_on_command', detail: reason, since: now() } }),
      onEvent: (ev: any) => stream.handle(ev),
    };
    await refreshOAuthTokens();
    let res = await runClaude({ ...base, sessionId: bot.claude_session ?? null });
    if (res.resumeFailed) {
      // The saved session is gone (e.g. Claude's history was cleared): start a new one.
      db.prepare('UPDATE bots SET claude_session=NULL WHERE id=? AND generation=?').run(botId, generation);
      res = await runClaude({ ...base, sessionId: null });
    }
    if (res.sessionId) db.prepare('UPDATE bots SET claude_session=? WHERE id=? AND generation=?').run(res.sessionId, botId, generation);
    stream.finish();
    if (res.isError) {
      if (isUsageLimit(res.resultText)) {
        const at = scheduleRetry(botId, generation, trigger, retry, res.resultText);
        const text = at
          ? `Claude’s usage limit was reached. ${bot.name} will try again at ${formatClock(at)}. Send a message or press stop to cancel.`
          : `Claude’s usage limit was reached and ${bot.name} has stopped retrying: ${res.resultText}`;
        appendRow(botId, 'notice', { type: 'notice', text, tone: 'warn' }, generation);
      } else {
        appendRow(botId, 'notice', { type: 'notice', text: `Claude reported an error: ${res.resultText || 'unknown error'}`, tone: 'error' }, generation);
      }
    } else if (trigger.type === 'system' && trigger.text.startsWith('[check-in]')) {
      noteCheckinOutcome(bot.user_id, stream.sentMessage);
    }
  } catch (e: any) {
    stream.finish('Stopped');
    const msg = ctrl.signal.aborted ? 'Stopped.' : `Something went wrong: ${e?.message ?? e}`;
    appendRow(botId, 'notice', { type: 'notice', text: msg, tone: ctrl.signal.aborted ? 'info' : 'error' }, generation);
    if (!ctrl.signal.aborted) console.error('[agent]', e);
  } finally {
    mcp.close();
    aborts.delete(botId);
    setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null });
    emitBot(botId);
  }
}

// ---------- Claude stream-json events -> transcript rows ----------

/** Browser tools whose steps get a screenshot thumbnail. */
const SHOT_TOOLS = new Set(['browser_open', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_scroll', 'browser_drag', 'browser_navigate', 'browser_tabs']);

class TranscriptWriter {
  private msgSeq: number | null = null;
  private msgSeqs: number[] = [];
  private unreadAdded = 0;
  private text = '';
  private lastFlush = 0;
  private inText = false;
  /** Message ids whose text arrived as deltas (so the full message isn't posted twice). */
  private streamed = new Set<string>();
  private currentMsgId = '';
  /** tool_use id -> transcript row seq */
  private tools = new Map<string, number>();

  constructor(private botId: string, private generation: number, private ctx: ToolCtx) {}

  get sentMessage() {
    return this.unreadAdded > 0 && !this.ctx.turn.stayedSilent;
  }

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
      const row = appendRow(this.botId, 'message', b, this.generation);
      if (!row.seq) return;
      this.msgSeq = row.seq;
      this.msgSeqs.push(row.seq);
      setLive(this.botId, { activity: { kind: 'working', since: now() } });
    } else updateRow(this.botId, this.msgSeq, b, this.generation);
    this.lastFlush = Date.now();
  }

  private finalizeText() {
    this.flush(false);
    if (this.msgSeq !== null) {
      const r = db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=? AND generation=?').run(this.botId, this.generation);
      if (r.changes) this.unreadAdded++;
    }
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
        const row = appendRow(this.botId, 'tool-call', { type: 'tool-call', callId: block.id, name, label: act.label, status: 'running', args: block.input } satisfies ToolCallBody, this.generation);
        if (row.seq) {
          this.tools.set(block.id, row.seq);
          toolRows.set(block.id, { botId: this.botId, seq: row.seq });
        }
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
      const row = getRow(this.botId, seq, this.generation);
      if (!row || row.body.type !== 'tool-call') continue;
      const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c: any) => c?.text ?? '').join(' ');
      this.tools.delete(block.tool_use_id);
      toolRows.delete(block.tool_use_id);
      if (row.body.status === 'denied') continue; // the user declined it; keep "Not allowed"
      updateRow(this.botId, seq, { ...row.body, status: block.is_error ? 'error' : 'done', summary: block.is_error ? text.slice(0, 200) : undefined }, this.generation);
      if (!block.is_error && SHOT_TOOLS.has(row.body.name)) {
        const botId = this.botId;
        const gen = this.generation;
        lastShotThumbnail(botId).then((shot) => {
          const cur = shot ? getRow(botId, seq, gen) : null;
          if (shot && cur?.body.type === 'tool-call') updateRow(botId, seq, { ...cur.body, screenshot: shot }, gen);
        }).catch(() => {});
      }
      setLive(this.botId, { activity: { kind: 'thinking', since: now() } });
    }
  }

  /** Close any streaming text and mark unfinished tool calls. */
  finish(reason?: string) {
    if (this.inText) { this.inText = false; this.finalizeText(); }
    if (this.ctx.turn.stayedSilent && this.msgSeqs.length) {
      for (const seq of this.msgSeqs) {
        updateRow(this.botId, seq, { type: 'message', role: 'assistant', text: '', streaming: false }, this.generation);
        db.prepare('DELETE FROM rows WHERE bot_id=? AND generation=? AND seq=?').run(this.botId, this.generation, seq);
      }
      if (this.unreadAdded > 0) {
        db.prepare('UPDATE bots SET unread = MAX(0, unread - ?) WHERE id=? AND generation=?').run(this.unreadAdded, this.botId, this.generation);
        this.unreadAdded = 0;
      }
      this.msgSeqs = [];
    }
    for (const id of this.tools.keys()) toolRows.delete(id);
    for (const seq of this.tools.values()) {
      const row = getRow(this.botId, seq, this.generation);
      if (row?.body.type === 'tool-call') updateRow(this.botId, seq, { ...row.body, status: 'error', summary: reason ?? 'Did not finish' }, this.generation);
    }
    this.tools.clear();
  }
}
