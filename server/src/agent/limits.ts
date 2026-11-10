/**
 * Claude usage limits. When a turn ends because the subscription limit was hit, the Bot
 * waits for the reset and tries the same turn again (see loop.ts).
 */

/** Does this Claude error text mean a usage or rate limit (not some other failure)? */
export const isUsageLimit = (text: string) => /usage limit|limit reached|hit your limit|rate.?limit|quota|too many requests|overloaded/i.test(text);

/** Used when the message doesn't say when the limit resets. */
export const DEFAULT_RETRY_MS = 30 * 60_000;
/** Cap, so a mis-parsed time can't park a Bot for days. */
const MAX_RETRY_MS = 6 * 3600_000;

/** Wall-clock parts of an instant in a time zone (or the server's, if tz is undefined). */
function partsIn(ms: number, tz?: string): { h: number; m: number } {
  const f = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: tz });
  const p = f.formatToParts(new Date(ms));
  return { h: Number(p.find((x) => x.type === 'hour')?.value) % 24, m: Number(p.find((x) => x.type === 'minute')?.value) };
}

/**
 * When does the limit reset? Understands the two shapes Claude Code prints:
 * "...usage limit reached|1760000000" (epoch seconds) and "...resets 3pm (America/New_York)".
 * Returns an epoch in ms, or null if the text doesn't say.
 */
export function parseLimitReset(text: string, nowMs: number): number | null {
  const epoch = text.match(/\|\s*(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;

  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|UTC)\))?/i);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  const ap = clock[3]?.toLowerCase();
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const tz = clock[4];
  try {
    // Walk forward minute by minute (at most a day) to the next time the clock reads hour:minute.
    const start = Math.floor(nowMs / 60_000) * 60_000;
    for (let i = 1; i <= 24 * 60 + 1; i++) {
      const t = start + i * 60_000;
      const p = partsIn(t, tz);
      if (p.h === hour && p.m === minute) return t;
    }
  } catch { /* unknown time zone */ }
  return null;
}

/** How long to wait before retrying: until the reset (plus a minute of slack), within sane bounds. */
export function retryDelayMs(text: string, nowMs = Date.now()): number {
  const reset = parseLimitReset(text, nowMs);
  if (reset === null) return DEFAULT_RETRY_MS;
  return Math.min(MAX_RETRY_MS, Math.max(60_000, reset - nowMs + 60_000));
}

/** "3:05 PM" in the server's time zone, for the notice shown in chat. */
export const formatClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
