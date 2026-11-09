import os from 'node:os';
import path from 'node:path';

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const env = {
  port: num(process.env.PORT, 8787),
  /** Only listen on localhost by default; Tailscale Serve exposes it to the tailnet. */
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: process.env.DB_PATH ?? new URL('../../data/grokbot.db', import.meta.url).pathname,

  /** Claude Code CLI used for every Bot turn (logged in with your subscription). */
  claudeBin: process.env.CLAUDE_BIN ?? path.join(os.homedir(), '.local/bin/claude'),
  /** Optional model alias for every Bot (e.g. "sonnet", "opus"); empty = your account's default. */
  claudeModel: process.env.CLAUDE_MODEL ?? '',
  /** Each Bot works in its own folder under here. */
  botsRoot: process.env.BOTS_ROOT ?? path.join(os.homedir(), 'bots'),

  // RAM safeguards: each running Bot is a Claude Code process (~300-500 MB).
  /** Max Bots working at the same time; the rest wait in line. */
  maxConcurrent: num(process.env.GROKBOT_MAX_CONCURRENT, 2),
  /** Don't start another Bot unless at least this much memory is available. */
  minFreeMb: num(process.env.GROKBOT_MIN_FREE_MB, 600),
  /** Max Bot computers (virtual screens + browser) running at once. */
  maxScreens: num(process.env.GROKBOT_MAX_SCREENS, 2),
  /** Put a Bot's computer to sleep after this many idle minutes with nobody watching. */
  screenIdleMin: num(process.env.GROKBOT_SCREEN_IDLE_MIN, 15),
  /** Kill a single turn that runs longer than this. */
  turnTimeoutMin: num(process.env.GROKBOT_TURN_TIMEOUT_MIN, 45),
};
