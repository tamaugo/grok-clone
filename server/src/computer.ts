import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { env } from './env.js';
import { getLive, setLive } from './store.js';
import { libraryFor, memAvailableMb, workspaceFor } from './agent/claude.js';

/**
 * Each Bot's own computer: a headless Chromium with its own persistent profile, driven over
 * CDP with Playwright. The Bot acts on the page through accessibility snapshots (element refs)
 * and screenshots; the viewer gets a live JPEG screencast and can send mouse and keyboard input.
 * Browsers start on first use, are capped (RAM), and go to sleep after a while without use or viewers.
 */

export const SCREEN_W = 1280;
export const SCREEN_H = 800;
const HOME_URL = 'https://duckduckgo.com/';

/** A viewer of the active tab. `retarget` moves it to a new active tab; `state` resends the URL and title. */
interface Viewer { retarget: (page: Page) => void; state: () => void }

interface Screen { botId: string; context: BrowserContext; page: Page; lastUsed: number; viewers: Set<Viewer> }

const screens = new Map<string, Screen>();
const starting = new Map<string, Promise<Screen>>();

export const screenOf = (botId: string) => screens.get(botId) ?? null;
export const activeScreens = () => [...screens.values()].map((s) => ({ botId: s.botId, lastUsed: s.lastUsed, url: s.page.url() }));

const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/snap/bin/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

let browserInfo: { executablePath: string; userAgent: string } | null = null;

/** The Chromium to run, and a normal (non-"HeadlessChrome") user agent for its version. */
function chromiumInfo() {
  if (browserInfo) return browserInfo;
  const executablePath = env.chromiumPath || CHROMIUM_CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) throw new Error('Chromium is not installed. Install it (apt install chromium) or set CHROMIUM_PATH.');
  let major = '140';
  try { major = execFileSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 10_000 }).match(/(\d+)\.\d+/)?.[1] ?? major; } catch { /* keep default */ }
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  browserInfo = { executablePath, userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` };
  return browserInfo;
}

/** The Bot's browser, started if needed (may put another idle Bot's browser to sleep). */
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

/** The Bot's active tab, its browser started if needed. */
export async function pageFor(botId: string): Promise<Page> {
  return (await screenFor(botId)).page;
}

async function startScreen(botId: string): Promise<Screen> {
  if (screens.size + starting.size >= env.maxScreens) {
    // Reuse a slot: the least recently used browser whose Bot is idle and nobody is watching.
    const victim = [...screens.values()]
      .filter((s) => !getLive(s.botId).isRunning && !s.viewers.size)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) throw new Error(`All ${env.maxScreens} Bot computers are busy right now. Try again when another Bot finishes.`);
    await stopScreen(victim.botId, 'make room');
  }
  const free = memAvailableMb();
  if (free < env.minFreeMb + 300) throw new Error(`Not enough free memory to start a computer (${free} MB available). Close another Bot's computer first.`);

  const { executablePath, userAgent } = chromiumInfo();
  const profile = path.join(workspaceFor(botId), '.grokbot', `chrome-${botId}`);
  fs.mkdirSync(profile, { recursive: true });
  // A Chromium killed mid-run leaves its profile locked.
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(profile, f), { force: true });

  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    viewport: { width: SCREEN_W, height: SCREEN_H },
    deviceScaleFactor: 1,
    userAgent,
    acceptDownloads: true,
    // The server closes browsers itself on shutdown (index.ts); Playwright's own handlers would keep it from exiting.
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    ignoreDefaultArgs: ['--enable-automation', '--hide-scrollbars'],
    args: ['--disable-dev-shm-usage', '--renderer-process-limit=4', '--password-store=basic', '--disable-features=Translate,MediaRouter'],
  });
  const first = context.pages()[0] ?? await context.newPage();
  const screen: Screen = { botId, context, page: first, lastUsed: Date.now(), viewers: new Set() };

  const watch = (page: Page) => {
    page.on('dialog', (d) => { d.accept().catch(() => {}); });
    page.on('download', (d) => {
      const dest = path.join(libraryFor(botId), path.basename(d.suggestedFilename()) || 'download');
      d.saveAs(dest).catch((e) => console.warn('[computer] download failed:', e.message));
    });
    page.on('framenavigated', (f) => { if (f === page.mainFrame() && screen.page === page) for (const v of screen.viewers) v.state(); });
    page.on('close', () => {
      if (screen.page !== page) return;
      const rest = context.pages();
      if (rest.length) setActive(screen, rest[rest.length - 1]);
      else context.newPage().catch(() => {});
    });
  };
  for (const p of context.pages()) watch(p);
  // New tabs and popups become the active tab, like a person following a link.
  context.on('page', (p) => { watch(p); setActive(screen, p); });
  context.on('close', () => {
    if (screens.get(botId) !== screen) return;
    screens.delete(botId);
    setLive(botId, { screen: false });
    console.log(`[computer] browser closed for ${botId}`);
  });

  if (first.url() === 'about:blank') await first.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
  screens.set(botId, screen);
  setLive(botId, { screen: true });
  console.log(`[computer] started browser for ${botId} (${screens.size}/${env.maxScreens})`);
  return screen;
}

