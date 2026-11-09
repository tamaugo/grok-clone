import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { env } from './env.js';
import { getLive, setLive } from './store.js';
import { memAvailableMb, workspaceFor } from './agent/claude.js';

/**
 * Each Bot's own computer: a virtual X display on this VM (Xvfb + openbox) with its own
 * Chromium profile, exposed to the viewer through x11vnc on localhost. Screens start on
 * first use, are capped (RAM), and go to sleep after a while without use or viewers.
 */

export const SCREEN_W = 1280;
export const SCREEN_H = 800;
const FIRST_DISPLAY = 101;

interface Screen { botId: string; display: number; vncPort: number; procs: ChildProcess[]; lastUsed: number }

const screens = new Map<string, Screen>();
const starting = new Map<string, Promise<Screen>>();
const viewers = new Map<string, number>();

export const screenOf = (botId: string) => screens.get(botId) ?? null;
export const activeScreens = () => [...screens.values()].map((s) => ({ botId: s.botId, display: s.display, lastUsed: s.lastUsed }));

export function viewerOpened(botId: string) { viewers.set(botId, (viewers.get(botId) ?? 0) + 1); }
export function viewerClosed(botId: string) {
  const n = (viewers.get(botId) ?? 1) - 1;
  if (n > 0) viewers.set(botId, n); else viewers.delete(botId);
  const s = screens.get(botId);
  if (s) s.lastUsed = Date.now();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out starting ${what}`);
}

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });

/** Free display number, clearing lock files left by a crashed Xvfb. */
function freeDisplay(): number {
  const used = new Set([...screens.values()].map((s) => s.display));
  for (let n = FIRST_DISPLAY; n < FIRST_DISPLAY + 50; n++) {
    if (used.has(n)) continue;
    const lock = `/tmp/.X${n}-lock`;
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, 'utf8').trim());
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
      if (alive) continue;
      fs.rmSync(lock, { force: true });
      fs.rmSync(`/tmp/.X11-unix/X${n}`, { force: true });
    }
    return n;
  }
  throw new Error('No free display');
}

function launch(cmd: string, args: string[], display: number): ChildProcess {
  const p = spawn(cmd, args, { env: { ...process.env, DISPLAY: `:${display}` }, stdio: 'ignore' });
  p.on('error', (e) => console.warn(`[computer] ${cmd} failed:`, e.message));
  return p;
}

/** The Bot's screen, started if needed (may put another idle Bot's screen to sleep). */
export function screenFor(botId: string): Promise<Screen> {
  const s = screens.get(botId);
  if (s) { s.lastUsed = Date.now(); return Promise.resolve(s); }
  let p = starting.get(botId);
  if (!p) {
    p = startScreen(botId).finally(() => starting.delete(botId));
    starting.set(botId, p);
  }
  return p;
}

async function startScreen(botId: string): Promise<Screen> {
  if (screens.size + starting.size >= env.maxScreens) {
    // Reuse a slot: the least recently used screen whose Bot is idle and nobody is watching.
    const victim = [...screens.values()]
      .filter((s) => !getLive(s.botId).isRunning && !viewers.get(s.botId))
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) throw new Error(`All ${env.maxScreens} Bot screens are busy right now. Try again when another Bot finishes.`);
    stopScreen(victim.botId, 'make room');
  }
  const free = memAvailableMb();
  if (free < env.minFreeMb + 300) throw new Error(`Not enough free memory to start a screen (${free} MB available). Close another Bot's computer first.`);

  const display = freeDisplay();
  const vncPort = 5800 + display;
  const procs: ChildProcess[] = [];
  const screen: Screen = { botId, display, vncPort, procs, lastUsed: Date.now() };
  try {
    procs.push(launch('Xvfb', [`:${display}`, '-screen', '0', `${SCREEN_W}x${SCREEN_H}x24`, '-nolisten', 'tcp', '-dpi', '96'], display));
    await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${display}`), 10_000, 'the screen');
    procs.push(launch('openbox', [], display));
    launch('xsetroot', ['-solid', '#2B2D31'], display);
    procs.push(launch('x11vnc', ['-display', `:${display}`, '-localhost', '-rfbport', String(vncPort), '-forever', '-shared', '-nopw', '-quiet', '-noxdamage'], display));
    await waitFor(() => portOpen(vncPort), 10_000, 'the screen viewer');
  } catch (e) {
    for (const p of procs) p.kill('SIGKILL');
    throw e;
  }
  procs[0].on('exit', () => { if (screens.get(botId) === screen) stopScreen(botId, 'display exited'); });
  screens.set(botId, screen);
  setLive(botId, { screen: true });
  console.log(`[computer] started screen :${display} for ${botId} (${screens.size}/${env.maxScreens})`);
  return screen;
}

/** Put a Bot's screen to sleep. Closing the display also closes every app on it; the browser profile is kept. */
export function stopScreen(botId: string, reason = 'manual') {
  const s = screens.get(botId);
  if (!s) return false;
  screens.delete(botId);
  for (const p of [...s.procs].reverse()) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
  setLive(botId, { screen: false });
  console.log(`[computer] stopped screen :${s.display} for ${botId} (${reason})`);
  return true;
}

export function startIdleScreens() {
  const t = setInterval(() => {
    const cutoff = Date.now() - env.screenIdleMin * 60_000;
    for (const s of [...screens.values()]) {
      if (s.lastUsed < cutoff && !viewers.get(s.botId) && !getLive(s.botId).isRunning) stopScreen(s.botId, 'idle');
    }
  }, 60_000);
  t.unref();
}

// ---------- actions ----------

function run(cmd: string, args: string[], display: number, timeout = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, DISPLAY: `:${display}` }, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout }, (err, out, errOut) => {
      if (err) reject(new Error(`${cmd}: ${errOut?.toString().trim() || err.message}`));
      else resolve(out);
    });
  });
}

const lastShots = new Map<string, Buffer>();

export async function screenshot(botId: string): Promise<Buffer> {
  const s = await screenFor(botId);
  const img = await run('import', ['-window', 'root', '-quality', '72', 'jpeg:-'], s.display);
  lastShots.set(botId, img);
  return img;
}

/** Small data-URL thumbnail of the Bot's latest screenshot, for the transcript's step list. */
export async function lastShotThumbnail(botId: string): Promise<string | null> {
  const img = lastShots.get(botId);
  if (!img) return null;
  const small = await new Promise<Buffer>((resolve, reject) => {
    const p = execFile('convert', ['jpeg:-', '-resize', '480x', '-quality', '60', 'jpeg:-'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }, (err, out) => (err ? reject(err) : resolve(out)));
    p.stdin?.end(img);
  });
  return `data:image/jpeg;base64,${small.toString('base64')}`;
}

/** Run xdotool on the Bot's screen. */
export async function xdo(botId: string, args: string[]) {
  const s = await screenFor(botId);
  await run('xdotool', args, s.display);
}

export async function openBrowser(botId: string, url: string) {
  const s = await screenFor(botId);
  const profile = path.join(workspaceFor(botId), '.grokbot', `chrome-${botId}`);
  fs.mkdirSync(profile, { recursive: true });
  // If this profile's Chromium is already running, it opens the URL as a new tab and this process exits.
  const p = spawn('chromium', [
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--password-store=basic',
    '--disable-dev-shm-usage', '--disable-gpu', '--renderer-process-limit=4',
    '--hide-crash-restore-bubble', '--disable-features=Translate,MediaRouter',
    '--start-maximized', `--window-size=${SCREEN_W},${SCREEN_H}`, '--window-position=0,0',
    url,
  ], { env: { ...process.env, DISPLAY: `:${s.display}` }, stdio: 'ignore', detached: true });
  p.unref();
  s.lastUsed = Date.now();
}
