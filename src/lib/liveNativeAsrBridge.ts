import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type LiveAsrPhraseMeta = {
  isFinal: boolean;
};

export type LiveAsrPhraseListener = (text: string, meta: LiveAsrPhraseMeta) => void;
export type LiveAsrLevelListener = (level: number) => void;

const bridge = {
  phraseUnlisten: null as UnlistenFn | null,
  levelUnlisten: null as UnlistenFn | null,
  phraseListener: null as LiveAsrPhraseListener | null,
  levelListener: null as LiveAsrLevelListener | null,
  phrasePromise: null as Promise<void> | null,
  levelPromise: null as Promise<void> | null,
};

export function setLiveAsrPhraseListener(listener: LiveAsrPhraseListener | null): void {
  bridge.phraseListener = listener;
}

export function setLiveAsrLevelListener(listener: LiveAsrLevelListener | null): void {
  bridge.levelListener = listener;
}

export async function ensureLiveAsrEventListeners(): Promise<void> {
  if (!bridge.phraseUnlisten && !bridge.phrasePromise) {
    bridge.phrasePromise = (async () => {
      bridge.phraseUnlisten = await listen<{ text: string; is_final: boolean }>(
        "irodori-asr-phrase",
        (event) => {
          const handler = bridge.phraseListener;
          if (!handler) return;
          const text = (event.payload.text ?? "").trim();
          if (!text) return;
          handler(text, { isFinal: event.payload.is_final !== false });
        },
      );
    })();
    await bridge.phrasePromise;
    bridge.phrasePromise = null;
  } else if (bridge.phrasePromise) {
    await bridge.phrasePromise;
  }

  if (!bridge.levelUnlisten && !bridge.levelPromise) {
    bridge.levelPromise = (async () => {
      bridge.levelUnlisten = await listen<number>("irodori-asr-input-level", (event) => {
        const handler = bridge.levelListener;
        if (!handler) return;
        handler(typeof event.payload === "number" ? event.payload : 0);
      });
    })();
    await bridge.levelPromise;
    bridge.levelPromise = null;
  } else if (bridge.levelPromise) {
    await bridge.levelPromise;
  }
}
