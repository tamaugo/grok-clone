import type { BotEffort, BotModel } from '@shared/types';

/** Models offered when creating a Bot and in its settings, in picker order. */
export const MODELS: { value: BotModel; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-fable-5-2', label: 'Fable 5.2' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
];

export const MODEL_HINT: Record<BotModel, string> = {
  default: 'Uses the default model of your Claude account.',
  'claude-haiku-5-5': 'The quickest replies, and the lightest on your Claude limit.',
  'claude-sonnet-5-5': 'Fast and capable. A good fit for everyday work.',
  'claude-opus-5-5': 'The most capable. Good for complex, multi-step work. Uses your Claude limit the fastest.',
  'claude-fable-5-2': 'The newest and most capable Claude model. Uses your Claude limit the fastest.',
  'claude-sonnet-4-6': 'The previous Sonnet. Use it if a task worked better on it.',
};

/** Thinking levels, in picker order. */
export const EFFORTS: { value: BotEffort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

export const EFFORT_HINT: Record<BotEffort, string> = {
  low: 'Fastest replies. Good for quick lookups and chit-chat.',
  medium: 'A good balance for most work.',
  high: 'Thinks longer before acting. Better for tricky, multi-step work.',
  xhigh: 'Thinks much longer. For hard problems where speed matters less.',
  max: 'Thinks the longest. Slowest, and uses your Claude limit the fastest.',
};
