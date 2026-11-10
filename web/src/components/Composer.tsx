import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attachment, Bot } from '@shared/types';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { useDictation } from '../voice/dictation';
import { Icon } from './Icon';
import { Menu } from './Menu';

const MAX_H = 200;
const drafts = new Map<string, string>();

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 10;

/** An image waiting in the composer: previewed locally while it uploads. */
interface Pending { key: string; url: string; att: Attachment | null }
let pendingKey = 0;

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const [text, setText] = useState(() => drafts.get(bot.id) ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [images, setImages] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<Pending[]>([]);
  imagesRef.current = images;
  const setModal = useStore((s) => s.setModal);

  // Per-bot drafts. Pending images belong to the chat they were pasted into.
  useEffect(() => { setText(drafts.get(bot.id) ?? ''); setError(null); ref.current?.focus(); }, [bot.id]);
  useEffect(() => () => { for (const p of imagesRef.current) URL.revokeObjectURL(p.url); setImages([]); }, [bot.id]);

  const removeImage = (key: string) => setImages((cur) => {
    const p = cur.find((x) => x.key === key);
    if (p) URL.revokeObjectURL(p.url);
    return cur.filter((x) => x.key !== key);
  });

  const addImages = (files: File[]) => {
    const botId = bot.id;
    let room = MAX_IMAGES - imagesRef.current.length;
    for (const f of files) {
      if (!IMAGE_TYPES.includes(f.type)) { setError('Only PNG, JPEG, GIF or WebP images can be attached.'); continue; }
      if (f.size > MAX_IMAGE_BYTES) { setError(`${f.name || 'That image'} is over 10 MB.`); continue; }
      if (room-- <= 0) { setError(`At most ${MAX_IMAGES} images per message.`); break; }
      const p: Pending = { key: `img${++pendingKey}`, url: URL.createObjectURL(f), att: null };
      setImages((cur) => [...cur, p]);
      api.upload(botId, f).then(
        (att) => setImages((cur) => cur.map((x) => (x.key === p.key ? { ...x, att } : x))),
        (e) => { setError((e as Error).message || 'Image failed to upload'); removeImage(p.key); },
      );
    }
  };

  const imageFiles = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }, [text]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const uploading = images.some((p) => !p.att);
  const send = async () => {
    const t = text.trim();
    if ((!t && !images.length) || sending || uploading) return;
    setSending(true); setError(null);
    try {
      await api.send(bot.id, t, images.map((p) => p.att!.name));
      setText('');
      drafts.delete(bot.id);
      for (const p of images) URL.revokeObjectURL(p.url);
      setImages([]);
    } catch (e) {
      setError((e as Error).message || 'Message failed to send');
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const stop = () => api.interrupt(bot.id).catch((e) => setError(e.message));
  const fresh = () => api.fresh(bot.id).catch((e) => setError(e.message));

  // Dictation: insert the transcript at the cursor.
  const insertText = (t: string) => {
    const el = ref.current;
    setText((cur) => {
      const start = el && document.activeElement === el ? el.selectionStart : cur.length;
      const end = el && document.activeElement === el ? el.selectionEnd : cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el) { const pos = before.length + pre.length + t.length; el.focus(); el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  const dictation = useDictation(insertText, setError);

  // ⌘D / Ctrl+D starts or stops voice input.
  const toggleDictation = dictation.toggle;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); toggleDictation(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [toggleDictation]);

  const hasText = text.trim().length > 0;
  const canSend = (hasText || images.length > 0) && !uploading && !sending;
  const multiline = text.includes('\n') || (ref.current?.scrollHeight ?? 0) > 30;

  return (
    <div
      className={`composer-area${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(false);
        const files = imageFiles(e.dataTransfer.files);
        if (files.length) addImages(files);
        else setError('Only images can be attached.');
      }}
    >
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      <div className={`composer${multiline ? ' is-multiline' : ''}${images.length ? ' has-attachments' : ''}`}>
        {images.length > 0 && (
          <div className="composer__attachments">
            {images.map((p) => (
              <div key={p.key} className={`composer__thumb${p.att ? '' : ' is-uploading'}`}>
                <img src={p.url} alt="Attached image" />
                <button type="button" className="composer__thumb-x" onClick={() => removeImage(p.key)} aria-label="Remove image" title="Remove">
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer__left">
          <span className="composer__plus-anchor">
            <button type="button" className="composer__btn" onClick={() => setMenu(!menu)} aria-label="More actions" aria-expanded={menu}>
              <Icon name="composer_plus" opacity={0.56} />
            </button>
            {menu && (
              <Menu
                placement="above"
                onClose={() => setMenu(false)}
                items={[
                  { label: 'Attach image', onSelect: () => fileRef.current?.click() },
                  { label: 'New conversation', onSelect: fresh },
                  { label: 'Connect apps', onSelect: () => setModal('apps') },
                ]}
              />
            )}
          </span>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            multiple
            hidden
            onChange={(e) => { addImages(imageFiles(e.target.files)); e.target.value = ''; }}
          />
          <textarea
            ref={ref}
            className="composer__input"
            rows={1}
            value={text}
            placeholder={`Message ${displayName(bot)}`}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              // A screenshot arrives as a file. If the clipboard also has plain text (e.g. copied
              // from Word or Excel), paste the text as usual instead.
              const files = imageFiles(e.clipboardData.files);
              if (!files.length || e.clipboardData.getData('text/plain')) return;
              e.preventDefault();
              addImages(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            aria-label={`Message ${bot.name}`}
          />
        </div>
        <div className="composer__right">
          <button
            type="button"
            className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.state === 'recording' ? 'Release or click to stop · Esc cancels' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Hold to dictate, or click to start'}
            disabled={dictation.state === 'transcribing'}
            onPointerDown={dictation.onPointerDown}
            onPointerUp={dictation.onPointerUp}
            onKeyDown={dictation.onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="mic" opacity={0.56} />
          </button>
          {running && !hasText && !images.length ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__cta"
              onClick={send}
              disabled={!canSend}
              aria-label="Send"
              title="Send (Enter)"
            >
              <Icon name="arrow_up" size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
