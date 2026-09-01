import { invoke } from "@tauri-apps/api/core";
import {
  ensureLiveAsrEventListeners,
  setLiveAsrLevelListener,
  setLiveAsrPhraseListener,
} from "./liveNativeAsrBridge";
import {
  ensureNativeAsrModels,
  preloadNativeAsr,
  syncNativeAsrConfig,
} from "./liveNativeAsrConfig";
import {
  appendTtsSpokenText,
  isTtsAsrEchoPiece,
  nextTtsEchoGuardUntil,
  POST_TTS_ASR_RESUME_DELAY_MS,
  waitUntilTtsEchoGuardInactive,
} from "./liveTtsEchoGuard";
import { LiveWebSpeechAsrSession } from "./liveWebSpeechAsr";

export type LiveMicAsrEngine = "native" | "web-speech";

export type LiveMicAsrCallbacks = {
  onLevel?: (level: number) => void;
  onStatus?: (message: string) => void;
  onPartial?: (text: string) => void;
  onSegment?: (text: string) => void;
  onError?: (message: string) => void;
};

export class LiveMicAsrSession {
  private nativeActive = false;
  private webSession: LiveWebSpeechAsrSession | null = null;
  private captureWanted = false;
  private engine: LiveMicAsrEngine = "native";
  private deviceId = "";
  private echoResumeUntil = 0;
  private echoTextFilterUntil = 0;
  private recentSpokenText = "";
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private pausedForPlayback = false;

  constructor(private readonly callbacks: LiveMicAsrCallbacks) {}

  get listening() {
    return this.captureWanted;
  }

  get capturing() {
    return this.nativeActive || Boolean(this.webSession?.active);
  }

  get active() {
    return this.capturing;
  }

  private isEchoTextFilterActive(): boolean {
    return Date.now() < this.echoTextFilterUntil;
  }

