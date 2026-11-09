import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { db, now } from './db.js';

/**
 * Connected apps. Instead of Composio, each app is an MCP server you add once
 * (a remote URL with an optional token, or a local command). Every Bot gets them
 * as extra tools; anything that changes data asks for approval first (agent/approvals.ts).
 */

/** Claude Code names app tools mcp__app_<slug>__<tool>. */
export const APP_PREFIX = 'app_';

export interface App {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  transport: 'http' | 'sse' | 'stdio';
  url: string | null;
  command: string | null;
  args: string[];
  /** Header and env names only; values are secrets and never leave the server. */
  headerNames: string[];
  envNames: string[];
  createdAt: number;
}

export interface AppInput {
  name: string;
  description?: string;
  logo?: string;
  transport?: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

const toApp = (r: any): App => ({
  slug: r.slug, name: r.name, description: r.description, logo: r.logo ?? null, transport: r.transport,
  url: r.url ?? null, command: r.command ?? null, args: JSON.parse(r.args),
  headerNames: Object.keys(JSON.parse(r.headers)), envNames: Object.keys(JSON.parse(r.env)), createdAt: r.created_at,
});

export const listApps = () => (db.prepare('SELECT * FROM apps ORDER BY created_at').all() as any[]).map(toApp);
export const appBySlug = (slug: string) => {
  const r = db.prepare('SELECT * FROM apps WHERE slug=?').get(slug);
  return r ? toApp(r) : null;
};

export const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';

function clean(p: AppInput): AppInput | string {
  const name = String(p.name ?? '').trim();
  if (!name) return 'Give the app a name';
  const transport = p.transport === 'stdio' || p.transport === 'sse' ? p.transport : 'http';
  if (transport !== 'stdio' && !/^https?:\/\//i.test(String(p.url ?? ''))) return 'Enter the MCP server URL (https://…)';
  if (transport === 'stdio' && !String(p.command ?? '').trim()) return 'Enter the command that starts the MCP server';
  const strMap = (m: unknown) => Object.fromEntries(Object.entries((m ?? {}) as Record<string, unknown>).filter(([k, v]) => k.trim() && typeof v === 'string').map(([k, v]) => [k.trim(), v as string]));
  return {
    name: name.slice(0, 60), description: String(p.description ?? '').slice(0, 300), logo: p.logo ? String(p.logo) : undefined, transport,
    url: transport === 'stdio' ? undefined : String(p.url).trim(), command: transport === 'stdio' ? String(p.command).trim() : undefined,
    args: Array.isArray(p.args) ? p.args.map(String) : [], headers: strMap(p.headers), env: strMap(p.env),
  };
}

export function addApp(input: AppInput): App | string {
  const p = clean(input);
  if (typeof p === 'string') return p;
  let slug = slugify(p.name);
  for (let i = 2; db.prepare('SELECT 1 FROM apps WHERE slug=?').get(slug); i++) slug = `${slugify(p.name)}-${i}`;
  db.prepare('INSERT INTO apps(slug,name,description,logo,transport,url,command,args,env,headers,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(slug, p.name, p.description ?? '', p.logo ?? null, p.transport, p.url ?? null, p.command ?? null, JSON.stringify(p.args), JSON.stringify(p.env), JSON.stringify(p.headers), now());
  return appBySlug(slug)!;
}

export function removeApp(slug: string) {
  db.prepare('DELETE FROM apps WHERE slug=?').run(slug);
  db.prepare('DELETE FROM policies WHERE tool LIKE ?').run(`${slug}:%`);
}

/** MCP server entries for every connected app, keyed as Claude Code will name them. */
export function appMcpServers(): Record<string, object> {
  const out: Record<string, object> = {};
  for (const r of db.prepare('SELECT * FROM apps').all() as any[]) {
    const key = `${APP_PREFIX}${r.slug}`;
    if (r.transport === 'stdio') out[key] = { type: 'stdio', command: r.command, args: JSON.parse(r.args), env: JSON.parse(r.env) };
    else out[key] = { type: r.transport, url: r.url, headers: JSON.parse(r.headers) };
  }
  return out;
}

// ---------- connection test: initialize + tools/list ----------

export interface AppTest { ok: boolean; tools: { name: string; description?: string }[]; error?: string }

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grokbot', version: '1.0.0' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

/** Read a JSON-RPC result from a JSON or SSE response body. */
async function rpcResult(res: Response, id: number): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? ' (needs a token, or uses a sign-in this setup can’t do)' : ''}: ${text.slice(0, 200)}`);
  const msgs = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(text)].flat();
  const m = msgs.find((x: any) => x?.id === id);
  if (!m) throw new Error('No reply from the server');
  if (m.error) throw new Error(m.error.message ?? 'Server error');
  return m.result;
}

async function testHttp(r: any): Promise<AppTest> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...JSON.parse(r.headers) };
  const signal = AbortSignal.timeout(15_000);
  const init = await fetch(r.url, { method: 'POST', headers, body: JSON.stringify(INIT), signal });
  const session = init.headers.get('mcp-session-id');
  const initResult = await rpcResult(init, 1);
  if (session) headers['Mcp-Session-Id'] = session;
  headers['MCP-Protocol-Version'] = initResult?.protocolVersion ?? '2025-06-18';
  await fetch(r.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal }).catch(() => {});
  const list = await rpcResult(await fetch(r.url, { method: 'POST', headers, body: JSON.stringify(LIST), signal }), 2);
  return { ok: true, tools: (list?.tools ?? []).map((t: any) => ({ name: t.name, description: t.description })) };
}

function testStdio(r: any): Promise<AppTest> {
  return new Promise((resolve) => {
    const child = spawn(r.command, JSON.parse(r.args), { env: { ...process.env, ...JSON.parse(r.env) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const done = (t: AppTest) => { clearTimeout(timer); child.kill('SIGTERM'); resolve(t); };
    const timer = setTimeout(() => done({ ok: false, tools: [], error: `No reply within 30s. ${stderr.slice(-200)}` }), 30_000);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (e) => done({ ok: false, tools: [], error: e.message }));
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.id === 1) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child.stdin.write(JSON.stringify(LIST) + '\n');
      } else if (m.id === 2) {
        done(m.error ? { ok: false, tools: [], error: m.error.message } : { ok: true, tools: (m.result?.tools ?? []).map((t: any) => ({ name: t.name, description: t.description })) });
      }
    });
    child.stdin.write(JSON.stringify(INIT) + '\n');
  });
}

export async function testApp(slug: string): Promise<AppTest> {
  const r = db.prepare('SELECT * FROM apps WHERE slug=?').get(slug) as any;
  if (!r) return { ok: false, tools: [], error: 'not found' };
  try {
    return r.transport === 'stdio' ? await testStdio(r) : await testHttp(r);
  } catch (e: any) {
    return { ok: false, tools: [], error: String(e?.message ?? e).slice(0, 300) };
  }
}
