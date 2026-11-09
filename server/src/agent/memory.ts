import { db } from '../db.js';
import '../db-config.js';
import { getBotRow } from '../store.js';

/**
 * Long-term memory: facts saved with the remember tool, and a bounded, relevance-ranked
 * memory section for the system prompt. Conversation context and compaction are handled
 * by Claude Code's own session.
 */

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const memoryConfig = {
  /** Character budget for the memory section of the system prompt. */
  promptMemoryChars: num(process.env.GROKBOT_PROMPT_MEMORY_CHARS, 4000),
};

const STOP = new Set('a an the and or but of to in on at for with from by is are was were be been it its this that these those i me my you your user users they them their we our he she his her as about into than then so if not no do does did have has had will would can could should just also very really more most some any all prefers likes wants'.split(' '));

export function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
}

/** Most relevant (keyword overlap with recent user messages) and most recent memories, within a character budget. */
export function memoriesForPrompt(botId: string, budget = memoryConfig.promptMemoryChars): { lines: string[]; omitted: number } {
  const all = db.prepare('SELECT text, created_at FROM memories WHERE bot_id=? ORDER BY created_at DESC LIMIT 500').all(botId) as any[];
  if (!all.length) return { lines: [], omitted: 0 };
  const bot = getBotRow(botId);
  const recent = (db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT 12").all(botId, bot.generation) as any[])
    .map((r) => JSON.parse(r.body))
    .filter((b) => b.role === 'user')
    .slice(0, 3)
    .map((b) => String(b.text ?? ''))
    .join(' ');
  const ctx = words(recent);
  const scored = all.map((m, i) => {
    let overlap = 0;
    for (const w of words(m.text)) if (ctx.has(w)) overlap++;
    return { m, score: overlap * 2 + (1 - i / all.length) };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked: typeof all = [];
  let used = 0;
  for (const { m } of scored) {
    const len = m.text.length + 3;
    if (used + len > budget) continue;
    picked.push(m);
    used += len;
  }
  picked.sort((a, b) => a.created_at - b.created_at);
  return { lines: picked.map((m) => `- ${m.text}`), omitted: all.length - picked.length };
}