  private clearResumeTimer() {
    if (this.resumeTimer != null) {
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private noteSpokenText(spokenText?: string) {
    if (spokenText) {
      this.recentSpokenText = appendTtsSpokenText(this.recentSpokenText, spokenText);
    }
  }

  private bindNativeListeners() {
    setLiveAsrPhraseListener((text, { isFinal }) => {
      if (!this.nativeActive) return;
      if (!this.acceptPhrase(text, isFinal)) return;
      if (isFinal) {
        this.callbacks.onPartial?.("");
        this.callbacks.onSegment?.(text);
      } else {
        this.callbacks.onPartial?.(text);
      }
    });
    setLiveAsrLevelListener((level) => {
      if (!this.nativeActive) return;
      this.callbacks.onLevel?.(level);
    });
  }

  private acceptPhrase(text: string, isFinal: boolean): boolean {
    if (this.pausedForPlayback) return false;
    if (
      isFinal &&
      this.isEchoTextFilterActive() &&
      isTtsAsrEchoPiece(text, this.recentSpokenText)
    ) {
      return false;
    }
    return true;
  }

  private async startCapture(): Promise<void> {
    if (this.capturing || this.pausedForPlayback) return;

    if (this.engine === "web-speech") {
      const session = new LiveWebSpeechAsrSession({
        onPartial: (t) => {
          if (!this.acceptPhrase(t, false)) return;
          this.callbacks.onPartial?.(t);
        },
        onSegment: (t) => {
          if (!this.acceptPhrase(t, true)) return;
          this.callbacks.onPartial?.("");
          this.callbacks.onSegment?.(t);
        },
        onStatus: (message) => this.callbacks.onStatus?.(message),
        onError: (message) => this.callbacks.onError?.(message),
      });
      this.webSession = session;
      await session.start();
      return;
    }

    await ensureLiveAsrEventListeners();
    this.bindNativeListeners();
    await ensureNativeAsrModels();
    await syncNativeAsrConfig(this.deviceId);
    await preloadNativeAsr();
    await invoke("native_asr_start");
    this.nativeActive = true;
    this.callbacks.onStatus?.("話しかけてください");
  }

  private async stopCapture(): Promise<void> {
    if (this.webSession) {
      await this.webSession.stop();
      this.webSession = null;
    }
    if (this.nativeActive) {
      this.nativeActive = false;
      setLiveAsrPhraseListener(null);
      setLiveAsrLevelListener(null);
      this.callbacks.onPartial?.("");
      try {
        await invoke("native_asr_stop");
      } catch (error) {
        this.callbacks.onError?.(String(error));
      }
    }
  }

  async start(engine: LiveMicAsrEngine, deviceId = ""): Promise<void> {
    if (this.captureWanted && this.capturing) return;
    this.captureWanted = true;
    this.engine = engine;
    this.deviceId = deviceId;
    this.pausedForPlayback = false;
    this.echoResumeUntil = 0;
    this.echoTextFilterUntil = 0;
    this.recentSpokenText = "";
    this.clearResumeTimer();

    try {
      if (engine === "native") {
        this.callbacks.onStatus?.("音声認識を準備しています…");
      }
      await this.startCapture();
      if (!this.captureWanted) {
        await this.stopCapture();
        return;
      }
      if (!this.capturing && this.pausedForPlayback) {
        this.callbacks.onStatus?.("再生終了後に認識を再開します…");
      }
    } catch (error) {
      this.captureWanted = false;
      setLiveAsrPhraseListener(null);
      setLiveAsrLevelListener(null);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.captureWanted = false;
    this.pausedForPlayback = false;
    this.echoResumeUntil = 0;
    this.echoTextFilterUntil = 0;
    this.recentSpokenText = "";
    this.clearResumeTimer();
    await this.stopCapture();
    this.callbacks.onStatus?.("マイク入力を停止しました");
  }

  /** TTS 再生開始。pauseCapture=false なら聞き取り継続（エコー照合のみ） */
  beginTtsPlayback(spokenText: string | undefined, pauseCapture: boolean): void {
    if (!this.captureWanted) return;
    this.noteSpokenText(spokenText);
    this.echoTextFilterUntil = nextTtsEchoGuardUntil(
      this.echoTextFilterUntil,
      POST_TTS_ASR_RESUME_DELAY_MS,
    );
    if (!pauseCapture) return;

    this.pausedForPlayback = true;
    this.clearResumeTimer();
    void this.stopCapture();
    this.callbacks.onPartial?.("");
    this.callbacks.onStatus?.("再生中のため認識を一時停止");
  }

  /** TTS 再生終了 */
  endTtsPlayback(pauseCapture: boolean, delayMs = POST_TTS_ASR_RESUME_DELAY_MS): void {
    if (!this.captureWanted) return;
    this.echoTextFilterUntil = nextTtsEchoGuardUntil(this.echoTextFilterUntil, delayMs);
    if (!pauseCapture) return;

    this.pausedForPlayback = false;
    this.echoResumeUntil = nextTtsEchoGuardUntil(this.echoResumeUntil, delayMs);
    this.clearResumeTimer();
    this.callbacks.onStatus?.("再生終了後に認識を再開します…");
    this.scheduleResume();
  }

  private scheduleResume() {
    this.clearResumeTimer();
    const run = () => {
      this.resumeTimer = null;
      if (!this.captureWanted) return;
      void waitUntilTtsEchoGuardInactive(
        () => this.pausedForPlayback || Date.now() < this.echoResumeUntil,
        () => this.echoResumeUntil,
      ).then(() => {
        if (!this.captureWanted || this.capturing) return;
        void this.startCapture().catch((error) => {
          this.callbacks.onError?.(String(error));
        });
      });
    };
    const waitMs = Math.max(16, this.echoResumeUntil - Date.now());
    this.resumeTimer = window.setTimeout(run, waitMs);
  }
}

export async function listNativeMicInputDevices(): Promise<
  Array<{ deviceId: string; label: string }>
> {
  const devices = await invoke<
    Array<{ id: string; display_name: string; host: string }>
  >("native_asr_list_devices");
  const out = [{ deviceId: "", label: "システム既定" }];
  const seen = new Set<string>([""]);
  for (const device of devices) {
    if (!device.id || seen.has(device.id)) continue;
    seen.add(device.id);
    out.push({
      deviceId: device.id,
      label: device.display_name?.trim() || `マイク ${out.length}`,
    });
  }
  return out;
}

export async function preloadLiveNativeAsr(): Promise<void> {
  try {
    await preloadNativeAsr();
  } catch {
    /* models may be missing until first download */
  }
}
