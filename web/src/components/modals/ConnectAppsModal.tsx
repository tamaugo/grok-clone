import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectedApp } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { api, type AppInput } from '../../lib/api';
import { CATALOG, catalogInput, type CatalogApp } from '../../lib/appCatalog';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Menu } from '../Menu';
import { ToolkitLogo } from '../ToolkitLogo';
import { Modal } from './Modal';

/** Design pill → catalog category. */
const PILLS: { label: string; category: string }[] = [
  { label: 'Productivity', category: 'productivity' },
  { label: 'Communication', category: 'communication' },
  { label: 'Code', category: 'developer tools' },
  { label: 'Search', category: 'search' },
  { label: 'Finance', category: 'finance' },
];

/** A row in the modal: a catalog app, a built-in capability, or a custom app you added. */
interface Toolkit { slug: string; name: string; logo?: string; description?: string; categories: string[]; connected: boolean; noAuth: boolean; catalog?: CatalogApp }

const CUSTOM: Toolkit = { slug: '__custom', name: 'Custom app', description: 'Any MCP server: a URL with an optional token, or a command that runs on your VM.', categories: [], connected: false, noAuth: false };
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bAi\b/g, 'AI').replace(/\bCrm\b/g, 'CRM').replace(/\bSeo\b/g, 'SEO').replace(/\bIt\b/g, 'IT').replace(/\bHr\b/g, 'HR').replace(/\bSms\b/g, 'SMS').replace(/\bUrl\b/g, 'URL').replace(/\bOcr\b/g, 'OCR');
const pillLabel = (cat: string) => PILLS.find((p) => p.category === cat)?.label ?? titleCase(cat);
const splitCommand = (s: string): [string, string[]] => {
  const parts = (s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((p) => p.replace(/^["']|["']$/g, ''));
  return [parts[0] ?? '', parts.slice(1)];
};

/**
 * Open the app's own sign-in (OAuth) in a new tab. The tab is opened before the request so
 * browsers don't block it; the server reports the result through a `connections` event.
 */
async function signIn(input: AppInput) {
  const tab = window.open('', '_blank');
  try {
    const { authUrl } = await api.oauthStart({ ...input, origin: window.location.origin, ...appsContextIds() });
    if (tab) tab.location.href = authUrl; else window.location.href = authUrl;
  } catch (e) {
    tab?.close();
    throw e;
  }
}

type View = { kind: 'all' } | { kind: 'category'; category: string } | { kind: 'connected' } | { kind: 'form'; app: Toolkit };

function AppRow({ app, onChanged, onForm }: { app: Toolkit; onChanged: () => void; onForm: (app: Toolkit) => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'waiting' | 'confirm'>('idle');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setState('idle'); }, [app.connected]);

  const connect = async () => {
    // Apps that need a key (and custom apps) open a short form; the rest connect in one click.
    if (!app.catalog || app.catalog.fields?.length) { onForm(app); return; }
    setState('busy'); setError(null);
    try {
      if (app.catalog.oauth) { await signIn(catalogInput(app.catalog, {})); setState('waiting'); return; }
      const { test } = await api.addApp({ ...catalogInput(app.catalog, {}), ...appsContextIds() });
      if (!test.ok) { await api.disconnect(app.slug).catch(() => {}); throw new Error(test.error || 'Couldn’t reach the app'); }
      onChanged();
    } catch (e) {
      setError((e as Error).message || 'Couldn’t start the connection');
      setState('idle');
    }
  };
  const disconnect = async () => {
    if (state !== 'confirm') { setState('confirm'); return; }
    setState('busy');
    try { await api.disconnect(app.slug); onChanged(); } catch (e) { setError((e as Error).message); setState('idle'); }
  };

  return (
    <div className="app-row" title={app.description}>
      <ToolkitLogo name={app.name} logo={app.logo} />
      <span className="app-row__text">
        <span className="app-row__name">{app.name}</span>
        {error ? <span className="app-row__error">{error}</span> : app.description && <span className="app-row__desc">{app.description}</span>}
      </span>
      {app.connected ? (
        <button type="button" className={`app-row__connected${state === 'confirm' ? ' is-confirm' : ''}`} onClick={disconnect} onMouseLeave={() => state === 'confirm' && setState('idle')} disabled={state === 'busy'}>
          {state === 'confirm' ? 'Disconnect?' : <><Icon name="check" size={12} opacity={0.56} /><span className="app-row__connected-label">Connected</span><span className="app-row__disconnect-label">Disconnect</span></>}
        </button>
      ) : app.noAuth ? (
        <span className="app-row__connected is-static"><Icon name="check" size={12} opacity={0.56} />Built in</span>
      ) : (
        <button type="button" className="app-row__connect" onClick={connect} disabled={state === 'busy'}>
          {state === 'busy' ? 'Opening…' : state === 'waiting' ? 'Waiting…' : 'Connect'}
        </button>
      )}
    </div>
  );
}

function Grid({ apps, onChanged, onForm }: { apps: Toolkit[]; onChanged: () => void; onForm: (app: Toolkit) => void }) {
  return (
    <div className="app-grid">
      {apps.map((a) => <AppRow key={a.slug} app={a} onChanged={onChanged} onForm={onForm} />)}
    </div>
  );
}

function Section({ title, apps, onViewAll, onChanged, onForm }: { title: string; apps: Toolkit[]; onViewAll?: () => void; onChanged: () => void; onForm: (app: Toolkit) => void }) {
  if (!apps.length) return null;
  return (
    <section className="apps-section">
      <div className="apps-section__head">
        <span className="apps-section__title">{title}</span>
        {onViewAll && <button type="button" className="link-btn link-btn--small" onClick={onViewAll}>View all</button>}
      </div>
      <Grid apps={apps} onChanged={onChanged} onForm={onForm} />
    </section>
  );
}

/** The chat card that asked for an app, so connecting it can tell the Bot. */
const appsContextIds = () => {
  const c = useStore.getState().appsContext;
  return c ? { botId: c.botId, seq: c.seq } : {};
};

export function ConnectAppsModal() {
  const setModal = useStore((s) => s.setModal);
  const connectionsVersion = useStore((s) => s.connectionsVersion);
  const primary = useStore((s) => s.bots.find((b) => b.isPrimary));
  const close = useCallback(() => { useStore.getState().set({ appsContext: null }); setModal(null); }, [setModal]);
  const [view, setView] = useState<View>({ kind: 'all' });
  const [search, setSearch] = useState(() => useStore.getState().appsContext?.query ?? '');
  const [debounced, setDebounced] = useState(search);
  const [installed, setInstalled] = useState<ConnectedApp[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [bump, setBump] = useState(0);
  const refresh = useCallback(() => setBump((n) => n + 1), []);
  const onForm = useCallback((app: Toolkit) => setView({ kind: 'form', app }), []);

  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim()), 200); return () => clearTimeout(t); }, [search]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.apps()
      .then((d) => { if (alive) setInstalled(d.apps); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [connectionsVersion, bump]);

  const all = useMemo<Toolkit[]>(() => {
    const have = new Set((installed ?? []).map((a) => a.slug));
    const fromCatalog = CATALOG.map((c) => ({ slug: c.slug, name: c.name, logo: c.domain ? `https://www.google.com/s2/favicons?domain=${c.domain}&sz=64` : undefined, description: c.description, categories: c.categories, connected: have.has(c.slug), noAuth: !!c.noAuth, catalog: c }));
    const custom = (installed ?? []).filter((a) => !CATALOG.some((c) => c.slug === a.slug)).map((a) => ({ slug: a.slug, name: a.name, logo: a.logo ?? undefined, description: a.description || a.url || a.command || undefined, categories: [], connected: true, noAuth: false }));
    return [...fromCatalog, ...custom];
  }, [installed]);
  const connectedApps = useMemo(() => all.filter((a) => a.connected), [all]);

  const searching = debounced.length > 0;
  const q = debounced.toLowerCase();
  const inCategory = view.kind === 'category' ? view.category : '';
  const apps = all.filter((a) => (!q || a.name.toLowerCase().includes(q) || a.slug.includes(q) || a.description?.toLowerCase().includes(q)) && (!inCategory || a.categories.includes(inCategory)));
  const data = installed ? { categories: [...new Set(CATALOG.flatMap((c) => c.categories))] } : null;
  const moreCategories = useMemo(() => (data?.categories ?? []).filter((c) => !PILLS.some((p) => p.category === c)), [data?.categories]);
  const activeCategory = view.kind === 'category' ? view.category : null;
  const moreActive = activeCategory !== null && !PILLS.some((p) => p.category === activeCategory);

  let body: React.ReactNode;
  if (error) body = <div className="apps-empty">Couldn’t load apps. {error}</div>;
  else if (!data && loading) body = <div className="apps-empty">Loading apps…</div>;
  else if (view.kind === 'form') body = <ConnectForm app={view.app} onBack={() => setView({ kind: 'all' })} onDone={() => { refresh(); setView({ kind: 'connected' }); }} />;
  else if (view.kind === 'connected') body = connectedApps.length ? <Section title="Connected" apps={connectedApps} onChanged={refresh} onForm={onForm} /> : <div className="apps-empty">No apps connected yet.</div>;
  else if (searching || view.kind === 'category') {
    body = apps.length ? (
      <Section title={searching ? `Results${activeCategory ? ` in ${pillLabel(activeCategory)}` : ''}` : pillLabel(activeCategory!)} apps={apps} onChanged={refresh} onForm={onForm} />
    ) : (
      <>
        <div className="apps-empty">No apps match “{debounced}”.</div>
        <Section title="Add it yourself" apps={[CUSTOM]} onChanged={refresh} onForm={onForm} />
      </>
    );
  } else {
    body = (
      <>
        <Section title="Picked for you" apps={apps.slice(0, 6)} onChanged={refresh} onForm={onForm} />
        {PILLS.map((p) => {
          const list = apps.filter((a) => a.categories.includes(p.category));
          return <Section key={p.category} title={p.label} apps={list.slice(0, 4)} onViewAll={list.length > 2 ? () => setView({ kind: 'category', category: p.category }) : undefined} onChanged={refresh} onForm={onForm} />;
        })}
        <Section title="Custom" apps={[CUSTOM]} onChanged={refresh} onForm={onForm} />
      </>
    );
  }

  const connectedCount = connectedApps.filter((a) => !a.noAuth).length;

  return (
    <Modal onClose={close} className="apps-modal" label="Connect Apps">
      <button type="button" className="modal__close apps-modal__close" onClick={close} aria-label="Close"><Icon name="close" size={16} opacity={0.68} /></button>
      <div className="apps-modal__head">
        <div className="apps-modal__titlerow">
          <span className="apps-modal__title">Connect Apps</span>
          <button type="button" className={`apps-modal__connected${view.kind === 'connected' ? ' is-active' : ''}`} onClick={() => setView(view.kind === 'connected' ? { kind: 'all' } : { kind: 'connected' })}>
            {connectedApps.length > 0 && (
              <span className="apps-modal__connected-logos">
                {connectedApps.slice(0, 4).map((a) => a.logo ? <img key={a.slug} src={a.logo} alt="" /> : null)}
              </span>
            )}
            <span>{connectedCount} connected</span>
            <Icon name="chev_right" size={12} opacity={0.56} />
          </button>
        </div>
        <div className="apps-modal__controls">
          <div className="apps-modal__searchrow">
            <label className="pill-input">
              <Icon name="search" size={14} opacity={0.56} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search apps and skills" aria-label="Search apps" />
            </label>
            <button type="button" className="pill-chip" title="Bot templates are coming soon" disabled>
              {primary && <BotAvatarFor bot={primary} size={22} />}
              <span>Bot templates</span>
              <Icon name="share" size={12} opacity={0.56} />
            </button>
          </div>
          <div className="cat-pills">
            <button type="button" className={`cat-pill${view.kind === 'all' ? ' is-active' : ''}`} onClick={() => setView({ kind: 'all' })}>All</button>
            {PILLS.map((p) => (
              <button key={p.category} type="button" className={`cat-pill${activeCategory === p.category ? ' is-active' : ''}`} onClick={() => setView({ kind: 'category', category: p.category })}>{p.label}</button>
            ))}
            {moreCategories.length > 0 && <span className="cat-pill-anchor">
              <button type="button" className={`cat-pill${moreActive ? ' is-active' : ''}`} onClick={() => setMore(!more)} aria-expanded={more}>
                {moreActive ? pillLabel(activeCategory!) : 'More'}
                <Icon name="chev_down" size={10} opacity={0.66} />
              </button>
              {more && (
                <Menu onClose={() => setMore(false)} items={moreCategories.map((c) => ({ label: titleCase(c), onSelect: () => setView({ kind: 'category', category: c }) }))} />
              )}
            </span>}
          </div>
        </div>
      </div>
      <div className={`apps-modal__body${loading ? ' is-loading' : ''}`}>{body}</div>
    </Modal>
  );
}

/** Connect form: the key a catalog app needs, or a custom MCP server. */
function ConnectForm({ app, onBack, onDone }: { app: Toolkit; onBack: () => void; onDone: () => void }) {
  const custom = !app.catalog;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  // A finished sign-in arrives as a `connections` event.
  const connectionsVersion = useStore((s) => s.connectionsVersion);
  const startVersion = useRef(connectionsVersion);
  useEffect(() => { if (waiting && connectionsVersion !== startVersion.current) onDone(); }, [waiting, connectionsVersion, onDone]);
  const put = (k: string, v: string) => setValues((cur) => ({ ...cur, [k]: v }));
  const fields = custom
    ? [
        { key: 'name', label: 'Name', placeholder: 'e.g. Linear', secret: false },
        { key: 'url', label: 'MCP server URL, or a command to run', placeholder: 'https://… or npx -y some-mcp-server', secret: false },
        { key: 'token', label: 'Token (optional)', placeholder: 'Sent as “Authorization: Bearer …” for URLs', secret: true },
      ]
    : (app.catalog!.fields ?? []).map((f) => ({ key: f.key, label: f.label, placeholder: f.placeholder ?? '', secret: true }));
  const ready = fields.every((f) => f.label.includes('optional') || (values[f.key] ?? '').trim());

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      let input;
      if (custom) {
        const target = (values.url ?? '').trim();
        const token = (values.token ?? '').trim();
        const [command, args] = splitCommand(target);
        input = /^https?:\/\//i.test(target)
          ? { name: values.name ?? '', transport: 'http' as const, url: target, headers: token ? { Authorization: `Bearer ${token}` } : {} }
          : { name: values.name ?? '', transport: 'stdio' as const, command, args };
      } else input = catalogInput(app.catalog!, values);
      const { app: added, test } = await api.addApp({ ...input, ...appsContextIds() });
      if (!test.ok) { await api.disconnect(added.slug).catch(() => {}); throw new Error(test.error || 'Couldn’t reach the app'); }
      onDone();
    } catch (e) {
      setError((e as Error).message || 'Couldn’t start the connection');
    } finally {
      setBusy(false);
    }
  };

  const signInUrl = custom && /^https?:\/\//i.test((values.url ?? '').trim()) && (values.name ?? '').trim() ? (values.url ?? '').trim() : null;
  const startSignIn = async () => {
    if (!signInUrl) return;
    setBusy(true); setError(null);
    try {
      startVersion.current = connectionsVersion;
      await signIn({ name: values.name ?? '', transport: 'http', url: signInUrl });
      setWaiting(true);
    } catch (e) {
      setError((e as Error).message || 'Couldn’t start the sign-in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="apps-section app-connect">
      <div className="apps-section__head">
        <span className="apps-section__title">Connect {app.name}</span>
        <button type="button" className="link-btn link-btn--small" onClick={onBack}>Back</button>
      </div>
      <div className="app-connect__intro">
        <ToolkitLogo name={app.name} logo={app.logo} size={44} />
        <span className="app-row__text">
          <span className="app-row__name">{app.name}</span>
          <span className="app-connect__desc">{app.description}</span>
        </span>
      </div>
      {app.catalog?.help && (
        <p className="app-connect__help">{app.catalog.help.text} <a href={app.catalog.help.url} target="_blank" rel="noreferrer">Open {new URL(app.catalog.help.url).hostname}</a></p>
      )}
      {fields.map((f) => (
        <label key={f.key} className="app-connect__field">
          <span>{f.label}</span>
          <span className="pill-input">
            <input type={f.secret ? 'password' : 'text'} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => put(f.key, e.target.value)} autoComplete="off" spellCheck={false} />
          </span>
        </label>
      ))}
      {error && <div className="app-row__error app-connect__error">{error}</div>}
      {waiting && <p className="app-connect__help">Finish signing in in the tab that opened. This closes on its own when the app is connected.</p>}
      {custom && (
        <p className="app-connect__help">
          No token? <button type="button" className="link-btn link-btn--small" onClick={startSignIn} disabled={busy || !signInUrl}>Sign in at the app instead</button>
        </p>
      )}
      <div className="app-connect__actions">
        <button type="button" className="btn btn--secondary" onClick={onBack} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn--primary" onClick={submit} disabled={busy || !ready}>{busy ? 'Connecting…' : 'Connect'}</button>
      </div>
    </section>
  );
}