function setActive(screen: Screen, page: Page) {
  if (screen.page === page) return;
  screen.page = page;
  for (const v of screen.viewers) v.retarget(page);
}

/** Switch the Bot's active tab. */
export function activateTab(botId: string, page: Page) {
  const s = screens.get(botId);
  if (s) { setActive(s, page); void page.bringToFront().catch(() => {}); }
}

/** Put a Bot's computer to sleep. The browser profile (logins, history) is kept. */
export async function stopScreen(botId: string, reason = 'manual') {
  const s = screens.get(botId);
  if (!s) return false;
  screens.delete(botId);
  setLive(botId, { screen: false });
  await s.context.close().catch(() => {});
  console.log(`[computer] stopped browser for ${botId} (${reason})`);
  return true;
}

/** Close every Bot's browser, e.g. when the server shuts down. */
export async function stopAllScreens() {
  await Promise.all([...screens.keys()].map((id) => stopScreen(id, 'shutdown')));
}

export function startIdleScreens() {
  const t = setInterval(() => {
    const cutoff = Date.now() - env.screenIdleMin * 60_000;
    for (const s of [...screens.values()]) {
      if (s.lastUsed < cutoff && !s.viewers.size && !getLive(s.botId).isRunning) void stopScreen(s.botId, 'idle');
    }
  }, 60_000);
  t.unref();
}

// ---------- screenshots ----------

const lastShots = new Map<string, Buffer>();

export async function screenshot(botId: string): Promise<Buffer> {
  const s = await screenFor(botId);
  const img = await s.page.screenshot({ type: 'jpeg', quality: 72, timeout: 15_000, animations: 'allow', caret: 'initial' });
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
  }).catch(() => img);
  return `data:image/jpeg;base64,${small.toString('base64')}`;
}

// ---------- live viewer ----------

export interface ViewerIO {
  sendFrame: (jpeg: Buffer) => void;
  sendJson: (msg: unknown) => void;
}

/** Bit flags CDP uses for modifier keys. */
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * Stream the Bot's active tab to a viewer as a JPEG screencast and, in control mode,
 * apply its mouse and keyboard input to the page over CDP.
 */
