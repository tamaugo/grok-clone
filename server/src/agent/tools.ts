import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow, getBotRow, listRoutines, toRoutine, describeCron } from '../store.js';
import { scheduleRoutine, unscheduleRoutine } from '../routines.js';
import { setCheckins } from '../proactive.js';
import { appBySlug, listApps, slugify } from '../apps.js';
import type { Page } from 'playwright-core';
import { activateTab, pageFor, screenshot, SCREEN_H, SCREEN_W, toUrl } from '../computer.js';
import { createSubagent, deleteSubagent, listSubagents } from './subagents.js';
import { createRoom, postToRoom } from './rooms.js';
import { BOT_EFFORTS, BOT_MODELS, type ActivityKind } from '../types.js';
import { Cron } from 'croner';

export interface ToolCtx {
  userId: string;
  botId: string;
  enqueueBotMessage: (fromBotId: string, toBotId: string, text: string, depth: number) => void;
  depth: number;
  /** Per-turn state shared with the loop. */
  turn: { suppressReply: boolean; stayedSilent?: boolean };
}

export interface ToolResult {
  output: string;
  /** A screenshot to show the model alongside the text. */
  image?: { data: string; mimeType: string };
  summary?: string;
  /** The Bot should end its turn after this tool; any later reply text is not shown. */
  endTurn?: boolean;
}

type Impl = (args: any, ctx: ToolCtx) => Promise<ToolResult>;

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  impl: Impl;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest page snapshot handed to the model; long pages are cut with a note. */
const SNAPSHOT_CHARS = 24_000;

/** Let a click or key settle: wait briefly for any navigation it started, then for the page to load. */
async function settle(page: Page) {
  await sleep(300);
  await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
}

/** Text snapshot of the active tab: URL, title and the accessibility tree with element refs. */
async function snapshot(ctx: ToolCtx, caption: string): Promise<ToolResult> {
  const page = await pageFor(ctx.botId);
  // Keep a screenshot for the step's thumbnail in the transcript.
  await screenshot(ctx.botId).catch(() => null);
  let tree = await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 }).catch((e) => `(Couldn't read the page: ${e.message}. Take a screenshot instead.)`);
  if (tree.length > SNAPSHOT_CHARS) tree = `${tree.slice(0, SNAPSHOT_CHARS)}\n… (page cut off; use browser_scroll and take another snapshot to see the rest)`;
  const tabs = page.context().pages().length;
  return {
    output: `${caption}\nPage: ${await page.title().catch(() => '')}\nURL: ${page.url()}${tabs > 1 ? `\nTabs open: ${tabs}` : ''}\n\n${tree}`,
    summary: caption,
  };
}

async function shot(ctx: ToolCtx, caption: string): Promise<ToolResult> {
  const img = await screenshot(ctx.botId);
  const page = await pageFor(ctx.botId);
  return {
    output: `${caption} Page: ${page.url()}. The view is ${SCREEN_W}x${SCREEN_H}px; use x/y in that space.`,
    image: { data: img.toString('base64'), mimeType: 'image/jpeg' },
    summary: caption,
  };
}

/** The element a ref points at, from the latest browser_snapshot. */
async function byRef(ctx: ToolCtx, ref: unknown) {
  const r = String(ref ?? '').replace(/^\[?ref=/, '').replace(/\]$/, '').trim();
  if (!r) throw new Error('Give the ref of an element from browser_snapshot, e.g. "e12".');
  const el = (await pageFor(ctx.botId)).getByRef(r);
  if (!(await el.count().catch(() => 0))) throw new Error(`There's no element ${r} on the page now. Take a new browser_snapshot and use a ref from it.`);
  return el;
}

const int = (v: unknown, name: string) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};

const BROWSER = 'browsing_web' as const;

