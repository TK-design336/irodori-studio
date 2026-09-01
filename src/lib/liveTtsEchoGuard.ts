/** TTS 終了後、スピーカー残響を拾わないよう ASR 再開を遅らせる時間（キャプチャ継続時） */
export const POST_TTS_ASR_RESUME_DELAY_MS = 1400;

/** 再生中にキャプチャを止めていた場合の再開待ち（パイプラインは維持したまま） */
export const POST_TTS_ASR_PAUSE_RESUME_DELAY_MS = 60;

/** Web Speech は stop/start になるため、わずかな余韻待ちを残す */
export const POST_TTS_WEB_SPEECH_RESUME_DELAY_MS = 200;

export function nextTtsEchoGuardUntil(currentUntil: number, delayMs: number): number {
  return Math.max(currentUntil, Date.now() + delayMs);
}

export function waitUntilTtsEchoGuardInactive(
  isGuardActive: () => boolean,
  getGuardUntilMs: () => number,
): Promise<void> {
  return new Promise((resolve) => {
    const step = () => {
      if (!isGuardActive()) {
        resolve();
        return;
      }
      const ms = Math.max(16, getGuardUntilMs() - Date.now());
      window.setTimeout(step, ms);
    };
    step();
  });
}

function normalizeTtsEchoText(s: string): string {
  return s.trim().replace(/[。．.!?！？…‥、,\s　]+/g, "").toLowerCase();
}

/** 直近の TTS 読み上げ文と一致する ASR 断片（スピーカーエコー）か */
export function isTtsAsrEchoPiece(piece: string, recentSpokenText: string): boolean {
  const p = normalizeTtsEchoText(piece);
  if (p.length < 5) return false;
  const recent = normalizeTtsEchoText(recentSpokenText);
  if (!recent) return false;
  if (recent.includes(p)) return true;
  const tail = recent.slice(-Math.min(recent.length, Math.max(p.length * 2, 48)));
  return tail.includes(p);
}

export function appendTtsSpokenText(accumulator: string, sentence: string | null | undefined): string {
  if (!sentence?.trim()) return accumulator;
  return accumulator + sentence;
}