export async function attachViewer(botId: string, control: boolean, io: ViewerIO) {
  const screen = await screenFor(botId);
  let session: CDPSession | null = null;
  let page = screen.page;
  let closed = false;
  const pressedKeys = new Map<string, { key: string; code: string }>();
  const pressedButtons = new Map<string, { x: number; y: number }>();

  const state = () => {
    if (closed) return;
    void page.title().catch(() => '').then((title) => io.sendJson({ type: 'state', url: page.url(), title, width: SCREEN_W, height: SCREEN_H, control }));
  };

  const start = async (p: Page) => {
    const old = session;
    session = null;
    await old?.send('Page.stopScreencast').catch(() => {});
    await old?.detach().catch(() => {});
    if (closed) return;
    page = p;
    const s = await p.context().newCDPSession(p);
    if (closed) { await s.detach().catch(() => {}); return; }
    session = s;
    s.on('Page.screencastFrame', (f) => {
      io.sendFrame(Buffer.from(f.data, 'base64'));
      s.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await s.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: SCREEN_W, maxHeight: SCREEN_H, everyNthFrame: 1 });
    // The screencast only sends frames when something changes; send the current view right away.
    const still = await s.send('Page.captureScreenshot', { format: 'jpeg', quality: 75 }).catch(() => null);
    if (still && session === s) io.sendFrame(Buffer.from(still.data, 'base64'));
    state();
  };

  const viewer: Viewer = { retarget: (p) => { void start(p).catch(() => {}); }, state };
  screen.viewers.add(viewer);
  try {
    await start(page);
  } catch (e) {
    screen.viewers.delete(viewer);
    throw e;
  }

  /** Let go of any keys and buttons the viewer was holding, so nothing stays stuck down. */
  const release = async () => {
    const s = session;
    if (!s) return;
    for (const { key, code } of pressedKeys.values()) await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code }).catch(() => {});
    for (const [button, p] of pressedButtons) await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: button as 'left', ...p, buttons: 0, clickCount: 1 }).catch(() => {});
    pressedKeys.clear();
    pressedButtons.clear();
  };

  const onMessage = async (m: any) => {
    const s = session;
    if (!s || !control || !m || typeof m !== 'object') return;
    screen.lastUsed = Date.now();
    const modifiers = (m.alt ? MODIFIERS.alt : 0) | (m.ctrl ? MODIFIERS.ctrl : 0) | (m.meta ? MODIFIERS.meta : 0) | (m.shift ? MODIFIERS.shift : 0);
    switch (m.type) {
      case 'mouse': {
        const type = m.action === 'down' ? 'mousePressed' : m.action === 'up' ? 'mouseReleased' : 'mouseMoved';
        const button = ['left', 'middle', 'right'].includes(m.button) ? m.button : 'none';
        const x = num(m.x), y = num(m.y);
        await s.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: num(m.buttons), clickCount: type === 'mouseMoved' ? 0 : Math.max(1, num(m.clickCount, 1)), modifiers });
        if (button !== 'none') { if (type === 'mousePressed') pressedButtons.set(button, { x, y }); else if (type === 'mouseReleased') pressedButtons.delete(button); }
        return;
      }
      case 'wheel':
        await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: num(m.x), y: num(m.y), deltaX: num(m.deltaX), deltaY: num(m.deltaY), modifiers });
        return;
      case 'key': {
        const key = String(m.key ?? ''), code = String(m.code ?? '');
        if (m.action === 'up') {
          await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: num(m.keyCode) });
          pressedKeys.delete(code || key);
          return;
        }
        // Printable characters (and Enter) carry text; shortcuts and control keys don't.
        const text = key === 'Enter' ? '\r' : key.length === 1 && !(modifiers & (MODIFIERS.ctrl | MODIFIERS.meta)) ? key : undefined;
        await s.send('Input.dispatchKeyEvent', {
          type: text ? 'keyDown' : 'rawKeyDown', key, code, modifiers,
          windowsVirtualKeyCode: num(m.keyCode), ...(text ? { text, unmodifiedText: text } : {}),
        });
        pressedKeys.set(code || key, { key, code });
        return;
      }
      case 'text':
        if (typeof m.text === 'string' && m.text) await s.send('Input.insertText', { text: m.text.slice(0, 10_000) });
        return;
      case 'navigate': {
        const url = toUrl(String(m.url ?? ''));
        if (url) await page.goto(url, { waitUntil: 'commit', timeout: 15_000 }).catch(() => {});
        return;
      }
      case 'history':
        await (num(m.delta) < 0 ? page.goBack({ waitUntil: 'commit', timeout: 15_000 }) : page.goForward({ waitUntil: 'commit', timeout: 15_000 })).catch(() => {});
        return;
      case 'reload':
        await page.reload({ waitUntil: 'commit', timeout: 15_000 }).catch(() => {});
        return;
    }
  };

  const close = async () => {
    if (closed) return;
    await release();
    closed = true;
    screen.viewers.delete(viewer);
    screen.lastUsed = Date.now();
    const s = session;
    session = null;
    await s?.send('Page.stopScreencast').catch(() => {});
    await s?.detach().catch(() => {});
  };

  return { onMessage: (m: unknown) => { void onMessage(m).catch(() => {}); }, close };
}

/** What a person typed in the address bar: a URL, a bare domain, or a search. */
export function toUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^(https?|file):\/\//i.test(t) || /^about:/i.test(t)) return t;
  if (/^[^\s/]+\.[^\s]{2,}$/.test(t) || /^localhost(:\d+)?(\/|$)/.test(t)) return `https://${t}`;
  return `${HOME_URL}?q=${encodeURIComponent(t)}`;
}