function botByName(userId: string, name: string) {
  return db.prepare('SELECT * FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 AND lower(name)=lower(?)').get(userId, name.trim()) as any;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'browser_open',
    description: 'Open a URL (or search for words) in your browser, a Chromium only you use, with logins that persist between uses. The user can watch it live. Returns a snapshot of the page with element refs.',
    parameters: obj({ url: { type: 'string', description: 'A URL, a domain like "github.com", or words to search for.' }, new_tab: { type: 'boolean' } }, ['url']),
    activity: BROWSER,
    label: 'Browsing a site',
    impl: async (a, ctx) => {
      const url = toUrl(String(a.url ?? ''));
      if (!url) return { output: 'Give a URL or something to search for.' };
      let page = await pageFor(ctx.botId);
      if (a.new_tab) { page = await page.context().newPage(); activateTab(ctx.botId, page); }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {});
      return snapshot(ctx, `Opened ${url}.`);
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Read the page in your browser as an accessibility tree. Each element you can act on has a ref like [ref=e12]; pass it to browser_click, browser_type or browser_select. Take a new snapshot after the page changes, since old refs stop working.',
    parameters: obj({}),
    activity: BROWSER,
    label: 'Reading the page',
    impl: async (_a, ctx) => snapshot(ctx, 'Current page.'),
  },
  {
    name: 'browser_screenshot',
    description: 'See your browser as an image. Use it when the snapshot is not enough: visual layouts, images, canvas, maps or checking how something looks.',
    parameters: obj({}),
    activity: BROWSER,
    label: 'Looking at the page',
    impl: async (_a, ctx) => shot(ctx, 'Current view.'),
  },
  {
    name: 'browser_click',
    description: 'Click an element by its ref from browser_snapshot (preferred), or at x/y pixel coordinates from browser_screenshot. Returns a fresh snapshot.',
    parameters: obj({ ref: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' } }),
    activity: BROWSER,
    label: 'Clicking',
    impl: async (a, ctx) => {
      const opts = { button: (a.button ?? 'left') as 'left' | 'right' | 'middle', clickCount: a.double ? 2 : 1 };
      const page = await pageFor(ctx.botId);
      if (a.ref !== undefined) await (await byRef(ctx, a.ref)).click({ ...opts, timeout: 10_000 });
      else if (a.x !== undefined && a.y !== undefined) await page.mouse.click(int(a.x, 'x'), int(a.y, 'y'), opts);
      else return { output: 'Give a ref from browser_snapshot, or x and y.' };
      await settle(page);
      return snapshot(ctx, a.ref !== undefined ? `Clicked ${a.ref}.` : `Clicked (${a.x}, ${a.y}).`);
    },
  },
  {
    name: 'browser_type',
    description: 'Type into a text field. With a ref, replaces what the field holds; without one, types at the cursor. Set submit to press Enter afterwards. Returns a fresh snapshot.',
    parameters: obj({ ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['text']),
    activity: BROWSER,
    label: 'Typing',
    impl: async (a, ctx) => {
      const text = String(a.text ?? '');
      const page = await pageFor(ctx.botId);
      if (a.ref !== undefined) {
        const el = await byRef(ctx, a.ref);
        await el.fill(text, { timeout: 10_000 });
        if (a.submit) await el.press('Enter');
      } else {
        await page.keyboard.insertText(text);
        if (a.submit) await page.keyboard.press('Enter');
      }
      await settle(page);
      return snapshot(ctx, `Typed ${text.length} characters${a.submit ? ' and pressed Enter' : ''}.`);
    },
  },
  {
    name: 'browser_select',
    description: 'Choose options in a dropdown (<select>) by its ref. Returns a fresh snapshot.',
    parameters: obj({ ref: { type: 'string' }, values: { type: 'array', items: { type: 'string' }, description: 'Option labels or values.' } }, ['ref', 'values']),
    activity: BROWSER,
    label: 'Choosing an option',
    impl: async (a, ctx) => {
      const values: string[] = (Array.isArray(a.values) ? a.values : [a.values]).map(String);
      await (await byRef(ctx, a.ref)).selectOption(values.map((label) => ({ label })), { timeout: 5_000 })
        .catch(async () => (await byRef(ctx, a.ref)).selectOption(values, { timeout: 5_000 }));
      return snapshot(ctx, `Chose ${values.join(', ')}.`);
    },
  },
  {
    name: 'browser_press',
    description: 'Press a key or shortcut in your browser, e.g. "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "Control+a", "Shift+Tab". Returns a fresh snapshot.',
    parameters: obj({ keys: { type: 'string' } }, ['keys']),
    activity: BROWSER,
    label: 'Pressing keys',
    impl: async (a, ctx) => {
      const page = await pageFor(ctx.botId);
      const keys = String(a.keys).split('+').map((k) => ({ ctrl: 'Control', cmd: 'Meta', alt: 'Alt', shift: 'Shift', return: 'Enter', esc: 'Escape' }[k.toLowerCase()] ?? k)).join('+');
      await page.keyboard.press(keys);
      await settle(page);
      return snapshot(ctx, `Pressed ${keys}.`);
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page, or bring an element (by ref) into view. Returns a fresh snapshot.',
    parameters: obj({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', description: 'Screens to scroll, default 1.' }, ref: { type: 'string' } }),
    activity: BROWSER,
    label: 'Scrolling',
    impl: async (a, ctx) => {
      const page = await pageFor(ctx.botId);
      if (a.ref !== undefined) {
        await (await byRef(ctx, a.ref)).scrollIntoViewIfNeeded({ timeout: 5_000 });
        return snapshot(ctx, `Scrolled to ${a.ref}.`);
      }
      const n = Math.min(Math.max(Number(a.amount ?? 1) || 1, 1), 20);
      const dir = String(a.direction ?? 'down');
      await page.mouse.move(SCREEN_W / 2, SCREEN_H / 2);
      await page.mouse.wheel(dir === 'left' ? -SCREEN_W * 0.8 * n : dir === 'right' ? SCREEN_W * 0.8 * n : 0, dir === 'up' ? -SCREEN_H * 0.8 * n : dir === 'down' ? SCREEN_H * 0.8 * n : 0);
      await sleep(400);
      return snapshot(ctx, `Scrolled ${dir}.`);
    },
  },
  {
    name: 'browser_drag',
    description: 'Drag with the mouse from one point to another (pixel coordinates from browser_screenshot), e.g. for sliders or maps.',
    parameters: obj({ start_x: { type: 'integer' }, start_y: { type: 'integer' }, end_x: { type: 'integer' }, end_y: { type: 'integer' } }, ['start_x', 'start_y', 'end_x', 'end_y']),
    activity: BROWSER,
    label: 'Dragging',
    impl: async (a, ctx) => {
      const page = await pageFor(ctx.botId);
      await page.mouse.move(int(a.start_x, 'start_x'), int(a.start_y, 'start_y'));
      await page.mouse.down();
      await page.mouse.move(int(a.end_x, 'end_x'), int(a.end_y, 'end_y'), { steps: 12 });
      await page.mouse.up();
      return shot(ctx, 'Dragged.');
    },
  },
  {
    name: 'browser_navigate',
    description: 'Go back, go forward or reload the page. Returns a fresh snapshot.',
    parameters: obj({ action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, ['action']),
    activity: BROWSER,
    label: 'Browsing a site',
    impl: async (a, ctx) => {
      const page = await pageFor(ctx.botId);
      const opts = { waitUntil: 'domcontentloaded' as const, timeout: 20_000 };
      if (a.action === 'back') await page.goBack(opts);
      else if (a.action === 'forward') await page.goForward(opts);
      else await page.reload(opts);
      return snapshot(ctx, a.action === 'reload' ? 'Reloaded.' : `Went ${a.action}.`);
    },
  },
  {
    name: 'browser_tabs',
    description: 'List your open tabs, switch to one, or close one. Links that open a new tab switch to it on their own.',
    parameters: obj({ action: { type: 'string', enum: ['list', 'switch', 'close'] }, index: { type: 'integer', description: 'Tab number from the list (starting at 1).' } }, ['action']),
    activity: BROWSER,
    label: 'Switching tabs',
    impl: async (a, ctx) => {
      const current = await pageFor(ctx.botId);
      const pages = current.context().pages();
      const list = async () => (await Promise.all(pages.map(async (p, i) => `${i + 1}. ${p === current ? '(current) ' : ''}${await p.title().catch(() => '')} — ${p.url()}`))).join('\n');
      if (a.action === 'list') return { output: await list(), summary: `${pages.length} tabs` };
      const target = pages[int(a.index, 'index') - 1];
      if (!target) return { output: `There's no tab ${a.index}. Open tabs:\n${await list()}` };
      if (a.action === 'close') {
        await target.close();
        return snapshot(ctx, `Closed tab ${a.index}.`);
      }
      activateTab(ctx.botId, target);
      return snapshot(ctx, `Switched to tab ${a.index}.`);
    },
  },
  {
    name: 'remember',
    description: 'Save a durable memory about the user, their preferences, or your job, so you remember it in future conversations.',
    parameters: obj({ text: { type: 'string' } }, ['text']),
    activity: 'remembering',
    label: 'Saving notes',
    impl: async (a, ctx) => {
      db.prepare('INSERT INTO memories(id,bot_id,text,created_at) VALUES (?,?,?,?)').run(newId('mem'), ctx.botId, String(a.text), now());
      return { output: 'Saved to memory.', summary: 'Saved a memory' };
    },
  },
  {
    name: 'recall',
    description: 'Search your saved memories.',
    parameters: obj({ query: { type: 'string' } }, ['query']),
    activity: 'remembering',
    label: 'Searching memory',
    impl: async (a, ctx) => {
      const words = String(a.query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const all = db.prepare('SELECT text, created_at FROM memories WHERE bot_id=? ORDER BY created_at DESC').all(ctx.botId) as any[];
      const hits = all.filter((m) => !words.length || words.some((w) => m.text.toLowerCase().includes(w))).slice(0, 20);
      return { output: JSON.stringify(hits.map((h) => h.text)) };
    },
  },
  {
    name: 'create_routine',
    description: 'Create a recurring routine you will run on a schedule. `schedule` is a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5" for weekdays at 8:00. `prompt` is the instruction you will follow each time it runs.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string', description: 'IANA timezone, e.g. America/New_York' } }, ['name', 'prompt', 'schedule']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      try { new Cron(a.schedule, { paused: true, timezone: a.timezone || 'UTC' }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      const id = newId('rt');
      db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, ctx.botId, a.name, a.prompt, a.schedule, a.timezone || 'UTC', now());
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(id));
      scheduleRoutine(r);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${a.name} \u00b7 ${describeCron(a.schedule)}`, ref: id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }), summary: `Created routine ${a.name}` };
    },
  },
  {
    name: 'stay_silent',
    description: 'End this turn without sending the user anything. Use during check-ins, routines or bot-to-bot exchanges when there is nothing worth telling the user.',
    parameters: obj({ reason: { type: 'string' } }),
    activity: 'working',
    label: 'Finishing up',
    impl: async () => ({ output: 'OK, staying silent. End your turn now without writing a reply.', endTurn: true, summary: 'Stayed silent' }),
  },
  {
    name: 'set_checkins',
    description: "Turn proactive check-ins on or off and set when they happen (only the primary Bot does check-ins). times are local 24h 'HH:MM' strings; timezone is IANA (e.g. America/Los_Angeles). Ask the user for their timezone if you don't know it.",
    parameters: obj({ enabled: { type: 'boolean' }, times: { type: 'array', items: { type: 'string' } }, timezone: { type: 'string' } }, ['enabled']),
    activity: 'working',
    label: 'Updating check-ins',
    impl: async (a, ctx) => {
      try {
        const r = setCheckins(ctx.userId, { enabled: !!a.enabled, times: a.times, timezone: a.timezone });
        return { output: JSON.stringify({ ok: true, ...r }), summary: r.enabled ? `Check-ins at ${r.times.join(', ')} ${r.timezone}` : 'Check-ins off' };
      } catch (e: any) {
        return { output: `Could not update check-ins: ${e?.message ?? e}` };
      }
    },
  },
  {
    name: 'list_routines',
    description: 'List your routines.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking routines',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listRoutines(ctx.botId)) }),
  },
  {
    name: 'update_routine',
    description: 'Change or pause one of your routines.',
    parameters: obj({ routine_id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string' }, enabled: { type: 'boolean' } }, ['routine_id']),
    activity: 'working',
    label: 'Updating a routine',
    impl: async (a, ctx) => {
      const cur = db.prepare('SELECT * FROM routines WHERE id=? AND bot_id=?').get(a.routine_id, ctx.botId) as any;
      if (!cur) return { output: 'No such routine.' };
      const next = { ...cur, name: a.name ?? cur.name, prompt: a.prompt ?? cur.prompt, schedule: a.schedule ?? cur.schedule, timezone: a.timezone ?? cur.timezone, enabled: a.enabled === undefined ? cur.enabled : a.enabled ? 1 : 0 };
      try { new Cron(next.schedule, { paused: true, timezone: next.timezone }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      db.prepare('UPDATE routines SET name=?,prompt=?,schedule=?,timezone=?,enabled=? WHERE id=?').run(next.name, next.prompt, next.schedule, next.timezone, next.enabled, cur.id);
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(cur.id));
      r.enabled ? scheduleRoutine(r) : unscheduleRoutine(r.id);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-updated', text: `Routine updated: ${r.name} \u00b7 ${r.enabled ? r.description : 'Paused'}`, ref: r.id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }) };
    },
  },
  {
    name: 'delete_routine',
    description: 'Delete one of your routines.',
    parameters: obj({ routine_id: { type: 'string' } }, ['routine_id']),
    activity: 'working',
    label: 'Removing a routine',
    impl: async (a, ctx) => {
      const res = db.prepare('DELETE FROM routines WHERE id=? AND bot_id=?').run(a.routine_id, ctx.botId);
      if (!res.changes) return { output: 'No such routine.' };
      unscheduleRoutine(a.routine_id);
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: 'Deleted.' };
    },
  },
  {
    name: 'create_task',
    description: 'Track a piece of work the user asked for as a task (use one per request when asked for several things at once).',
    parameters: obj({ title: { type: 'string' } }, ['title']),
    activity: 'working',
    label: 'Making a task',
    impl: async (a, ctx) => {
      const id = newId('task');
      db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES (?,?,?,'working',?,?)").run(id, ctx.botId, a.title, now(), now());
      hub.emit(ctx.userId, { type: 'tasks', botId: ctx.botId });
      return { output: JSON.stringify({ task_id: id }) };
    },
  },
  {
    name: 'update_task',
    description: 'Update a task: state is working, needs_input, or done.',
    parameters: obj({ task_id: { type: 'string' }, state: { type: 'string', enum: ['working', 'needs_input', 'done'] }, note: { type: 'string' } }, ['task_id', 'state']),
    activity: 'working',
    label: 'Updating a task',
    impl: async (a, ctx) => {
      const res = db.prepare('UPDATE tasks SET state=?, note=COALESCE(?, note), updated_at=? WHERE id=? AND bot_id=?').run(a.state, a.note ?? null, now(), a.task_id, ctx.botId);
      if (!res.changes) return { output: 'No such task.' };
      hub.emit(ctx.userId, { type: 'tasks', botId: ctx.botId });
      return { output: 'Updated.' };
    },
  },
  {
    name: 'send_to_bot',
    description: "Send a message to another Bot on the user's team (by name) to delegate work or ask a question. Their reply will arrive later as a new message to you.",
    parameters: obj({ bot_name: { type: 'string' }, message: { type: 'string' } }, ['bot_name', 'message']),
    activity: 'messaging_named',
    label: 'Messaging a Bot',
    impl: async (a, ctx) => {
      const target = botByName(ctx.userId, a.bot_name);
      if (!target) return { output: `No bot named "${a.bot_name}". Team: ${(db.prepare("SELECT name FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 AND COALESCE(kind,'agent')<>'room'").all(ctx.userId) as any[]).map((b) => b.name).join(', ')}` };
      if (target.id === ctx.botId) return { output: 'That is you.' };
      if (target.kind === 'room') return { output: `"${target.name}" is a group chat; use post_to_group instead.` };
      if (ctx.depth >= 3) return { output: 'Too many hops between bots; answer the user directly instead.' };
      ctx.enqueueBotMessage(ctx.botId, target.id, String(a.message), ctx.depth + 1);
      return { output: `Sent to ${target.name}. Their reply will come back to you as a message.`, summary: `Messaged ${target.name}` };
    },
  },
  {
    name: 'spawn_subagent',
    description: 'Start a subagent: a helper copy of you with its own context, working in your folder, to work on one goal in parallel (e.g. research one company each). It reports back to you as a message when done. Max 4 at a time. Optionally pick its model and thinking level (e.g. a cheaper model or lower effort for simple lookups); by default it uses yours.',
    parameters: obj({
      goal: { type: 'string', description: 'Self-contained task with everything the subagent needs to know' },
      label: { type: 'string', description: 'Short name, e.g. "Acme research"' },
      model: { type: 'string', enum: [...BOT_MODELS], description: 'Model for the subagent, e.g. "claude-sonnet-5-5" or "claude-opus-5-5". Omit to use your own model.' },
      effort: { type: 'string', enum: [...BOT_EFFORTS], description: 'Thinking level for the subagent: low, medium, high, xhigh or max. Omit to use your own.' },
    }, ['goal']),
    activity: 'messaging_named',
    label: 'Starting a helper',
    impl: async (a, ctx) => {
      if (ctx.depth >= 2) return { output: 'Subagents cannot start more subagents. Do the work yourself.' };
      try {
        const sub = createSubagent(ctx.botId, String(a.goal), a.label, {
          model: a.model == null ? undefined : String(a.model),
          effort: a.effort == null ? undefined : String(a.effort),
        });
        ctx.enqueueBotMessage(ctx.botId, sub.id, String(a.goal), ctx.depth + 1);
        return { output: JSON.stringify({ ok: true, subagent_id: sub.id, name: sub.name, model: sub.model, effort: sub.effort, note: 'It will report back to you as a message. Continue with other work or end your turn.' }), summary: `Started ${sub.name}` };
      } catch (e: any) {
        return { output: String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'list_subagents',
    description: 'List your subagents with their model, thinking level, status and latest message.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking on helpers',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listSubagents(ctx.botId)) }),
  },
  {
    name: 'message_subagent',
    description: 'Send a follow-up instruction to one of your subagents.',
    parameters: obj({ subagent_id: { type: 'string' }, message: { type: 'string' } }, ['subagent_id', 'message']),
    activity: 'messaging_named',
    label: 'Checking with a helper',
    impl: async (a, ctx) => {
      const sub = db.prepare('SELECT id FROM bots WHERE id=? AND parent_bot_id=?').get(a.subagent_id, ctx.botId) as any;
      if (!sub) return { output: 'No such subagent.' };
      ctx.enqueueBotMessage(ctx.botId, sub.id, String(a.message), ctx.depth + 1);
      return { output: 'Sent.' };
    },
  },
  {
    name: 'stop_subagent',
    description: 'Stop and remove one of your subagents (do this once you have its result).',
    parameters: obj({ subagent_id: { type: 'string' } }, ['subagent_id']),
    activity: 'working',
    label: 'Wrapping up a helper',
    impl: async (a, ctx) => {
      const { interrupt } = await import('./loop.js');
      interrupt(String(a.subagent_id));
      return { output: deleteSubagent(ctx.botId, String(a.subagent_id)) ? 'Stopped and removed.' : 'No such subagent.' };
    },
  },
  {
    name: 'create_group',
    description: "Create a group chat between the user and several Bots on the team (by name). It appears in the user's sidebar; when the user posts there, the relevant Bots answer.",
    parameters: obj({ name: { type: 'string' }, bot_names: { type: 'array', items: { type: 'string' } } }, ['name', 'bot_names']),
    activity: 'working',
    label: 'Setting up a group',
    impl: async (a, ctx) => {
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of (a.bot_names ?? []) as string[]) {
        const b = botByName(ctx.userId, n);
        if (b && b.kind !== 'room') ids.push(b.id); else missing.push(n);
      }
      if (ids.length < 2) return { output: `A group needs at least 2 Bots. Not found: ${missing.join(', ') || 'none'}.` };
      const id = createRoom(ctx.userId, String(a.name), [...new Set(ids)]);
      appendRow(id, 'event', { type: 'event', event: 'bot-message', text: `Group created with ${(a.bot_names as string[]).filter((n) => !missing.includes(n)).join(', ')}` });
      return { output: JSON.stringify({ ok: true, group_id: id, missing }), summary: `Created group ${a.name}` };
    },
  },
  {
    name: 'post_to_group',
    description: 'Post a message into a group chat you are a member of.',
    parameters: obj({ group_name: { type: 'string' }, text: { type: 'string' } }, ['group_name', 'text']),
    activity: 'messaging_named',
    label: 'Posting to the group',
    impl: async (a, ctx) => {
      const out = postToRoom(ctx.botId, String(a.group_name), String(a.text));
      return { output: out, summary: `Posted to ${a.group_name}`, endTurn: out === 'Posted to the group.' };
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a multiple-choice question when you need a decision before continuing. Ends your turn; their answer arrives as their next message.',
    parameters: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question', 'options']),
    activity: 'waiting_for_you',
    label: 'Waiting on you',
    impl: async (a, ctx) => {
      appendRow(ctx.botId, 'card', { type: 'card', card: 'question', question: a.question, options: (a.options ?? []).slice(0, 6), status: 'pending' });
      return { output: 'Question shown to the user. Stop here and wait for their answer.', endTurn: true };
    },
  },
  {
    name: 'request_app_connection',
    description: "Ask the user to connect an app (e.g. GitHub, Notion, Linear, Gmail) so you can use it. Connected apps appear as extra tools named mcp__app_<app>__<tool>. Ends your turn; you'll be told when it's connected.",
    parameters: obj({ app: { type: 'string', description: 'App name, e.g. "GitHub"' }, reason: { type: 'string' } }, ['app', 'reason']),
    activity: 'connecting_service',
    label: 'Using a connected app',
    impl: async (a, ctx) => {
      const slug = slugify(String(a.app));
      const existing = appBySlug(slug) ?? listApps().find((x) => x.name.toLowerCase() === String(a.app).toLowerCase());
      if (existing) return { output: `${existing.name} is already connected. Its tools are named mcp__app_${existing.slug}__<tool>. If you don't see them, they'll be available from your next turn.` };
      appendRow(ctx.botId, 'card', { type: 'card', card: 'connect', toolkit: slug, toolkitName: String(a.app), reason: String(a.reason), status: 'pending' });
      return { output: `Asked the user to connect ${a.app}. Stop here; you'll be told when it's connected.`, endTurn: true };
    },
  },
];

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

/** Prefix Claude Code gives tools from this server's MCP endpoint. */
export const MCP_PREFIX = 'mcp__grokbot__';

/** How Claude Code's built-in tools show up in the transcript. */
const CLAUDE_TOOLS: Record<string, { kind: ActivityKind; label: string }> = {
  Bash: { kind: 'running_commands', label: 'Running commands' },
  BashOutput: { kind: 'waiting_on_command', label: 'Checking a command' },
  Read: { kind: 'working', label: 'Reading files' },
  Glob: { kind: 'working', label: 'Looking through files' },
  Grep: { kind: 'working', label: 'Searching files' },
  Write: { kind: 'drafting_file', label: 'Writing a file' },
  Edit: { kind: 'drafting_file', label: 'Editing a file' },
  MultiEdit: { kind: 'drafting_file', label: 'Editing a file' },
  NotebookEdit: { kind: 'drafting_file', label: 'Editing a notebook' },
  WebSearch: { kind: 'searching_web', label: 'Searching the web' },
  WebFetch: { kind: 'reading_web', label: 'Reading a page' },
  Task: { kind: 'working', label: 'Starting a helper' },
  Agent: { kind: 'working', label: 'Starting a helper' },
  TodoWrite: { kind: 'working', label: 'Planning' },
  ToolSearch: { kind: 'working', label: 'Finding a tool' },
};

export function activityFor(name: string): { kind: ActivityKind; label: string } {
  const t = toolMap.get(name);
  if (t) return { kind: t.activity, label: t.label };
  if (CLAUDE_TOOLS[name]) return CLAUDE_TOOLS[name];
  return name.startsWith('mcp__') ? { kind: 'connecting_service', label: 'Using a connected app' } : { kind: 'working', label: 'Working' };
}

export function getBotName(botId: string) {
  return getBotRow(botId)?.name ?? 'Bot';
}
