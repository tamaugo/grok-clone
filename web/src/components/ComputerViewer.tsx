import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { useComputer, useSelectedBot, useStore } from '../store';
import { computerStatusText } from './DetailsPanel';
import { Icon } from './Icon';

type Mode = 'watch' | 'control';
type Conn = 'connecting' | 'connected' | 'disconnected' | 'error';
interface PageState { url: string; title: string; width: number; height: number }

const BUTTONS = ['left', 'middle', 'right'] as const;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Fullscreen computer stage: a live screencast of the Bot's browser. Watch mode is view-only;
 * Take control reconnects with mode=control and sends mouse and keyboard input to the page.
 */
export function ComputerViewer() {
  const bot = useSelectedBot();
  const computer = useComputer(bot?.id);
  const set = useStore((s) => s.set);
  const imgRef = useRef<HTMLImageElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [mode, setMode] = useState<Mode>('watch');
  const [conn, setConn] = useState<Conn>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<PageState | null>(null);
  const [address, setAddress] = useState('');
  const [editingAddress, setEditingAddress] = useState(false);
  const running = computer?.status === 'running';
  const control = mode === 'control';
  const close = () => set({ viewerOpen: false });

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // In control mode Escape belongs to the page.
      if (e.key === 'Escape' && mode === 'watch') { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (!bot || !running) return;
    let disposed = false;
    let shown: string | null = null;
    setConn('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/bots/${bot.id}/screen?mode=${mode}`);
    ws.binaryType = 'blob';
    wsRef.current = ws;
    ws.onmessage = (e) => {
      if (disposed) return;
      if (typeof e.data === 'string') {
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'state') setPage({ url: m.url, title: m.title, width: m.width, height: m.height });
        } catch { /* ignore */ }
        return;
      }
      const url = URL.createObjectURL(e.data as Blob);
      const img = imgRef.current;
      if (!img) return URL.revokeObjectURL(url);
      const prev = shown;
      shown = url;
      img.src = url;
      if (prev) setTimeout(() => URL.revokeObjectURL(prev), 1000);
      setConn('connected');
    };
    ws.onclose = (e) => { if (!disposed) setConn(e.code === 1000 ? 'disconnected' : 'error'); };
    return () => {
      disposed = true;
      wsRef.current = null;
      ws.close();
      if (shown) URL.revokeObjectURL(shown);
    };
  }, [bot?.id, running, mode, attempt]);

  useEffect(() => { if (!editingAddress) setAddress(page?.url ?? ''); }, [page?.url, editingAddress]);

  const send = (msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (control && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // Mouse, wheel and keyboard on the screen image, mapped to the page's CSS pixels.
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !control) return;
    const point = (e: MouseEvent) => {
      const r = img.getBoundingClientRect();
      const w = page?.width ?? img.naturalWidth, h = page?.height ?? img.naturalHeight;
      return { x: Math.round(((e.clientX - r.left) / r.width) * w), y: Math.round(((e.clientY - r.top) / r.height) * h) };
    };
    // On a Mac, ⌘ shortcuts become Ctrl ones, since the Bot's browser runs on Linux.
    const mods = (e: MouseEvent | KeyboardEvent) => ({ alt: e.altKey, ctrl: e.ctrlKey || (IS_MAC && e.metaKey), meta: false, shift: e.shiftKey });
    let moveQueued: MouseEvent | null = null;
    const flushMove = () => {
      const e = moveQueued;
      moveQueued = null;
      if (e) send({ type: 'mouse', action: 'move', ...point(e), buttons: e.buttons, ...mods(e) });
    };
    const down = (e: MouseEvent) => {
      e.preventDefault();
      img.parentElement?.focus();
      send({ type: 'mouse', action: 'down', button: BUTTONS[e.button] ?? 'left', buttons: e.buttons, clickCount: e.detail || 1, ...point(e), ...mods(e) });
    };
    const up = (e: MouseEvent) => send({ type: 'mouse', action: 'up', button: BUTTONS[e.button] ?? 'left', buttons: e.buttons, clickCount: e.detail || 1, ...point(e), ...mods(e) });
    const move = (e: MouseEvent) => { if (!moveQueued) requestAnimationFrame(flushMove); moveQueued = e; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      send({ type: 'wheel', ...point(e), deltaX: e.deltaX * scale, deltaY: e.deltaY * scale, ...mods(e) });
    };
    const menu = (e: MouseEvent) => e.preventDefault();
    img.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    img.addEventListener('mousemove', move);
    img.addEventListener('wheel', wheel, { passive: false });
    img.addEventListener('contextmenu', menu);
    return () => {
      img.removeEventListener('mousedown', down);
      window.removeEventListener('mouseup', up);
      img.removeEventListener('mousemove', move);
      img.removeEventListener('wheel', wheel);
      img.removeEventListener('contextmenu', menu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control, page?.width, page?.height, conn]);

  const onKey = (e: React.KeyboardEvent, action: 'down' | 'up') => {
    if (!control) return;
    const shortcut = e.ctrlKey || (IS_MAC && e.metaKey);
    // Let the browser fire a paste event so we can send the clipboard text instead.
    if (shortcut && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    send({ type: 'key', action, key: e.key, code: e.code, keyCode: e.keyCode, alt: e.altKey, ctrl: shortcut, shift: e.shiftKey });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (!control) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) send({ type: 'text', text });
  };

  const go = (e: FormEvent) => {
    e.preventDefault();
    setEditingAddress(false);
    send({ type: 'navigate', url: address });
    (document.activeElement as HTMLElement | null)?.blur();
  };

  if (!bot) return null;
  const busy = computer?.status === 'starting' || computer?.status === 'resuming' || computer?.status === 'creating';

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`${bot.name}'s computer`} style={botVars(bot.avatarColor)}>
      <div className="viewer__scrim" onClick={mode === 'watch' ? close : undefined} />
      <div className="viewer__top">
        <div className="viewer__title">
          <BotAvatarFor bot={bot} size={24} />
          <span>{bot.name}'s computer</span>
          <span className="viewer__status">{computerStatusText(computer)}</span>
        </div>
        <button type="button" className="viewer__close" onClick={close} aria-label="Close computer"><Icon name="close" color="#FFFFFF" /></button>
      </div>

      <div className="viewer__stage">
        {running ? (
          <div className={`viewer__window${control ? ' is-control' : ''}`}>
            <form className="viewer__toolbar" onSubmit={go}>
              <button type="button" className="viewer__nav" disabled={!control} onClick={() => send({ type: 'history', delta: -1 })} aria-label="Back">‹</button>
              <button type="button" className="viewer__nav" disabled={!control} onClick={() => send({ type: 'history', delta: 1 })} aria-label="Forward">›</button>
              <button type="button" className="viewer__nav viewer__nav--reload" disabled={!control} onClick={() => send({ type: 'reload' })} aria-label="Reload">↻</button>
              <input
                className="viewer__address"
                value={address}
                readOnly={!control}
                placeholder={page?.title || 'Search or enter an address'}
                title={page?.title}
                onFocus={(e) => { if (control) { setEditingAddress(true); e.currentTarget.select(); } }}
                onBlur={() => setEditingAddress(false)}
                onChange={(e) => setAddress(e.target.value)}
                aria-label="Address"
                spellCheck={false}
              />
            </form>
            <div
              className="viewer__screen"
              tabIndex={control ? 0 : -1}
              onKeyDown={(e) => onKey(e, 'down')}
              onKeyUp={(e) => onKey(e, 'up')}
              onPaste={onPaste}
              style={{ aspectRatio: `${page?.width ?? 1280} / ${page?.height ?? 800}` }}
            >
              <img ref={imgRef} alt="" draggable={false} />
              {conn !== 'connected' && (
                <div className="viewer__overlay">
                  {conn === 'connecting' ? 'Connecting to the computer…' : (
                    <>
                      <span>{conn === 'error' ? 'Couldn’t reach the computer.' : 'Disconnected.'}</span>
                      <button type="button" className="btn btn--light" onClick={() => setAttempt((n) => n + 1)}>Reconnect</button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="viewer__overlay viewer__overlay--asleep">
            <span className="viewer__sleep-face"><i /><i /></span>
            <span>{busy ? computerStatusText(computer) : 'The computer is asleep.'}</span>
            {!busy && <button type="button" className="btn btn--light" onClick={() => useStore.getState().wakeComputer(bot.id)}>Wake computer</button>}
            {computer?.error && <span className="viewer__err">{computer.error}</span>}
          </div>
        )}
      </div>

      {running && (
        <div className={`viewer__bar${control ? ' is-control' : ''}`}>
          {mode === 'watch' ? (
            <>
              <span className="viewer__bar-text"><b>Watching</b> · Take control to use the mouse and keyboard</span>
              <button type="button" className="btn btn--light" onClick={() => setMode('control')}>Take control</button>
            </>
          ) : (
            <>
              <span className="viewer__bar-text"><span className="viewer__live-dot" /> <b>You're in control</b></span>
              <button type="button" className="btn btn--light" onClick={() => setMode('watch')}>I'm done</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
