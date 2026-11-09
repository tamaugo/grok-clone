import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { db } from '../db.js';
import { env } from '../env.js';

/**
 * Runs one Bot turn through the Claude Code CLI in headless mode
 * (`claude -p --output-format stream-json`), resuming the Bot's own session.
 */

// ---------- workspaces ----------

/** A Bot's working folder. Subagents share their parent's folder so they can hand files over. */
export function workspaceFor(botId: string): string {
  const b = db.prepare('SELECT id, parent_bot_id FROM bots WHERE id=?').get(botId) as any;
  const owner = b?.parent_bot_id ?? botId;
  const dir = path.join(env.botsRoot, owner);
  fs.mkdirSync(path.join(dir, 'library'), { recursive: true });
  return dir;
}

export const libraryFor = (botId: string) => path.join(workspaceFor(botId), 'library');

// ---------- RAM safeguard: concurrency cap + free-memory gate ----------

let running = 0;
const waiters = new Set<() => void>();

export function memAvailableMb(): number {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+) kB/);
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch { /* not Linux */ }
  return Number.MAX_SAFE_INTEGER;
}

export const runningCount = () => running;

/** Wait for a free slot and enough memory. `onWait` is told why the Bot is queued. */
async function acquire(signal: AbortSignal, onWait: (reason: string) => void) {
  for (;;) {
    if (signal.aborted) throw new Error('interrupted');
    const free = memAvailableMb();
    if (running < env.maxConcurrent && free >= env.minFreeMb) { running++; return; }
    onWait(running >= env.maxConcurrent ? `In line: ${running} Bots already working` : `In line: low memory (${free} MB free)`);
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(t); waiters.delete(done); resolve(); };
      const t = setTimeout(done, 3000);
      waiters.add(done);
    });
  }
}

function release() {
  running = Math.max(0, running - 1);
  for (const w of [...waiters]) w();
}

// ---------- the run ----------

export interface RunOptions {
  botId: string;
  prompt: string;
  systemPrompt: string;
  sessionId: string | null;
  effort: string;
  mcpUrl: string;
  mcpToken: string;
  signal: AbortSignal;
  onQueued: (reason: string) => void;
  onEvent: (ev: any) => void;
}

export interface RunResult { sessionId: string | null; isError: boolean; resultText: string; resumeFailed: boolean }

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export async function runClaude(o: RunOptions): Promise<RunResult> {
  await acquire(o.signal, o.onQueued);
  try {
    return await spawnClaude(o);
  } finally {
    release();
  }
}

function spawnClaude(o: RunOptions): Promise<RunResult> {
  const cwd = workspaceFor(o.botId);
  const metaDir = path.join(cwd, '.grokbot');
  fs.mkdirSync(metaDir, { recursive: true });
  const sysFile = path.join(metaDir, `system-${o.botId}.md`);
  fs.writeFileSync(sysFile, o.systemPrompt);
  const mcpFile = path.join(metaDir, `mcp-${o.botId}.json`);
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { grokbot: { type: 'http', url: o.mcpUrl, headers: { Authorization: `Bearer ${o.mcpToken}` } } } }), { mode: 0o600 });

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    '--append-system-prompt-file', sysFile,
    '--mcp-config', mcpFile,
  ];
  if (EFFORTS.has(o.effort)) args.push('--effort', o.effort);
  if (env.claudeModel) args.push('--model', env.claudeModel);
  if (o.sessionId) args.push('--resume', o.sessionId);

  return new Promise((resolve, reject) => {
    const child = spawn(env.claudeBin, args, {
      cwd,
      env: { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(o.prompt);

    let sessionId: string | null = null;
    let result: any = null;
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });

    const kill = () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
    };
    o.signal.addEventListener('abort', kill, { once: true });
    const timeout = setTimeout(() => { stderr += `\nTurn took longer than ${env.turnTimeoutMin} min and was stopped.`; kill(); }, env.turnTimeoutMin * 60_000);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id && !sessionId) sessionId = ev.session_id;
      if (ev.type === 'result') result = ev;
      try { o.onEvent(ev); } catch (e) { console.error('[claude] event handler', e); }
    });

    child.on('error', (e) => { clearTimeout(timeout); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      o.signal.removeEventListener('abort', kill);
      if (o.signal.aborted) return reject(new Error('interrupted'));
      const resumeFailed = !!o.sessionId && !result && /no conversation found|session/i.test(stderr);
      if (!result) {
        if (resumeFailed) return resolve({ sessionId: null, isError: true, resultText: '', resumeFailed: true });
        return reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${code}`));
      }
      resolve({ sessionId: result.session_id ?? sessionId, isError: !!result.is_error, resultText: String(result.result ?? ''), resumeFailed: false });
    });
  });
}
