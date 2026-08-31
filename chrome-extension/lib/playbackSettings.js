/** Gap between sentences for playback and concat save. */

export const DEFAULT_SILENCE_MS = 450;
export const MIN_SILENCE_MS = 0;
export const MAX_SILENCE_MS = 5000;

export function clampSilenceMs(n) {
  if (n == null || n === "") return DEFAULT_SILENCE_MS;
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_SILENCE_MS;
  return Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, v));
}
