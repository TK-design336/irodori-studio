import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, SpeakerInfo } from "../types";
import { defaultSampling, isIrodoriV4, newLineId, speakerOptionLabel } from "../types";
import { SpeakerSelect } from "./SpeakerSelect";
import { LineAudioPlayer } from "../lib/audioPlayer";
import {
  loadAudioOutputPreference,
  normalizeAudioOutputs,
  normalizeNativeAudioOutputs,
  saveAudioOutputPreference,
  type AudioOutputStatus,
  type NativeOutputDeviceInfo,
} from "../lib/audioOutput";
import {
  liveMaxChars,
  liveTextSegments,
  synthesizeLiveSegment,
  deleteLiveWav,
} from "../lib/liveSynthesis";
import {
  buildLiveSampling,
  loadLiveHistory,
  loadLivePrefs,
  saveLiveHistory,
  saveLivePrefs,
  MAX_HISTORY,
  type LiveAsrEngine,
  type LiveEnterKeyMode,
  type LiveHistoryItem,
  type LiveItemStatus,
  type LivePrefs,
  type LiveQualityPreset,
} from "../lib/liveStorage";
import { LiveMicAsrSession, listNativeMicInputDevices, preloadLiveNativeAsr } from "../lib/liveMicAsr";

type Props = {
  speakers: SpeakerInfo[];
  settings: AppSettings;
};

const STATUS_LABEL: Record<LiveItemStatus, string> = {
  queued: "待機中",
  synthesizing: "生成中",
  playing: "再生中",
  done: "完了",
  error: "エラー",
  cancelled: "中止",
};

const QUALITY_LABEL: Record<LiveQualityPreset, string> = {
  fast: "高速（25 steps）",
  standard: "標準（40 steps）",
  quality: "高品質（50 steps）",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

type LiveReadySegment = {
  gen: number;
  itemId: string;
  text: string;
  index: number;
  last: boolean;
  path?: string;
  error?: string;
};

function ParamSlider({
  label,
  hint,
  min,
  max,
  step,
  value,
  onChange,
  onReset,
  altered,
}: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  onReset: () => void;
  altered?: boolean;
}) {
  return (
    <label className={`param-field${altered ? " is-speed-altered" : ""}`}>
      <span className="param-label">{label}</span>
      {hint ? <span className="param-hint">{hint}</span> : null}
      <div className="param-controls">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button type="button" className="icon-btn" title="リセット" onClick={onReset}>
          ↺
        </button>
      </div>
    </label>
  );
}

