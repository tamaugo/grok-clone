import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { db } from './db.js';
import { LOCAL_USER } from './lib/auth.js';
import { attachViewer } from './computer.js';

/**
 * Live view of a Bot's browser: `/api/bots/:id/screen?mode=watch|control`.
 * Server -> client: binary messages are JPEG frames; text messages are JSON state (URL, title, size).
 * Client -> server (control mode only): JSON mouse, wheel, key, text and navigation messages.
 * In watch mode the server ignores input, so a viewer can't act on the page.
 */

/** Skip frames while this much is still waiting to go out, so a slow link drops frames instead of lagging. */
const MAX_BUFFERED = 2 * 1024 * 1024;

export function attachScreenViewer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/screen$/);
    if (!m) return; // not ours
    const bot = db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').get(m[1], LOCAL_USER.id) as { id: string } | undefined;
    if (!bot) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const control = url.searchParams.get('mode') === 'control';
    wss.handleUpgrade(req, socket, head, (client) => void serve(client, bot.id, control));
  });
}

async function serve(client: WebSocket, botId: string, control: boolean) {
  let viewer: Awaited<ReturnType<typeof attachViewer>> | null = null;
  let gone = false;
  client.on('close', () => { gone = true; void viewer?.close(); });
  client.on('message', (data, isBinary) => {
    if (isBinary || !viewer) return;
    try { viewer.onMessage(JSON.parse(data.toString())); } catch { /* not JSON */ }
  });
  try {
    // Opening the viewer wakes the Bot's computer.
    const v = await attachViewer(botId, control, {
      sendFrame: (jpeg) => { if (client.readyState === WebSocket.OPEN && client.bufferedAmount < MAX_BUFFERED) client.send(jpeg, { binary: true }); },
      sendJson: (msg) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg)); },
    });
    if (gone) return void v.close();
    viewer = v;
  } catch (e: any) {
    console.warn('[viewer] could not attach', e?.message ?? e);
    try { client.close(1011, String(e?.message ?? e).slice(0, 120)); } catch { /* closed */ }
  }
}
