export type LiveWebSpeechCallbacks = {
  onPartial?: (text: string) => void;
  onSegment?: (text: string) => void;
  onStatus?: (message: string) => void;
  onError?: (message: string) => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognition;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>;
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as SpeechRecognitionCtor) : null;
}

export class LiveWebSpeechAsrSession {
  private recognition: SpeechRecognition | null = null;
  private stopped = false;
  private lastFinal = "";

  constructor(private readonly callbacks: LiveWebSpeechCallbacks) {}

  get active() {
    return this.recognition != null && !this.stopped;
  }

  async start(): Promise<void> {
    if (this.recognition) return;
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      throw new Error("Web Speech API が利用できません");
    }
    this.stopped = false;
    this.lastFinal = "";
    const recognition = new Ctor();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      this.callbacks.onStatus?.("話しかけてください");
    };
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const piece = result[0]?.transcript?.trim() ?? "";
        if (!piece) continue;
        if (result.isFinal) {
          finalText += piece;
        } else {
          interim += piece;
        }
      }
      if (interim) {
        this.callbacks.onPartial?.(interim);
      }
      if (finalText) {
        const cleaned = finalText.trim();
        if (cleaned && cleaned !== this.lastFinal) {
          this.lastFinal = cleaned;
          this.callbacks.onPartial?.("");
          this.callbacks.onSegment?.(cleaned);
          this.callbacks.onStatus?.(`認識: ${cleaned.slice(0, 32)}${cleaned.length > 32 ? "…" : ""}`);
        }
      }
    };
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "aborted" || event.error === "no-speech") return;
      const msg = event.message || event.error;
      this.callbacks.onError?.(msg);
      this.callbacks.onStatus?.(`認識エラー: ${msg}`);
    };
    recognition.onend = () => {
      if (this.stopped) return;
      try {
        recognition.start();
      } catch {
        /* restart after auto-stop */
      }
    };
    this.recognition = recognition;
    recognition.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const recognition = this.recognition;
    this.recognition = null;
    this.callbacks.onPartial?.("");
    if (recognition) {
      recognition.onresult = null;
      recognition.onend = null;
      recognition.stop();
    }
    this.callbacks.onStatus?.("音声入力を停止しました");
  }
}
