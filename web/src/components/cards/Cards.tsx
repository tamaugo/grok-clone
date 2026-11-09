import { useEffect, useState } from 'react';
import type { CardBody, Row } from '@shared/types';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';

type Card<K extends CardBody['card']> = Extract<CardBody, { card: K }>;

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || 'Something went wrong'); } finally { setBusy(null); }
  };
  return { busy, error, run };
}

const prettyTool = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const KNOWN: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', hubspot: 'HubSpot', linkedin: 'LinkedIn', youtube: 'YouTube', clickup: 'ClickUp', googledocs: 'Google Docs', googledrive: 'Google Drive', googlesheets: 'Google Sheets', googlecalendar: 'Google Calendar', googletasks: 'Google Tasks', googlemeet: 'Google Meet' };
/** "googlecalendar" → "Google Calendar", "slack" → "Slack". */
export const humanizeToolkit = (slug: string) => KNOWN[slug.toLowerCase()] ?? slug.replace(/^(google|microsoft)(?=\w)/i, '$1 ').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ---------------- approval ----------------

const APPROVAL_OUTCOME: Record<string, string> = { allowed: 'Allowed once', always: 'Always allowed', denied: 'Not allowed', expired: 'Expired' };

export function ApprovalCard({ body }: { body: Card<'approval'> }) {
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const decide = (d: 'allow' | 'always' | 'deny') => run(d, () => api.approve(body.approvalId, d));
  const name = body.toolkitName ?? (body.toolkit ? humanizeToolkit(body.toolkit) : prettyTool(body.tool));
  return (
    <div className={`card approval-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name={name} logo={body.logo} size={44} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">{name}</div>
        </div>
      </div>
      {body.detail && <div className="card__body">{body.detail}</div>}
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('deny')}>Deny</button>
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('always')}>Always allow</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => decide('allow')}>Allow once</button>
          </div>
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'denied' || body.status === 'expired' ? 'close' : 'check'} size={12} opacity={0.7} />
          {APPROVAL_OUTCOME[body.status] ?? body.status}
        </div>
      )}
    </div>
  );
}

// ---------------- question ----------------

export function QuestionCard({ row, body }: { row: Row; body: Card<'question'> }) {
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return (
    <div className={`card question-card${pending ? '' : ' is-resolved'}`}>
      <div className="question-card__head">
        <div className="question-card__q">{body.question}</div>
        <div className="question-card__hint">{pending ? 'Pick an option or reply in your own words' : body.status === 'dismissed' ? 'Skipped' : 'Answered'}</div>
      </div>
      <div className="question-card__options">
        {body.options.map((opt, i) => {
          const chosen = body.answer === opt;
          return (
            <button
              key={i}
              type="button"
              className={`question-option${chosen ? ' is-chosen' : ''}`}
              disabled={!pending || !!busy}
              onClick={() => run(String(i), () => api.answer(row.botId, row.seq, opt))}
            >
              <span className="question-option__key">{letters[i] ?? i + 1}</span>
              <span className="question-option__label">{opt}</span>
              {chosen && <Icon name="check" size={12} opacity={0.6} style={{ marginLeft: 'auto', marginTop: 6 }} />}
            </button>
          );
        })}
      </div>
      {pending && (
        <div className="question-card__foot">
          <button type="button" className="link-btn" disabled={!!busy} onClick={() => run('dismiss', () => api.dismiss(row.botId, row.seq))}>Skip</button>
        </div>
      )}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

// ---------------- connect ----------------

export function ConnectCard({ row, body }: { row: Row; body: Card<'connect'> }) {
  const { busy, error, run } = useBusy();
  const [waiting, setWaiting] = useState(false);
  const connectionsVersion = useStore((s) => s.connectionsVersion);
  const pending = body.status === 'pending';

  // Leave the "waiting" state once the server reports a connection change or the card resolves.
  useEffect(() => { setWaiting(false); }, [connectionsVersion, body.status]);

  const connect = () => {
    useStore.getState().set({ appsContext: { botId: row.botId, seq: row.seq, query: body.toolkitName } });
    useStore.getState().setModal('apps');
    setWaiting(true);
  };

  return (
    <div className={`card connect-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name={body.toolkitName} logo={body.logo} size={44} />
        <div className="card__titles">
          <div className="card__title">Connect {body.toolkitName}</div>
          <div className="card__sub">{body.reason}</div>
        </div>
      </div>
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('skip', () => api.dismiss(row.botId, row.seq))}>Skip</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={connect}>{waiting ? 'Waiting…' : 'Connect'}</button>
          </div>
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'connected' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'connected' ? `${body.toolkitName} connected` : 'Skipped'}
        </div>
      )}
    </div>
  );
}

export function CardRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type !== 'card') return null;
  switch (b.card) {
    case 'approval': return <ApprovalCard body={b} />;
    case 'question': return <QuestionCard row={row} body={b} />;
    case 'connect': return <ConnectCard row={row} body={b} />;
    default: return null;
  }
}
