import { LiveMicAsrSession, type LiveMicAsrCallbacks } from "./liveMicAsr";
import { loadLivePrefs } from "./liveStorage";

export type LineDictationHandle = {
  token: number;
};

type StolenListener = (token: number) => void;

let tokenSeq = 0;
let session: LiveMicAsrSession | null = null;
let activeToken = 0;
let onStolen: StolenListener | null = null;

export async function startLineDictation(
  callbacks: LiveMicAsrCallbacks,
  stolen?: StolenListener,
): Promise<LineDictationHandle> {
  const prev = session;
  const prevToken = activeToken;
  const prevStolen = onStolen;
  session = null;
  activeToken = 0;
  onStolen = null;
  if (prev) {
    prevStolen?.(prevToken);
    await prev.stop();
  }

  const token = ++tokenSeq;
  const next = new LiveMicAsrSession(callbacks);
  session = next;
  activeToken = token;
  onStolen = stolen ?? null;

  const prefs = loadLivePrefs();
  try {
    await next.start(prefs.asrEngine, prefs.micInputDeviceId);
    if (session !== next) {
      return { token: 0 };
    }
    return { token };
  } catch (error) {
    if (session === next) {
      session = null;
      activeToken = 0;
      onStolen = null;
    }
    throw error;
  }
}

export async function stopLineDictation(token?: number): Promise<void> {
  if (token != null && token !== activeToken) return;
  const current = session;
  session = null;
  activeToken = 0;
  onStolen = null;
  if (current) await current.stop();
}
