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
import { memAvailableMb, runningCount } from './agent/claude.js';
import { configApi } from './routes-config.js';

initSubagents();
initRooms();
setupLocalUser();

const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true, running: runningCount(), maxConcurrent: env.maxConcurrent, memAvailableMb: memAvailableMb() }));
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

serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) =>
  console.log(`[grokbot] server on http://${env.host}:${info.port} (Claude Code, max ${env.maxConcurrent} Bots at once, min ${env.minFreeMb} MB free)`),
);
// GROKBOT_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines don't fire twice.
if (process.env.GROKBOT_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  initProactive(enqueue);
} else console.log('[grokbot] scheduler disabled (GROKBOT_NO_SCHEDULER=1)');
