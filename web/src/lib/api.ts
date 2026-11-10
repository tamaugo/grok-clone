import type { Attachment, Bot, ConnectedApp, LiveState, Routine, Row, User } from '@shared/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
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

export interface AppTest { ok: boolean; tools: { name: string; description?: string }[]; error?: string }

export interface RoomMember { id: string; name: string; label: string; avatarShape: string; avatarColor: string }

export const api = {
  me: () => req<{ user: User | null; devLogin: boolean }>('GET', '/auth/me'),

  bots: () => req<{ bots: Bot[]; live: LiveState[] }>('GET', '/bots'),
  createBot: (b: Pick<Bot, 'name' | 'avatarShape' | 'avatarColor' | 'mode' | 'model' | 'effort'>) => req<{ bot: Bot }>('POST', '/bots', b),
  markRead: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/read`),
  rows: (id: string) => req<{ generation: number; rows: Row[] }>('GET', `/bots/${id}/rows`),
  send: (id: string, text: string, attachments: string[] = []) => req<{ row: Row }>('POST', `/bots/${id}/messages`, { text, attachments }),
  upload: async (id: string, file: Blob): Promise<Attachment> => {
    const res = await fetch(`/api/bots/${id}/uploads`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new ApiError(res.status, msg);
    }
    return ((await res.json()) as { attachment: Attachment }).attachment;
  },
  uploadUrl: (id: string, name: string) => `/api/bots/${id}/uploads/${encodeURIComponent(name)}`,
  interrupt: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/interrupt`),
  fresh: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/fresh`),

  answer: (id: string, seq: number, answer: string) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/answer`, { answer }),
  dismiss: (id: string, seq: number) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/dismiss`),

  routines: (id: string) => req<{ routines: Routine[] }>('GET', `/bots/${id}/routines`),
  setRoutine: (rid: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${rid}`, { enabled }),

  approve: (approvalId: string, decision: 'allow' | 'always' | 'deny') => req<{ ok: true }>('POST', `/approvals/${approvalId}`, { decision }),

  ensureComputer: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/computer/start`),
  sleepComputer: (botId: string) => req<{ ok: boolean }>('POST', `/bots/${botId}/computer/stop`),

  apps: () => req<{ apps: ConnectedApp[] }>('GET', '/apps'),
  addApp: (app: AppInput & { botId?: string; seq?: number }) => req<{ app: ConnectedApp; test: AppTest }>('POST', '/apps', app),
  testApp: (slug: string) => req<AppTest>('POST', `/apps/${slug}/test`),
  /** Start a sign-in (OAuth) for a hosted app; the browser then opens `authUrl`. */
  oauthStart: (app: AppInput & { origin: string; botId?: string; seq?: number }) => req<{ authUrl: string }>('POST', '/apps/oauth/start', app),
  disconnect: (slug: string) => req<{ ok: true }>('DELETE', `/apps/${slug}`),

  roomMembers: (id: string) => req<{ members: RoomMember[] }>('GET', `/rooms/${id}/members`),
  setRoomMembers: (id: string, botIds: string[]) => req<{ ok: true; members: string[] }>('PUT', `/rooms/${id}/members`, { botIds }),
  createRoom: (name: string, botIds: string[]) => req<{ id: string }>('POST', '/rooms', { name, botIds }),
};
