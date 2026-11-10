import crypto from 'node:crypto';
import { db, now } from './db.js';
import { env } from './env.js';
import { addApp, type App, type AppInput } from './apps.js';

/**
 * Sign-in (OAuth) for hosted MCP servers such as Linear, Notion and Sentry, following the MCP
 * authorization spec: find the server's authorization server, register this install as a
 * public client, send the user to sign in (PKCE), then keep the access token fresh.
 * Tokens stay in the apps table and never leave the server.
 */

interface OAuthState {
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  /** The MCP server URL the token is for (RFC 8707). */
  resource: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; 0 when the server didn't say. */
  expiresAt: number;
}

interface Pending {
  input: AppInput;
  verifier: string;
  redirectUri: string;
  oauth: Omit<OAuthState, 'accessToken' | 'refreshToken' | 'expiresAt'>;
  /** The chat card that asked for the app, if any. */
  botId?: string;
  seq?: number;
  createdAt: number;
}

const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 15 * 60_000;

const b64url = (b: Buffer) => b.toString('base64url');

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Where a server's metadata may live: /.well-known/<name> before the path (RFC 8414), then after it. */
function wellKnown(base: string, name: string): string[] {
  const u = new URL(base);
  const p = u.pathname.replace(/\/+$/, '');
  return [...new Set([`${u.origin}/.well-known/${name}${p}`, `${u.origin}${p}/.well-known/${name}`, `${u.origin}/.well-known/${name}`])];
}

/** Find the authorization server for an MCP server URL. */
async function discover(mcpUrl: string): Promise<{ authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null; scope: string | null }> {
  const probe = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grokbot', version: '1.0.0' } } }),
    signal: AbortSignal.timeout(15_000),
  });
  await probe.body?.cancel().catch(() => {});
  if (probe.ok) throw new Error('This app works without a sign-in. Connect it with its URL instead.');
  const challenge = probe.headers.get('www-authenticate') ?? '';
  const hinted = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
  let scope = challenge.match(/scope="([^"]+)"/)?.[1] ?? null;

  let issuer = new URL(mcpUrl).origin;
  for (const url of [...(hinted ? [hinted] : []), ...wellKnown(mcpUrl, 'oauth-protected-resource')]) {
    const meta = await getJson(url);
    if (!meta) continue;
    if (typeof meta.authorization_servers?.[0] === 'string') issuer = meta.authorization_servers[0];
    if (!scope && Array.isArray(meta.scopes_supported)) scope = meta.scopes_supported.join(' ');
    break;
  }

  for (const url of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) {
    const meta = await getJson(url);
    if (!meta?.authorization_endpoint || !meta?.token_endpoint) continue;
    return { authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint, registrationEndpoint: meta.registration_endpoint ?? null, scope };
  }
  if (probe.status !== 401) throw new Error(`The app's server answered HTTP ${probe.status} and doesn't offer a sign-in.`);
  // Older MCP servers publish no metadata and use fixed paths on their own origin.
  const origin = new URL(issuer).origin;
  return { authorizationEndpoint: `${origin}/authorize`, tokenEndpoint: `${origin}/token`, registrationEndpoint: `${origin}/register`, scope };
}

/**
 * Start a sign-in. `origin` is the address the user's browser reaches this server on;
 * the app sends the browser back to it when the sign-in is done.
 */
