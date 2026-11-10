import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { api, setupLocalUser } from './routes.js';
import { initRoutines } from './routines.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue } from './agent/loop.js';
import { mcpApi } from './agent/mcp.js';
import { memAvailableKnownMb, runningCount } from './agent/claude.js';
import { configApi } from './routes-config.js';
import { attachScreenViewer } from './viewer.js';
import { expireStaleApprovals } from './agent/approvals.js';
import { activeScreens, startIdleScreens, stopAllScreens } from './computer.js';
import type { Server } from 'node:http';

initSubagents();
initRooms();
setupLocalUser();
expireStaleApprovals();

const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true, running: runningCount(), maxConcurrent: env.maxConcurrent, screens: activeScreens().length, maxScreens: env.maxScreens, memAvailableMb: memAvailableKnownMb() }));
app.route('/mcp', mcpApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api', api);
app.route('/api', configApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) =>
  console.log(`[grokbot] server on http://${env.host}:${info.port} (Claude Code, max ${env.maxConcurrent} Bots at once, min ${env.minFreeMb} MB free)`),
);
attachScreenViewer(server as unknown as Server);
startIdleScreens();
// GROKBOT_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines don't fire twice.
const runScheduler = process.env.GROKBOT_NO_SCHEDULER !== '1';
initRoutines(enqueue, runScheduler);
initProactive(enqueue, runScheduler);
if (!runScheduler) console.log('[grokbot] scheduler disabled (GROKBOT_NO_SCHEDULER=1)');

// Close the Bots' browsers before exiting, so a restart doesn't leave Chromium processes behind.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    setTimeout(() => process.exit(0), 5_000).unref();
    void stopAllScreens().finally(() => process.exit(0));
  });
}
