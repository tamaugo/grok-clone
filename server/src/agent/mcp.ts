import { Hono } from 'hono';
import { token } from '../lib/ids.js';
import { TOOLS, toolMap, type ToolCtx } from './tools.js';
import { requestPermission } from './approvals.js';

/**
 * A minimal MCP server (Streamable HTTP, JSON responses) that gives each running
 * Claude Code turn the Bot's own tools: memory, routines, tasks, other Bots, groups.
 * Each turn gets a one-off bearer token tied to its Bot; it stops working when the turn ends.
 */

const turns = new Map<string, ToolCtx>();

/** Called by Claude Code itself (--permission-prompt-tool) before tools that need a decision. */
const PERMISSION_TOOL = {
  name: 'permission_prompt',
  description: 'Internal: permission check called by the system. Never call this yourself.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] },
};

export function openTurn(ctx: ToolCtx): { token: string; close: () => void } {
  const t = token();
  turns.set(t, ctx);
  return { token: t, close: () => turns.delete(t) };
}

const ok = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(ctx: ToolCtx, m: any): Promise<object | null> {
  if (m?.id === undefined || m?.id === null) return null; // notification
  switch (m.method) {
    case 'initialize':
      return ok(m.id, {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'grokbot', version: '1.0.0' },
      });
    case 'ping':
      return ok(m.id, {});
    case 'tools/list':
      return ok(m.id, { tools: [...TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })), PERMISSION_TOOL] });
    case 'tools/call': {
      if (m.params?.name === PERMISSION_TOOL.name) {
        // Claude Code's --permission-prompt-tool contract: reply with allow (+ input) or deny (+ message).
        const a = m.params?.arguments ?? {};
        const r = await requestPermission(ctx.botId, String(a.tool_name ?? ''), a.input);
        const text = JSON.stringify(r.allow ? { behavior: 'allow', updatedInput: a.input ?? {} } : { behavior: 'deny', message: r.message });
        return ok(m.id, { content: [{ type: 'text', text }] });
      }
      const tool = toolMap.get(m.params?.name);
      if (!tool) return fail(m.id, -32602, `Unknown tool ${m.params?.name}`);
      try {
        const res = await tool.impl(m.params?.arguments ?? {}, ctx);
        if (res.endTurn) ctx.turn.suppressReply = true;
        const content: object[] = [{ type: 'text', text: res.output }];
        if (res.image) content.push({ type: 'image', data: res.image.data, mimeType: res.image.mimeType });
        return ok(m.id, { content });
      } catch (e: any) {
        return ok(m.id, { content: [{ type: 'text', text: `Tool error: ${e?.message ?? e}` }], isError: true });
      }
    }
    default:
      return fail(m.id, -32601, `Method not found: ${m.method}`);
  }
}

export const mcpApi = new Hono();

mcpApi.post('/', async (c) => {
  const ctx = turns.get((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
  if (!ctx) return c.json(fail(null, -32001, 'This Bot turn has ended.'), 401);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json(fail(null, -32700, 'Parse error'), 400);
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(ctx, m)))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const out = await handle(ctx, body);
  return out ? c.json(out) : c.body(null, 202);
});

// No server-initiated stream; clients fall back to plain request/response.
mcpApi.get('/', (c) => c.body(null, 405));
mcpApi.delete('/', (c) => c.body(null, 200));