export async function startOAuth(input: AppInput, origin: string, ctx: { botId?: string; seq?: number } = {}): Promise<{ authUrl: string }> {
  const url = String(input.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter the MCP server URL (https://…)');
  if (!String(input.name ?? '').trim()) throw new Error('Give the app a name');
  if (!/^https?:\/\/[^/]+$/i.test(origin)) throw new Error('Could not tell which address to return to after the sign-in.');
  const redirectUri = `${origin}/api/apps/oauth/callback`;

  const d = await discover(url);
  if (!d.registrationEndpoint) throw new Error('This app only allows sign-ins from apps it has approved in advance, so it can’t be connected this way.');
  const reg = await fetch(d.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Grok Bot (self-hosted)', redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const client = (await reg.json().catch(() => null)) as any;
  if (!reg.ok || !client?.client_id) throw new Error(`The app refused to set up a sign-in (HTTP ${reg.status}). ${String(client?.error_description ?? client?.error ?? '').slice(0, 200)}`.trim());

  for (const [k, p] of pending) if (now() - p.createdAt > PENDING_TTL_MS) pending.delete(k);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  pending.set(state, {
    input: { ...input, url, transport: input.transport === 'sse' ? 'sse' : 'http', headers: {}, env: {} },
    verifier, redirectUri, botId: ctx.botId, seq: ctx.seq, createdAt: now(),
    oauth: { clientId: client.client_id, clientSecret: client.client_secret || undefined, tokenEndpoint: d.tokenEndpoint, resource: url },
  });

  const auth = new URL(d.authorizationEndpoint);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', client.client_id);
  auth.searchParams.set('redirect_uri', redirectUri);
  auth.searchParams.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', state);
  auth.searchParams.set('resource', url);
  if (d.scope) auth.searchParams.set('scope', d.scope);
  return { authUrl: auth.toString() };
}

async function tokenRequest(o: Pick<OAuthState, 'tokenEndpoint' | 'clientId' | 'clientSecret' | 'resource'>, params: Record<string, string>) {
  const body = new URLSearchParams({ ...params, client_id: o.clientId, resource: o.resource });
  if (o.clientSecret) body.set('client_secret', o.clientSecret);
  const res = await fetch(o.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body, signal: AbortSignal.timeout(15_000),
  });
  const t = (await res.json().catch(() => null)) as any;
  if (!res.ok || !t?.access_token) throw new Error(String(t?.error_description ?? t?.error ?? `HTTP ${res.status}`).slice(0, 200));
  return { accessToken: String(t.access_token), refreshToken: t.refresh_token ? String(t.refresh_token) : undefined, expiresAt: Number(t.expires_in) > 0 ? now() + Number(t.expires_in) * 1000 : 0 };
}

/** The app sent the browser back after the sign-in: trade the code for tokens and save the app. */
export async function finishOAuth(state: string, code: string): Promise<{ app: App; botId?: string; seq?: number }> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || now() - p.createdAt > PENDING_TTL_MS) throw new Error('This sign-in has expired. Start it again from Connect Apps.');
  const tokens = await tokenRequest(p.oauth, { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
  const app = addApp(p.input);
  if (typeof app === 'string') throw new Error(app);
  db.prepare('UPDATE apps SET oauth=? WHERE slug=?').run(JSON.stringify({ ...p.oauth, ...tokens } satisfies OAuthState), app.slug);
  return { app: { ...app, oauth: true }, botId: p.botId, seq: p.seq };
}

const refreshing = new Map<string, Promise<void>>();

async function refreshOne(slug: string, o: OAuthState) {
  const t = await tokenRequest(o, { grant_type: 'refresh_token', refresh_token: o.refreshToken! });
  // Servers may rotate the refresh token; keep the old one when they don't send a new one.
  db.prepare('UPDATE apps SET oauth=? WHERE slug=?').run(JSON.stringify({ ...o, ...t, refreshToken: t.refreshToken ?? o.refreshToken } satisfies OAuthState), slug);
}

/** Renew sign-in tokens that would run out during a turn. Called before each turn starts. */
export async function refreshOAuthTokens() {
  const margin = (env.turnTimeoutMin + 5) * 60_000;
  for (const r of db.prepare('SELECT slug, oauth FROM apps WHERE oauth IS NOT NULL').all() as { slug: string; oauth: string }[]) {
    const o = JSON.parse(r.oauth) as OAuthState;
    if (!o.refreshToken || !o.expiresAt || o.expiresAt - now() > margin) continue;
    let job = refreshing.get(r.slug);
    if (!job) {
      job = refreshOne(r.slug, o).finally(() => refreshing.delete(r.slug));
      refreshing.set(r.slug, job);
    }
    await job.catch((e) => console.warn(`[oauth] could not renew the sign-in for ${r.slug}:`, e?.message ?? e));
  }
}