export function LiveView({ speakers, settings }: Props) {
  const [prefs, setPrefs] = useState<LivePrefs>(() => loadLivePrefs());
  const [history, setHistory] = useState<LiveHistoryItem[]>(() => loadLiveHistory());
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");
  const [outputDevices, setOutputDevices] = useState<
    Array<{ deviceId: string; label: string }>
  >([{ deviceId: "", label: "システム既定" }]);
  const [outputDeviceId, setOutputDeviceId] = useState(
    () => loadAudioOutputPreference().deviceId,
  );
  const [outputStatus, setOutputStatus] = useState<AudioOutputStatus>("ready");
  const [configCollapsed, setConfigCollapsed] = useState(false);
  const [playbackCollapsed, setPlaybackCollapsed] = useState(false);
  const [micInputDevices, setMicInputDevices] = useState<
    Array<{ deviceId: string; label: string }>
  >([]);
  const [micListening, setMicListening] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micPartial, setMicPartial] = useState("");
  const [micStatus, setMicStatus] = useState("");

  const historyRef = useRef(history);
  const queueRef = useRef<string[]>([]);
  const pendingRef = useRef<Map<string, LiveHistoryItem>>(new Map());
  const synthesizedRef = useRef<Set<string>>(new Set());
  const readySegsRef = useRef<LiveReadySegment[]>([]);
  const segWaitersRef = useRef<Array<() => void>>([]);
  const synthRunningRef = useRef(false);
  const playRunningRef = useRef(false);
  const synthPumpRef = useRef<() => void>(() => {});
  const playPumpRef = useRef<() => void>(() => {});
  const micPausedForQueueRef = useRef(false);
  const generationRef = useRef(0);
  const micSessionRef = useRef<LiveMicAsrSession | null>(null);
  const enqueueItemRef = useRef<
    (partial: Pick<LiveHistoryItem, "text" | "speakerEmbedPath" | "caption" | "sampling">) => boolean
  >(() => false);
  const speakersRef = useRef(speakers);
  const settingsRef = useRef(settings);
  const prefsRef = useRef(prefs);
  const historyListRef = useRef<HTMLUListElement | null>(null);
  const playerRef = useRef<LineAudioPlayer | null>(null);

  useEffect(() => {
    historyRef.current = history;
    saveLiveHistory(history);
  }, [history]);

  useEffect(() => {
    prefsRef.current = prefs;
    saveLivePrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    speakersRef.current = speakers;
  }, [speakers]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!playerRef.current) {
      const player = new LineAudioPlayer({ onChange: () => {} });
      player.enableNativeOutput();
      playerRef.current = player;
    }
    return () => {
      playerRef.current?.stop(true);
    };
  }, []);

  const refreshOutputDevices = useCallback(async () => {
    setOutputStatus((s) => (s === "switching" ? "switching" : "requesting"));
    try {
      const native = await invoke<NativeOutputDeviceInfo[]>("native_audio_list_outputs");
      const normalized = normalizeNativeAudioOutputs(native);
      const pref = loadAudioOutputPreference();
      setOutputDevices(normalized);
      if (pref.deviceId && !normalized.some((d) => d.deviceId === pref.deviceId)) {
        setOutputDeviceId("");
      }
      setOutputStatus("ready");
      return;
    } catch {
      /* fall through to Web Audio enumeration */
    }
    if (!navigator.mediaDevices?.enumerateDevices) {
      setOutputDevices(normalizeAudioOutputs());
      setOutputStatus("unsupported");
      return;
    }
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      const hasLabels = devices.some((d) => d.kind === "audiooutput" && d.label);
      if (!hasLabels && navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
        } catch {
          setOutputStatus("locked-default");
        }
      }
      const pref = loadAudioOutputPreference();
      const normalized = normalizeAudioOutputs(
        devices,
        pref.deviceId
          ? ({ deviceId: pref.deviceId, kind: "audiooutput", label: pref.label } as MediaDeviceInfo)
          : null,
      );
      setOutputDevices(normalized);
      setOutputStatus((s) => (s === "locked-default" ? "locked-default" : "ready"));
    } catch {
      setOutputDevices(normalizeAudioOutputs());
      setOutputStatus("locked-default");
    }
  }, []);

  useEffect(() => {
    void refreshOutputDevices();
    const onChange = () => void refreshOutputDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
  }, [refreshOutputDevices]);

  const refreshMicInputs = useCallback(async () => {
    try {
      if (prefsRef.current.asrEngine === "native") {
        setMicInputDevices(await listNativeMicInputDevices());
        return;
      }
    } catch {
      /* fall through */
    }
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMicInputDevices([{ deviceId: "", label: "システム既定" }]);
      return;
    }
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      const hasLabels = devices.some((d) => d.kind === "audioinput" && d.label);
      if (!hasLabels && navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
        } catch {
          /* labels unavailable */
        }
      }
      const out = [{ deviceId: "", label: "システム既定" }];
      const seen = new Set<string>([""]);
      for (const device of devices) {
        if (device.kind !== "audioinput" || !device.deviceId || seen.has(device.deviceId)) {
          continue;
        }
        seen.add(device.deviceId);
        out.push({
          deviceId: device.deviceId,
          label: device.label?.trim() || `マイク ${out.length}`,
        });
      }
      setMicInputDevices(out);
    } catch {
      setMicInputDevices([{ deviceId: "", label: "システム既定" }]);
    }
  }, []);

  useEffect(() => {
    void preloadLiveNativeAsr();
  }, []);

  useEffect(() => {
    void refreshMicInputs();
  }, [prefs.asrEngine, refreshMicInputs]);

  useEffect(() => {
    return () => {
      void micSessionRef.current?.stop();
      micSessionRef.current = null;
    };
  }, []);

  const applyOutputDevice = useCallback(async (deviceId: string, label: string) => {
    setOutputDeviceId(deviceId);
    saveAudioOutputPreference({ deviceId, label: label || "システム既定" });
    const player = playerRef.current;
    if (!player) return;
    setOutputStatus("switching");
    try {
      const ok = await player.setOutputDevice(deviceId);
      setOutputStatus(ok ? "ready" : "unsupported");
    } catch {
      setOutputStatus("locked-default");
    }
  }, []);

  useEffect(() => {
    void applyOutputDevice(outputDeviceId, loadAudioOutputPreference().label);
  }, [applyOutputDevice, outputDeviceId]);

  const updateItem = useCallback((id: string, patch: Partial<LiveHistoryItem>) => {
    setHistory((prev) => {
      const next = prev.map((item) => (item.id === id ? { ...item, ...patch } : item));
      historyRef.current = next;
      return next;
    });
  }, []);

  const sampling = useMemo(() => buildLiveSampling(prefs), [prefs]);

  const notifySeg = useCallback(() => {
    const waiters = segWaitersRef.current.splice(0);
    waiters.forEach((w) => w());
  }, []);

  const waitForSeg = useCallback(() => {
    if (readySegsRef.current.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      segWaitersRef.current.push(resolve);
    });
  }, []);

  const discardReadySegs = useCallback(async () => {
    const segs = readySegsRef.current.splice(0);
    notifySeg();
    await Promise.all(segs.map((seg) => deleteLiveWav(seg.path)));
  }, [notifySeg]);

  const pushReadySeg = useCallback(
    (seg: LiveReadySegment) => {
      if (seg.gen !== generationRef.current) {
        void deleteLiveWav(seg.path);
        return;
      }
      readySegsRef.current.push(seg);
      notifySeg();
    },
    [notifySeg],
  );

  const dropReadyForItem = useCallback(async (itemId: string) => {
    const keep: LiveReadySegment[] = [];
    const drop: LiveReadySegment[] = [];
    for (const seg of readySegsRef.current) {
      if (seg.itemId === itemId) drop.push(seg);
      else keep.push(seg);
    }
    readySegsRef.current = keep;
    await Promise.all(drop.map((seg) => deleteLiveWav(seg.path)));
  }, []);

  const kickPumps = useCallback(() => {
    void synthPumpRef.current();
    void playPumpRef.current();
  }, []);

  const synthesizeItem = useCallback(
    async (item: LiveHistoryItem, gen: number) => {
      const isActive = () => gen === generationRef.current;
      updateItem(item.id, { status: "synthesizing" });
      if (!playRunningRef.current) {
        setStatus(`生成中…「${item.text.slice(0, 20)}」`);
      }

      const segments = liveTextSegments(item.text, liveMaxChars(settingsRef.current));
      if (segments.length === 0) {
        pushReadySeg({
          gen,
          itemId: item.id,
          text: item.text,
          index: 0,
          last: true,
          error: "テキストが空です",
        });
        return;
      }

      const speed = prefsRef.current.speed;
      for (let index = 0; index < segments.length; index += 1) {
        if (!isActive()) throw new Error("cancelled");
        try {
          const path = await synthesizeLiveSegment({
            text: segments[index],
            itemId: item.id,
            segmentIndex: index,
            speakerEmbedPath: item.speakerEmbedPath,
            speakers: speakersRef.current,
            sampling: item.sampling,
            settings: settingsRef.current,
            caption: item.caption,
            speed,
            isActive,
          });
          pushReadySeg({
            gen,
            itemId: item.id,
            text: item.text,
            index,
            last: index === segments.length - 1,
            path,
          });
        } catch (e) {
          const msg = String(e);
          pushReadySeg({
            gen,
            itemId: item.id,
            text: item.text,
            index,
            last: true,
            error: msg === "cancelled" ? "cancelled" : msg,
          });
          return;
        }
      }
    },
    [pushReadySeg, updateItem],
  );

  const synthPump = useCallback(async () => {
    if (synthRunningRef.current) return;
    synthRunningRef.current = true;
    const gen = generationRef.current;
    try {
      await invoke("ensure_worker");
      while (gen === generationRef.current) {
        const id = queueRef.current.find((qid) => !synthesizedRef.current.has(qid));
        if (!id) break;
        const item =
          pendingRef.current.get(id) ?? historyRef.current.find((x) => x.id === id);
        if (!item) {
          synthesizedRef.current.add(id);
          continue;
        }
        try {
          await synthesizeItem(item, gen);
        } catch (e) {
          const msg = String(e);
          if (gen === generationRef.current && msg !== "cancelled") {
            pushReadySeg({
              gen,
              itemId: item.id,
              text: item.text,
              index: 0,
              last: true,
              error: msg,
            });
          }
        }
        if (gen === generationRef.current) {
          synthesizedRef.current.add(id);
        }
      }
    } finally {
      synthRunningRef.current = false;
      notifySeg();
      if (
        gen === generationRef.current &&
        queueRef.current.some((id) => !synthesizedRef.current.has(id))
      ) {
        void synthPumpRef.current();
      }
    }
  }, [notifySeg, pushReadySeg, synthesizeItem]);

  const playPump = useCallback(async () => {
    if (playRunningRef.current) return;
    playRunningRef.current = true;
    const gen = generationRef.current;
    const player = playerRef.current;
    const beginMicPause = (spokenText: string) => {
      const micSession = micSessionRef.current;
      if (!micSession?.listening || micPausedForQueueRef.current) return;
      micSession.beginTtsPlayback(spokenText, prefsRef.current.micPauseDuringTts);
      micPausedForQueueRef.current = true;
    };
    const endMicPause = (delayMs?: number) => {
      if (!micPausedForQueueRef.current) return;
      micPausedForQueueRef.current = false;
      const micSession = micSessionRef.current;
      if (micSession?.listening) {
        micSession.endTtsPlayback(prefsRef.current.micPauseDuringTts, delayMs);
      }
    };
    try {
      if (!player) throw new Error("プレイヤーが初期化されていません");
      while (gen === generationRef.current) {
        while (readySegsRef.current.length === 0) {
          const moreSynth =
            synthRunningRef.current ||
            queueRef.current.some((id) => !synthesizedRef.current.has(id));
          if (!moreSynth) {
            endMicPause();
            if (queueRef.current.length === 0) setStatus("再生完了");
            return;
          }
          setStatus("次の発話を生成中…");
          await waitForSeg();
          if (gen !== generationRef.current) return;
        }
        const seg = readySegsRef.current.shift();
        if (!seg) continue;
        if (seg.gen !== gen) {
          await deleteLiveWav(seg.path);
          continue;
        }
        if (!queueRef.current.includes(seg.itemId)) {
          await deleteLiveWav(seg.path);
          continue;
        }

        if (seg.error) {
          const cancelled = seg.error === "cancelled" || gen !== generationRef.current;
          updateItem(seg.itemId, {
            status: cancelled ? "cancelled" : "error",
            error: cancelled ? undefined : seg.error,
          });
          if (!cancelled) setStatus(`エラー: ${seg.error}`);
          pendingRef.current.delete(seg.itemId);
          const qi = queueRef.current.indexOf(seg.itemId);
          if (qi >= 0) queueRef.current.splice(qi, 1);
          await dropReadyForItem(seg.itemId);
          continue;
        }

        if (!seg.path) {
          updateItem(seg.itemId, { status: "error", error: "生成失敗" });
          pendingRef.current.delete(seg.itemId);
          const qi = queueRef.current.indexOf(seg.itemId);
          if (qi >= 0) queueRef.current.splice(qi, 1);
          await dropReadyForItem(seg.itemId);
          continue;
        }

        beginMicPause(seg.text);
        if (seg.index === 0) {
          updateItem(seg.itemId, { status: "playing" });
        }
        setStatus(`再生中…「${seg.text.slice(0, 20)}」`);
        const volume = prefsRef.current.volume;
        try {
          await player.playFromWavPath(`${seg.itemId}:${seg.index}`, null, seg.path, volume);
          await player.waitUntilInactive();
        } catch (e) {
          await deleteLiveWav(seg.path);
          if (gen !== generationRef.current) return;
          const msg = String(e);
          updateItem(seg.itemId, { status: "error", error: msg });
          setStatus(`エラー: ${msg}`);
          pendingRef.current.delete(seg.itemId);
          const qi = queueRef.current.indexOf(seg.itemId);
          if (qi >= 0) queueRef.current.splice(qi, 1);
          await dropReadyForItem(seg.itemId);
          continue;
        }
        await deleteLiveWav(seg.path);
        if (gen !== generationRef.current) return;
        if (seg.last) {
          updateItem(seg.itemId, { status: "done", error: undefined });
          pendingRef.current.delete(seg.itemId);
          const qi = queueRef.current.indexOf(seg.itemId);
          if (qi >= 0) queueRef.current.splice(qi, 1);
        }
      }
    } catch (e) {
      if (gen === generationRef.current) {
        setStatus(`エラー: ${String(e)}`);
      }
    } finally {
      if (gen === generationRef.current) {
        const morePlay =
          readySegsRef.current.length > 0 ||
          synthRunningRef.current ||
          queueRef.current.some((id) => !synthesizedRef.current.has(id));
        if (!morePlay) endMicPause();
      }
      playRunningRef.current = false;
      if (gen === generationRef.current && queueRef.current.length > 0) {
        void playPumpRef.current();
      }
    }
  }, [dropReadyForItem, updateItem, waitForSeg]);

  useEffect(() => {
    synthPumpRef.current = () => {
      void synthPump();
    };
  }, [synthPump]);

  useEffect(() => {
    playPumpRef.current = () => {
      void playPump();
    };
  }, [playPump]);

  const resumeOrphanedQueue = useCallback(() => {
    const queued = historyRef.current.filter((item) => item.status === "queued");
    if (queued.length === 0) return;
    const byTime = [...queued].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const item of byTime) {
      pendingRef.current.set(item.id, item);
      if (!queueRef.current.includes(item.id)) {
        queueRef.current.push(item.id);
      }
    }
    kickPumps();
  }, [kickPumps]);

  useEffect(() => {
    resumeOrphanedQueue();
  }, [resumeOrphanedQueue]);

  useLayoutEffect(() => {
    const el = historyListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [history.length]);

  const enqueueItem = useCallback(
    (partial: Pick<LiveHistoryItem, "text" | "speakerEmbedPath" | "caption" | "sampling">) => {
      const text = partial.text.trim();
      if (!text) return false;
      if (!partial.speakerEmbedPath) {
        setStatus("話者を選択してください");
        return false;
      }
      const item: LiveHistoryItem = {
        id: newLineId(),
        text,
        speakerEmbedPath: partial.speakerEmbedPath,
        caption: partial.caption,
        sampling: { ...partial.sampling },
        createdAt: new Date().toISOString(),
        status: "queued",
      };
      setHistory((prev) => {
        const next = [...prev, item].slice(-MAX_HISTORY);
        historyRef.current = next;
        return next;
      });
      pendingRef.current.set(item.id, item);
      queueRef.current.push(item.id);
      setStatus(`キューに追加: ${text.slice(0, 24)}${text.length > 24 ? "…" : ""}`);
      kickPumps();
      return true;
    },
    [kickPumps],
  );

  enqueueItemRef.current = enqueueItem;

  const stopMicListening = useCallback(async () => {
    const session = micSessionRef.current;
    micSessionRef.current = null;
    setMicListening(false);
    setMicPartial("");
    if (session) await session.stop();
  }, []);

  const handleMicPhrase = useCallback(
    (text: string, isFinal: boolean) => {
      if (!isFinal) {
        setMicPartial(text);
        return;
      }
      setMicPartial("");
      if (!prefsRef.current.micAutoEnqueue) {
        setInput((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
        setMicStatus(`テキスト欄に追加: ${text.slice(0, 24)}`);
        return;
      }
      enqueueItemRef.current({
        text,
        speakerEmbedPath: prefsRef.current.speakerEmbedPath,
        caption: prefsRef.current.caption,
        sampling: buildLiveSampling(prefsRef.current),
      });
    },
    [],
  );

  const startMicListening = useCallback(async () => {
    if (micSessionRef.current?.listening) return;
    setMicPartial("");
    setMicStatus("");
    const session = new LiveMicAsrSession({
      onLevel: setMicLevel,
      onStatus: setMicStatus,
      onPartial: setMicPartial,
      onSegment: (text) => handleMicPhrase(text, true),
      onError: (msg) => setStatus(`マイク: ${msg}`),
    });
    micSessionRef.current = session;
    setMicListening(true);
    try {
      await session.start(
        prefsRef.current.asrEngine,
        prefsRef.current.micInputDeviceId,
      );
    } catch (error) {
      micSessionRef.current = null;
      setMicListening(false);
      const msg = String(error);
      setStatus(`マイク開始失敗: ${msg}`);
      setMicStatus(msg);
    }
  }, [handleMicPhrase]);

  const enqueueFromInput = useCallback(() => {
    const ok = enqueueItem({
      text: input,
      speakerEmbedPath: prefs.speakerEmbedPath,
      caption: prefs.caption,
      sampling,
    });
    if (ok) setInput("");
  }, [enqueueItem, input, prefs.caption, prefs.speakerEmbedPath, sampling]);

  const stopLive = useCallback(() => {
    generationRef.current += 1;
    queueRef.current = [];
    pendingRef.current.clear();
    synthesizedRef.current.clear();
    void discardReadySegs();
    playerRef.current?.stop(true);
    micPausedForQueueRef.current = false;
    const micSession = micSessionRef.current;
    if (micSession?.listening && prefsRef.current.micPauseDuringTts) {
      micSession.endTtsPlayback(true, 0);
    }
    setHistory((prev) => {
      const next = prev.map((item) =>
        item.status === "queued" || item.status === "synthesizing" || item.status === "playing"
          ? { ...item, status: "cancelled" as const }
          : item,
      );
      historyRef.current = next;
      return next;
    });
    setStatus("停止しました");
  }, [discardReadySegs]);

  const clearHistory = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const active = historyRef.current.some(
      (item) =>
        item.status === "queued" ||
        item.status === "synthesizing" ||
        item.status === "playing",
    );
    const msg = active
      ? "処理中の発話があります。停止して履歴をすべて削除しますか？"
      : "発話履歴をすべて削除しますか？";
    if (!window.confirm(msg)) return;
    generationRef.current += 1;
    queueRef.current = [];
    pendingRef.current.clear();
    synthesizedRef.current.clear();
    void discardReadySegs();
    playerRef.current?.stop(true);
    micPausedForQueueRef.current = false;
    const micSession = micSessionRef.current;
    if (micSession?.listening && prefsRef.current.micPauseDuringTts) {
      micSession.endTtsPlayback(true, 0);
    }
    historyRef.current = [];
    setHistory([]);
    setStatus("履歴を削除しました");
  }, [discardReadySegs]);

  const replayItem = useCallback(
    (item: LiveHistoryItem) => {
      enqueueItem({
        text: item.text,
        speakerEmbedPath: item.speakerEmbedPath,
        caption: item.caption,
        sampling: item.sampling,
      });
    },
    [enqueueItem],
  );

  useEffect(() => {
    if (prefs.speakerEmbedPath) return;
    const first = speakers[0];
    if (first) {
      setPrefs((p) => ({ ...p, speakerEmbedPath: first.embedPath }));
    }
  }, [prefs.speakerEmbedPath, speakers]);

  useEffect(() => {
    if (micListening) {
      void stopMicListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- engine change only
  }, [prefs.asrEngine]);

  const showCaption = isIrodoriV4(settings);
  const defaults = defaultSampling();
  const queueCount = history.filter(
    (item) =>
      item.status === "queued" ||
      item.status === "synthesizing" ||
      item.status === "playing",
  ).length;
  const busy = queueCount > 0;
  const outputBusy =
    outputStatus === "requesting" || outputStatus === "switching";
  const outputLocked =
    outputStatus === "locked-default" || outputStatus === "unsupported";

  const liveInputPlaceholder =
    prefs.enterKeyMode === "enter"
      ? "読み上げるテキストを入力…（Enter でキュー追加 / Shift+Enter で改行）"
      : "読み上げるテキストを入力…（Ctrl+Enter でキュー追加 / Enter で改行）";

  const handleLiveInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key !== "Enter") return;

    if (prefs.enterKeyMode === "enter") {
      if (e.shiftKey) return;
      e.preventDefault();
      enqueueFromInput();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      enqueueFromInput();
    }
  };

  return (
    <section className="panel live-view">
      <div className="live-layout">
        <aside className="params-panel live-side">
          <section
            className={`panel live-config-panel${configCollapsed ? " collapsed" : ""}`}
          >
            <header
              className="panel-header"
              onClick={() => setConfigCollapsed((v) => !v)}
            >
              <h3>音声設定</h3>
              <span className="chevron">{configCollapsed ? "▸" : "▾"}</span>
            </header>
            {!configCollapsed ? (
            <div className="panel-body">
              <label className="param-field">
                <span className="param-label">話者</span>
                <SpeakerSelect
                  speakers={speakers}
                  value={prefs.speakerEmbedPath}
                  onChange={(v) => setPrefs((p) => ({ ...p, speakerEmbedPath: v }))}
                  searchable
                  className="live-speaker-select"
                  aria-label="配信用話者"
                />
              </label>
              {showCaption ? (
                <label className="param-field">
                  <span className="param-label">キャプション</span>
                  <input
                    type="text"
                    value={prefs.caption}
                    placeholder="任意（v4 スタイル用）"
                    onChange={(e) => setPrefs((p) => ({ ...p, caption: e.target.value }))}
                  />
                </label>
              ) : null}
              <div className="live-section-label">生成</div>
              <div className="param-grid">
                <label className="param-field">
                  <span className="param-label">品質（ステップ数）</span>
                  <select
                    value={prefs.qualityPreset}
                    onChange={(e) =>
                      setPrefs((p) => ({
                        ...p,
                        qualityPreset: e.target.value as LiveQualityPreset,
                      }))
                    }
                  >
                    <option value="fast">高速（25）</option>
                    <option value="standard">標準（40）</option>
                    <option value="quality">高品質（50）</option>
                  </select>
                </label>
                <ParamSlider
                  label="長さ倍率"
                  min={0.5}
                  max={1.5}
                  step={0.01}
                  value={prefs.durationScale}
                  onChange={(durationScale) => setPrefs((p) => ({ ...p, durationScale }))}
                  onReset={() =>
                    setPrefs((p) => ({ ...p, durationScale: defaults.durationScale }))
                  }
                  altered={Math.abs(prefs.durationScale - defaults.durationScale) > 0.001}
                />
                <ParamSlider
                  label="話者強度"
                  min={0}
                  max={10}
                  step={0.1}
                  value={prefs.cfgScaleSpeaker}
                  onChange={(cfgScaleSpeaker) =>
                    setPrefs((p) => ({ ...p, cfgScaleSpeaker }))
                  }
                  onReset={() =>
                    setPrefs((p) => ({ ...p, cfgScaleSpeaker: defaults.cfgScaleSpeaker }))
                  }
                  altered={Math.abs(prefs.cfgScaleSpeaker - defaults.cfgScaleSpeaker) > 0.001}
                />
              </div>
            </div>
            ) : null}
          </section>

          <section
            className={`panel live-playback-panel${playbackCollapsed ? " collapsed" : ""}`}
          >
            <header
              className="panel-header"
              onClick={() => setPlaybackCollapsed((v) => !v)}
            >
              <h3>入出力設定</h3>
              <span className="chevron">{playbackCollapsed ? "▸" : "▾"}</span>
            </header>
            {!playbackCollapsed ? (
            <div className="panel-body">
              <div className="param-grid">
                <ParamSlider
                  label={`音量 (${prefs.volume.toFixed(2)})`}
                  min={0}
                  max={2}
                  step={0.01}
                  value={prefs.volume}
                  onChange={(volume) => {
                    setPrefs((p) => ({ ...p, volume }));
                    playerRef.current?.setVolume(volume);
                  }}
                  onReset={() => {
                    setPrefs((p) => ({ ...p, volume: 1 }));
                    playerRef.current?.setVolume(1);
                  }}
                  altered={Math.abs(prefs.volume - 1) > 0.001}
                />
                <ParamSlider
                  label={`速度 (${prefs.speed.toFixed(2)})`}
                  hint="生成後の再生速度（次の発話から反映）"
                  min={0.5}
                  max={2}
                  step={0.01}
                  value={prefs.speed}
                  onChange={(speed) => setPrefs((p) => ({ ...p, speed }))}
                  onReset={() => setPrefs((p) => ({ ...p, speed: 1 }))}
                  altered={Math.abs(prefs.speed - 1) > 0.001}
                />
                <label className="param-field">
                  <span className="param-label">出力先</span>
                  <select
                    value={outputDeviceId}
                    disabled={outputBusy || outputLocked}
                    title={
                      outputLocked
                        ? "この環境では出力デバイスを切り替えできません"
                        : undefined
                    }
                    onChange={(e) => {
                      const opt = outputDevices.find((d) => d.deviceId === e.target.value);
                      void applyOutputDevice(e.target.value, opt?.label ?? "");
                    }}
                  >
                    {outputDevices.map((device) => (
                      <option key={device.deviceId || "default"} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                  {outputLocked ? (
                    <span className="param-hint">システム既定の出力を使用します</span>
                  ) : (
                    <span className="param-hint">仮想ケーブルなど任意の再生デバイスへ直接出力します</span>
                  )}
                </label>
                <label className="param-field">
                  <span className="param-label">音声認識</span>
                  <select
                    value={prefs.asrEngine}
                    onChange={(e) =>
                      setPrefs((p) => ({
                        ...p,
                        asrEngine: e.target.value as LiveAsrEngine,
                      }))
                    }
                  >
                    <option value="native">ローカル（低遅延・推奨）</option>
                    <option value="web-speech">Web Speech API</option>
                  </select>
                  <span className="param-hint">
                    ローカルは初回のみモデル取得が必要です（数百 MB）
                  </span>
                </label>
                {prefs.asrEngine === "native" ? (
                  <label className="param-field">
                    <span className="param-label">マイク入力</span>
                    <select
                      value={prefs.micInputDeviceId}
                      disabled={micListening}
                      onChange={(e) =>
                        setPrefs((p) => ({ ...p, micInputDeviceId: e.target.value }))
                      }
                    >
                      {micInputDevices.map((device) => (
                        <option key={device.deviceId || "default"} value={device.deviceId}>
                          {device.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="param-field live-mic-auto-enqueue">
                  <span className="param-label">エコー対策</span>
                  <label className="live-checkbox-row">
                    <input
                      type="checkbox"
                      checked={prefs.micPauseDuringTts}
                      onChange={(e) =>
                        setPrefs((p) => ({ ...p, micPauseDuringTts: e.target.checked }))
                      }
                    />
                    <span>TTS 再生中は聞き取りを一時停止</span>
                  </label>
                  <span className="param-hint">
                    オフ（既定）で連続聞き取りを優先。スピーカー出力時はヘッドセット推奨
                  </span>
                </label>
                <label className="param-field">
                  <span className="param-label">送信キー</span>
                  <select
                    value={prefs.enterKeyMode}
                    onChange={(e) =>
                      setPrefs((p) => ({
                        ...p,
                        enterKeyMode: e.target.value as LiveEnterKeyMode,
                      }))
                    }
                  >
                    <option value="enter">Enter で追加（Shift+Enter で改行）</option>
                    <option value="ctrlEnter">Ctrl+Enter で追加（Enter で改行）</option>
                  </select>
                </label>
              </div>
            </div>
            ) : null}
          </section>
        </aside>

        <section className="panel live-history-panel">
          <header className="panel-header live-history-header">
            <div className="live-history-title">
              <h3>発話履歴</h3>
              <span className="hint">テキストと生成設定のみ保存（音声は再生成）</span>
            </div>
            <div className="panel-header-end live-history-header-actions">
              {busy ? (
                <span className="pill live-queue-pill">{queueCount} 件処理中</span>
              ) : (
                <span className="hint">{QUALITY_LABEL[prefs.qualityPreset]}</span>
              )}
              {history.length > 0 ? (
                <button
                  type="button"
                  className="secondary live-clear-history-btn"
                  onClick={clearHistory}
                >
                  履歴をクリア
                </button>
              ) : null}
            </div>
          </header>
          <div className="panel-body live-history-body">
            {history.length === 0 ? (
              <div className="live-history-empty">
                <p>まだ発話がありません</p>
                <p className="hint">下のマイク入力またはテキスト欄から発話を追加してください</p>
              </div>
            ) : (
              <ul ref={historyListRef} className="live-history-list">
                {history.map((item) => {
                  const sp = speakers.find((s) => s.embedPath === item.speakerEmbedPath);
                  const speakerLabel = sp ? speakerOptionLabel(sp) : "（不明）";
                  return (
                    <li key={item.id} className={`live-history-item status-${item.status}`}>
                      <div className="live-history-top">
                        <div className="live-history-meta">
                          <span className={`live-status-pill ${item.status}`}>
                            {STATUS_LABEL[item.status]}
                          </span>
                          <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
                          <span className="live-history-speaker">{speakerLabel}</span>
                          <span className="live-history-params hint">
                            ×{item.sampling.durationScale.toFixed(2)} / 話者{" "}
                            {item.sampling.cfgScaleSpeaker.toFixed(1)} / {item.sampling.numSteps}{" "}
                            steps
                          </span>
                        </div>
                        <button
                          type="button"
                          className="secondary live-replay-btn"
                          onClick={() => replayItem(item)}
                        >
                          再発話
                        </button>
                      </div>
                      <p className="live-history-text">{item.text}</p>
                      {item.error ? <p className="live-history-error">{item.error}</p> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <footer className="panel live-compose">
          <div className="panel-body">
            <div className="live-mic-panel live-mic-panel-compact">
              <div className="live-mic-toolbar">
                <span className="param-label">マイク入力</span>
                <select
                  className="live-mic-route-select"
                  value={prefs.micAutoEnqueue ? "queue" : "text"}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, micAutoEnqueue: e.target.value === "queue" }))
                  }
                >
                  <option value="queue">認識 → 自動キュー</option>
                  <option value="text">認識 → テキスト欄</option>
                </select>
                <button
                  type="button"
                  className={micListening ? "danger" : "primary"}
                  onClick={() => {
                    if (micListening) void stopMicListening();
                    else void startMicListening();
                  }}
                >
                  {micListening ? "停止" : "認識開始"}
                </button>
                <div className="live-mic-meter">
                  <div className="live-mic-level" aria-hidden>
                    <div
                      className="live-mic-level-fill"
                      style={{ width: `${Math.round(micLevel * 100)}%` }}
                    />
                  </div>
                  <div className="live-mic-feedback">
                    {micPartial ? <span className="live-mic-partial">{micPartial}</span> : null}
                    {micStatus ? <span className="live-mic-status hint">{micStatus}</span> : null}
                  </div>
                </div>
              </div>
            </div>
            <textarea
              id="live-text-input"
              className="live-text-input live-compose-field"
              rows={3}
              value={input}
              placeholder={liveInputPlaceholder}
              aria-label="読み上げるテキスト"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleLiveInputKeyDown}
            />
            <div className="live-compose-actions">
              <button type="button" className="primary" onClick={enqueueFromInput}>
                キューに追加
              </button>
              <button type="button" className="danger" onClick={stopLive} disabled={!busy}>
                停止
              </button>
              {status ? <span className="live-status-line hint">{status}</span> : null}
            </div>
          </div>
        </footer>
      </div>
    </section>
  );
}
