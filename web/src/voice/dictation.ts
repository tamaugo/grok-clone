// Composer dictation: hold the mic to talk (or tap to start, tap again to stop). Uses the browser's own
// speech recognition (no server or account needed) and hands the text back to the composer.
import { useCallback, useEffect, useRef, useState } from 'react';

export type DictationState = 'idle' | 'recording' | 'transcribing';

const HOLD_MS = 350;
const MAX_MS = 120_000;

/* Minimal typing for the Web Speech API (not in TypeScript's DOM lib). */
interface SpeechResultList { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } }
interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: SpeechResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionCtor = new () => Recognition;
const SpeechRecognitionImpl = (): RecognitionCtor | undefined =>
  (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

function speechErrorMessage(code: string): string | null {
  switch (code) {
    case 'no-speech': case 'aborted': return null;
    case 'not-allowed': case 'service-not-allowed': return 'Microphone access is blocked. Allow it in your browser’s site settings.';
    case 'audio-capture': return 'No microphone found.';
    case 'network': return 'Dictation needs an internet connection.';
    default: return 'Transcription failed';
  }
}

export function useDictation(onText: (text: string) => void, onError: (msg: string) => void, language?: string) {
  const [state, setState] = useState<DictationState>('idle');
  const rec = useRef<{ r: Recognition; text: string; downAt: number; cancelled: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const starting = useRef(false);
  const toggleMode = useRef(false);
  const cb = useRef({ onText, onError, language });
  cb.current = { onText, onError, language };

  const finish = useCallback((cancel = false) => {
    const cur = rec.current;
    if (!cur) return;
    cur.cancelled = cancel;
    clearTimeout(cur.timer);
    if (cancel) cur.r.abort();
    else { setState('transcribing'); cur.r.stop(); }
  }, []);

  const begin = useCallback(async () => {
    if (rec.current || starting.current) return;
    const Impl = SpeechRecognitionImpl();
    if (!Impl) { cb.current.onError('Dictation isn’t supported in this browser.'); return; }
    starting.current = true;
    const r = new Impl();
    r.lang = cb.current.language && cb.current.language !== 'auto' ? cb.current.language : navigator.language;
    r.continuous = true;
    r.interimResults = false;
    const cur = { r, text: '', downAt: Date.now(), cancelled: false, timer: setTimeout(() => finish(), MAX_MS) };
    rec.current = cur;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) cur.text += e.results[i][0].transcript;
    };
    r.onerror = (e) => { const msg = speechErrorMessage(e.error); if (msg) cb.current.onError(msg); };
    r.onend = () => {
      clearTimeout(cur.timer);
      rec.current = null;
      toggleMode.current = false;
      const text = cur.text.trim();
      if (!cur.cancelled && text && Date.now() - cur.downAt >= 250) cb.current.onText(text);
      setState('idle');
    };
    try {
      r.start();
      setState('recording');
    } catch (e) {
      rec.current = null;
      cb.current.onError((e as Error).message || 'Transcription failed');
      setState('idle');
    } finally {
      starting.current = false;
    }
  }, [finish]);

  // Pointer handlers: press-and-hold records until release; a quick tap toggles recording on, tap again stops.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (rec.current && toggleMode.current) { finish(); return; }
    void begin();
  }, [begin, finish]);

  const onPointerUp = useCallback(() => {
    const r = rec.current;
    if (!r) {
      // Still waiting on the permission prompt: treat as a tap.
      if (starting.current) toggleMode.current = true;
      return;
    }
    if (toggleMode.current) return;
    if (Date.now() - r.downAt < HOLD_MS) toggleMode.current = true; // tap: keep recording
    else finish();
  }, [finish]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (rec.current) finish();
    else { toggleMode.current = true; void begin(); }
  }, [begin, finish]);

  // Esc cancels; unmount stops.
  useEffect(() => {
    if (state !== 'recording') return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [state, finish]);
  useEffect(() => () => finish(true), [finish]);

  /** Keyboard shortcut (⌘D / Ctrl+D, as in Grok Bot's "Start voice input"): start, or stop if recording. */
  const toggle = useCallback(() => {
    if (rec.current) finish();
    else { toggleMode.current = true; void begin(); }
  }, [begin, finish]);

  return { state, onPointerDown, onPointerUp, onKeyDown, toggle, cancel: () => finish(true) };
}
