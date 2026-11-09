import { useEffect, useState } from 'react';
import type { Routine } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { displayName, useSelectedBot, useStore } from '../store';
import { Icon } from './Icon';
import { MembersCard } from './MembersCard';
import { useConfigUI } from '../configStore';
import { Glyph } from './config/glyphs';
import { LibraryTab } from './config/LibraryTab';
import { BotTasks } from './config/TasksView';

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle__knob" />
    </button>
  );
}

function RoutineRow({ r }: { r: Routine }) {
  const [enabled, setEnabled] = useState(r.enabled);
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const toggle = async (v: boolean) => {
    setEnabled(v);
    try { await api.setRoutine(r.id, v); } catch { setEnabled(!v); }
  };
  return (
    <div className="panel-row panel-row--routine" title={r.prompt}>
      <span className="panel-row__icon"><Icon name="clock" opacity={0.52} /></span>
      <span className="panel-row__text">
        <span className="panel-row__title">{r.name}</span>
        <span className="panel-row__sub">{enabled ? r.description || r.schedule : 'Paused'}</span>
      </span>
      <Toggle on={enabled} onChange={toggle} label={`${r.name} ${enabled ? 'on' : 'off'}`} />
    </div>
  );
}

export function DetailsPanel() {
  const bot = useSelectedBot();
  const routines = useStore((s) => (bot ? s.routines[bot.id] : undefined));
  const set = useStore((s) => s.set);
  const [tab, setTab] = useState<'activity' | 'tasks' | 'library'>('activity');
  if (!bot) return null;

  return (
    <aside className="details" style={botVars(bot.avatarColor)} aria-label="Conversation details">
      <div className="details__top">
        <button type="button" className="icon-btn icon-btn--bordered details__gear" onClick={() => useConfigUI.getState().openBotSettings(bot.id)} aria-label="Bot settings" title="Bot settings">
          <Glyph name="gear" size={16} opacity={0.7} />
        </button>
        <button type="button" className="icon-btn icon-btn--bordered" onClick={() => set({ detailsOpen: false })} aria-label="Close details">
          <Icon name="close" opacity={0.92} />
        </button>
      </div>
      <div className="details__scroll">
        <div className="details__identity">
          <BotAvatarFor bot={bot} size={64} />
          <div className="details__name" title={displayName(bot)}>{displayName(bot)}</div>
        </div>
        <div className="details__tabs">
          <div className="segmented">
            <button type="button" className={tab === 'activity' ? 'is-active' : ''} onClick={() => setTab('activity')}>Activity</button>
            <button type="button" className={tab === 'tasks' ? 'is-active' : ''} onClick={() => setTab('tasks')}>Tasks</button>
            <button type="button" className={tab === 'library' ? 'is-active' : ''} onClick={() => setTab('library')}>Library</button>
          </div>
        </div>
        {tab === 'activity' ? (
          <div className="details__sections">
            <section>
              <div className="section-label section-label--row">
                <span>Upcoming</span>
                <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'routines')}>Manage</button>
              </div>
              <div className="panel-card">
                {routines?.length ? routines.map((r) => <RoutineRow key={r.id} r={r} />) : (
                  <div className="panel-empty">Nothing scheduled. Try asking in chat, for example “send me a summary every weekday at 8am”.</div>
                )}
              </div>
            </section>
            {bot.kind === 'room' && (
              <section>
                <div className="section-label">Members</div>
                <MembersCard room={bot} />
              </section>
            )}
          </div>
        ) : tab === 'tasks' ? <BotTasks bot={bot} /> : <LibraryTab bot={bot} />}
      </div>
    </aside>
  );
}
