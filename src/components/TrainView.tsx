import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { BoundedSelect } from "./BoundedSelect";
import { SliceReviewView } from "./SliceReviewView";
import type {
  AppSettings,
  SliceReviewMode,
  SliceReviewSettings,
  VocalSeparatorModelInfo,
} from "../types";
import {
  activePaths,
  defaultSampling,
  DEFAULT_VOCAL_SEPARATOR_MODEL,
  isIrodoriV4,
  sliceReviewSettings,
} from "../types";

type Props = {
  settings: AppSettings;
  onSpeakersChanged: () => void;
  onRunningChange?: (running: boolean) => void;
  onSettingsChange?: (s: AppSettings) => void;
};

type TrainInputMode = "raw" | "sliced";

type TrainProgress = {
  step: number;
  total: number;
  name: string;
  fraction: number;
  detail?: string | null;
};

type TrainResumeInfo = {
  inputDir: string;
  speakerName: string;
  inputMode: string;
  jobDir: string;
  speed?: number;
  vocalSeparate?: boolean;
  vocalModel?: string;
  reviewMode?: string;
  pausedForReview?: boolean;
};

const ANNOUNCE_STORAGE_KEY = "irodori.trainAnnounceDone";
const VOCAL_SEP_STORAGE_KEY = "irodori.trainVocalSeparate";

function playReviewReadyChime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.9, now);
    master.connect(ctx.destination);

    const tone = (
      freq: number,
      start: number,
      dur: number,
      peak: number,
      type: OscillatorType = "triangle",
    ) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      g.gain.exponentialRampToValueAtTime(peak * 0.72, start + dur * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(start);
      osc.stop(start + dur + 0.04);
    };

    const ding = (start: number) => {
      tone(880, start, 0.18, 0.42, "square");
      tone(1760, start, 0.18, 0.16, "sine");
      tone(880, start + 0.22, 0.18, 0.42, "square");
      tone(1760, start + 0.22, 0.18, 0.16, "sine");
      tone(1319, start + 0.46, 0.38, 0.5, "square");
      tone(2638, start + 0.46, 0.38, 0.18, "sine");
    };
    ding(now);
    ding(now + 1.05);

    window.setTimeout(() => {
      void ctx.close();
    }, 2800);
  } catch {
    /* ignore */
  }
}
const DONE_ANNOUNCE_TEXT = "学習終了しました。この音声で問題ないですか？";

function formatEta(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `残り約 ${s}秒`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) {
    return rem > 0 ? `残り約 ${m}分${rem}秒` : `残り約 ${m}分`;
  }
  const h = Math.floor(m / 60);
  const m2 = m % 60;
  return m2 > 0 ? `残り約 ${h}時間${m2}分` : `残り約 ${h}時間`;
}

function estimateRemainingSec(
  samples: Array<{ t: number; frac: number }>,
  frac: number,
): number | null {
  if (frac >= 0.995) return 0;
  if (samples.length < 2) return null;
  const start = samples.find((s) => s.frac >= 0.02) ?? samples[0];
  const end = samples[samples.length - 1];
  const dFrac = end.frac - start.frac;
  const dT = (end.t - start.t) / 1000;
  if (dFrac < 0.015 || dT < 1.5) return null;

  const recent = samples.slice(Math.max(0, samples.length - 8));
  const a = recent[0];
  const b = recent[recent.length - 1];
  const rdF = b.frac - a.frac;
  const rdT = (b.t - a.t) / 1000;
  const rateOverall = dFrac / dT;
  const rate =
    rdF > 0.01 && rdT >= 1
      ? rateOverall * 0.35 + (rdF / rdT) * 0.65
      : rateOverall;
  if (!(rate > 1e-6)) return null;
  const remaining = (1 - frac) / rate;
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 172800) {
    return null;
  }
  return remaining;
}

function TrainProgressBars({
  progress,
  running,
}: {
  progress: TrainProgress | null;
  running: boolean;
}) {
  const [etaLabel, setEtaLabel] = useState<string | null>(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const tracker = useRef({
    step: 0,
    samples: [] as Array<{ t: number; frac: number }>,
  });
  /** Countdown base: refreshed whenever a new estimate is computed from progress. */
  const countdown = useRef<{
    baseSec: number;
    setAt: number;
    lastFrac: number;
  } | null>(null);

  useEffect(() => {
    if (!progress) return;
    const tr = tracker.current;
    if (tr.step !== progress.step) {
      tr.step = progress.step;
      tr.samples = [];
      countdown.current = null;
      setEtaLabel(null);
    }
    const now = performance.now();
    const frac = Math.min(1, Math.max(0, progress.fraction));
    const last = tr.samples[tr.samples.length - 1];
    const added =
      !last ||
      Math.abs(last.frac - frac) >= 0.004 ||
      now - last.t > 2000;
    if (added) {
      tr.samples.push({ t: now, frac });
      if (tr.samples.length > 24) tr.samples.shift();
    }

    // Recalculate estimate when fraction advances; restart countdown from new value.
    const cd = countdown.current;
    const fracMoved = !cd || Math.abs(frac - cd.lastFrac) >= 0.008;
    if (frac >= 0.995) {
      countdown.current = null;
      setEtaLabel(null);
      return;
    }
    if (fracMoved || !cd) {
      const rem = estimateRemainingSec(tr.samples, frac);
      if (rem != null) {
        countdown.current = {
          baseSec: rem,
          setAt: performance.now(),
          lastFrac: frac,
        };
        setEtaLabel(formatEta(rem));
      } else if (!cd) {
        setEtaLabel(tr.samples.length >= 2 ? "残り時間を推定中…" : null);
      }
    }
  }, [progress]);

  useEffect(() => {
    if (!running) {
      countdown.current = null;
      setEtaLabel(null);
      return;
    }
    const tick = () => {
      const p = progressRef.current;
      if (!p) {
        setEtaLabel(null);
        return;
      }
      const frac = Math.min(1, Math.max(0, p.fraction));
      if (frac >= 0.995) {
        countdown.current = null;
        setEtaLabel(null);
        return;
      }
      const cd = countdown.current;
      if (!cd) {
        setEtaLabel(
          tracker.current.samples.length >= 2
            ? "残り時間を推定中…"
            : null,
        );
        return;
      }
      const remaining =
        cd.baseSec - (performance.now() - cd.setAt) / 1000;
      if (remaining <= 0) {
        setEtaLabel("残りわずか…");
        return;
      }
      setEtaLabel(formatEta(remaining));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [running, progress?.step]);

  if (!progress || progress.total <= 0) return null;
  const total = Math.max(1, progress.total);
  const step = Math.min(Math.max(1, progress.step), total);
  const frac = Math.min(1, Math.max(0, progress.fraction));
  const pct = Math.round(frac * 100);

  return (
    <div className="train-progress" aria-live="polite">
      <div
        className="train-step-segments"
        role="list"
        aria-label={`ステップ ${step}/${total}`}
      >
        {Array.from({ length: total }, (_, i) => {
          const n = i + 1;
          let state: "done" | "current" | "todo" = "todo";
          if (n < step) state = "done";
          else if (n === step) state = "current";
          return (
            <div
              key={n}
              role="listitem"
              className={`train-step-seg is-${state}`}
              title={`STEP ${n}/${total}`}
            />
          );
        })}
      </div>
      <div className="train-step-meta">
        <span>
          STEP {step}/{total}
          {progress.name ? ` — ${progress.name}` : ""}
        </span>
        <span>
          {pct}%
          {progress.detail ? ` · ${progress.detail}` : ""}
          {etaLabel ? ` · ${etaLabel}` : ""}
        </span>
      </div>
      <div
        className="train-process-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="train-process-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function folderBaseName(path: string): string {
  const s = path.replace(/[\\/]+$/, "").trim();
  if (!s) return "";
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return (i >= 0 ? s.slice(i + 1) : s).trim();
}

function TrainInputModeTabs({
  inputMode,
  disabled,
  onChange,
}: {
  inputMode: TrainInputMode;
  disabled?: boolean;
  onChange: (mode: TrainInputMode) => void;
}) {
  return (
    <div className="train-input-mode" role="tablist" aria-label="学習の入力元">
      <span className="train-input-mode-heading">入力元</span>
      <div className="train-input-mode-row">
        <button
          type="button"
          role="tab"
          className={`train-input-mode-btn${inputMode === "raw" ? " active" : ""}`}
          aria-selected={inputMode === "raw"}
          disabled={disabled}
          onClick={() => onChange("raw")}
        >
          <span className="train-input-mode-title">
            元音声・動画から
            {inputMode === "raw" ? (
              <span className="train-input-mode-badge">選択中</span>
            ) : null}
          </span>
          <span className="train-input-mode-desc">
            未分割の mp3 / mp4 / wav を自動で切ってから学習
          </span>
        </button>
        <button
          type="button"
          role="tab"
          className={`train-input-mode-btn${inputMode === "sliced" ? " active" : ""}`}
          aria-selected={inputMode === "sliced"}
          disabled={disabled}
          onClick={() => onChange("sliced")}
        >
          <span className="train-input-mode-title">
            スライス済みから
            {inputMode === "sliced" ? (
              <span className="train-input-mode-badge">選択中</span>
            ) : null}
          </span>
          <span className="train-input-mode-desc">
            すでに分割した wav クリップをそのまま学習
          </span>
        </button>
      </div>
    </div>
  );
}

export function TrainView({
  settings,
  onSpeakersChanged,
  onRunningChange,
  onSettingsChange,
}: Props) {
  const engineLabel = isIrodoriV4(settings) ? "v4" : "v3";
  const paths = activePaths(settings);
  const [inputDir, setInputDir] = useState("");
  const [inputMode, setInputMode] = useState<TrainInputMode>("raw");
  const [speakerName, setSpeakerName] = useState("");
  const [trainSpeed, setTrainSpeed] = useState(1);
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<TrainProgress | null>(null);
  const [resumeInfo, setResumeInfo] = useState<TrainResumeInfo | null>(null);
  const [announceDone, setAnnounceDone] = useState(() => {
    try {
      return localStorage.getItem(ANNOUNCE_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [vocalSeparate, setVocalSeparate] = useState(() => {
    try {
      return localStorage.getItem(VOCAL_SEP_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [vocalModel, setVocalModel] = useState(
    () => settings.vocalSeparatorModel || DEFAULT_VOCAL_SEPARATOR_MODEL,
  );
  const [vocalModels, setVocalModels] = useState<VocalSeparatorModelInfo[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  const [reviewMode, setReviewMode] = useState<SliceReviewMode>(() =>
    sliceReviewSettings(settings).mode,
  );
  const [reviewJobDir, setReviewJobDir] = useState<string | null>(null);
  const [reviewReadOnly, setReviewReadOnly] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const announceDoneRef = useRef(announceDone);
  announceDoneRef.current = announceDone;
  const announceAudioRef = useRef<HTMLAudioElement | null>(null);
  const playDoneAnnounceRef = useRef<
    ((embedPath: string) => Promise<void>) | null
  >(null);

  useEffect(() => {
    setVocalModel(
      settings.vocalSeparatorModel || DEFAULT_VOCAL_SEPARATOR_MODEL,
    );
  }, [settings.vocalSeparatorModel]);

  useEffect(() => {
    setReviewMode(sliceReviewSettings(settings).mode);
  }, [settings.sliceReview]);

  useEffect(() => {
    if (!reviewJobDir || reviewReadOnly) return;
    playReviewReadyChime();
    const scrollTop = () => {
      layoutRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      document
        .getElementById("slice-review-panel")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    scrollTop();
    const t = window.setTimeout(scrollTop, 50);
    return () => window.clearTimeout(t);
  }, [reviewJobDir, reviewReadOnly]);

  useEffect(() => {
    let cancelled = false;
    void invoke<VocalSeparatorModelInfo[]>("list_vocal_separator_models")
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length > 0) {
          setVocalModels(list);
        }
      })
      .catch(() => {
        if (!cancelled) {
                      setVocalModels([
                        {
                          arch: "MDXC",
                          name: "BS-Roformer（推奨・既定）",
                          filename: DEFAULT_VOCAL_SEPARATOR_MODEL,
                        },
                      ]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);

  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];

    const attach = async () => {
      const u1 = await listen<{ line: string }>("train-log", (e) => {
        setLogs((prev) => [...prev, e.payload.line]);
      });
      if (cancelled) {
        u1();
        return;
      }
      unsubs.push(u1);

      const uProg = await listen<TrainProgress>("train-progress", (e) => {
        setProgress(e.payload);
      });
      if (cancelled) {
        uProg();
        return;
      }
      unsubs.push(uProg);

      const u2 = await listen<{
        ok: boolean;
        message: string;
        embedPath?: string;
        cancelled?: boolean;
        pausedForReview?: boolean;
        jobDir?: string | null;
      }>("train-done", (e) => {
        setRunning(false);
        setCancelling(false);
        if (e.payload.cancelled) {
          setStatus(e.payload.message);
          void invoke<TrainResumeInfo | null>("get_train_resume")
            .then((info) => setResumeInfo(info))
            .catch(() => setResumeInfo(null));
        } else if (e.payload.pausedForReview) {
          const jd = e.payload.jobDir || "";
          setStatus("スライスレビュー待ち");
          setReviewReadOnly(false);
          setReviewJobDir(jd);
          void invoke<TrainResumeInfo | null>("get_train_resume")
            .then((info) => setResumeInfo(info))
            .catch(() =>
              setResumeInfo(
                jd
                  ? {
                      inputDir: "",
                      speakerName: "",
                      inputMode: "raw",
                      jobDir: jd,
                      pausedForReview: true,
                    }
                  : null,
              ),
            );
        } else if (e.payload.ok) {
          setStatus(`完了: ${e.payload.embedPath ?? e.payload.message}`);
          setProgress((prev) =>
            prev ? { ...prev, fraction: 1, detail: "完了" } : prev,
          );
          setResumeInfo(null);
          setReviewJobDir(null);
          onSpeakersChanged();
          if (announceDoneRef.current && e.payload.embedPath) {
            void playDoneAnnounceRef.current?.(e.payload.embedPath);
          }
        } else {
          setStatus(e.payload.message);
          void invoke<TrainResumeInfo | null>("get_train_resume")
            .then((info) => setResumeInfo(info))
            .catch(() => setResumeInfo(null));
        }
      });
      if (cancelled) {
        u2();
        return;
      }
      unsubs.push(u2);
    };

    void attach();

    invoke<boolean>("is_training")
      .then((active) => {
        if (active) {
          setRunning(true);
          setStatus((prev) => prev || "学習パイプライン実行中…");
        }
      })
      .catch(() => {});

    invoke<TrainResumeInfo | null>("get_train_resume")
      .then((info) => {
        if (info) {
          setResumeInfo(info);
          if (info.pausedForReview && info.jobDir) {
            setReviewReadOnly(false);
            setReviewJobDir(info.jobDir);
          }
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [onSpeakersChanged]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  /** コピー＆ペーストで付く前後の " / ' を除去 */
  const stripPathQuotes = (raw: string): string => {
    let s = raw.trim();
    if (s.startsWith('"')) {
      s = s.slice(1);
      if (s.endsWith('"')) s = s.slice(0, -1);
    } else if (s.startsWith("'")) {
      s = s.slice(1);
      if (s.endsWith("'")) s = s.slice(0, -1);
    }
    return s.trim();
  };

  const applyInputDir = (nextRaw: string) => {
    const next = stripPathQuotes(nextRaw);
    const prevBase = folderBaseName(inputDir);
    const nextBase = folderBaseName(next);
    setInputDir(next);
    setSpeakerName((cur) => {
      const t = cur.trim();
      if (!t || t === prevBase) return nextBase || t;
      return cur;
    });
  };

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") applyInputDir(selected);
  };

  const playDoneAnnounce = useCallback(
    async (embedPath: string) => {
      if (announceAudioRef.current) {
        try {
          announceAudioRef.current.pause();
        } catch {
          /* */
        }
        announceAudioRef.current = null;
      }
      setAnnouncing(true);
      const doneLabel = `完了: ${embedPath}`;
      setStatus("終了通知を生成中…（学習した声で発話）");
      try {
        await invoke("ensure_worker");
        const outPath = await invoke<string>("line_cache_wav_path", {
          projectName: "_train_notify",
          lineId: "done",
        });
        const s = defaultSampling();
        await invoke("synthesize_line", {
          args: {
            text: DONE_ANNOUNCE_TEXT,
            refEmbed: embedPath,
            outputWav: outPath,
            numSteps: s.numSteps,
            numCandidates: 1,
            seed: s.seed,
            seconds: s.seconds,
            durationScale: s.durationScale,
            tScheduleMode: s.tScheduleMode,
            swayCoeff: s.swayCoeff,
            cfgGuidanceMode: s.cfgGuidanceMode,
            cfgScaleText: s.cfgScaleText,
            cfgScaleSpeaker: s.cfgScaleSpeaker,
          },
        });
        const exists = await invoke<boolean>("file_exists", { path: outPath });
        if (!exists) {
          setStatus(`${doneLabel}（終了通知の音声ファイルを作れませんでした）`);
          return;
        }
        const bytes = await invoke<number[]>("read_file_bytes", {
          path: outPath,
        });
        const blob = new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        announceAudioRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (announceAudioRef.current === audio) {
            announceAudioRef.current = null;
          }
        };
        setStatus(doneLabel);
        await audio.play();
      } catch (e) {
        setStatus(`完了: ${embedPath}（終了通知の再生に失敗: ${e}）`);
      } finally {
        setAnnouncing(false);
      }
    },
    [],
  );
  playDoneAnnounceRef.current = playDoneAnnounce;

  const setAnnounceDonePersist = (on: boolean) => {
    setAnnounceDone(on);
    try {
      localStorage.setItem(ANNOUNCE_STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* */
    }
  };

  const setVocalSeparatePersist = (on: boolean) => {
    setVocalSeparate(on);
    try {
      localStorage.setItem(VOCAL_SEP_STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* */
    }
  };

  const persistVocalModel = async (filename: string) => {
    setVocalModel(filename);
    if (filename === (settings.vocalSeparatorModel || DEFAULT_VOCAL_SEPARATOR_MODEL)) {
      return;
    }
    try {
      const next = await invoke<AppSettings>("set_settings", {
        settings: { ...settings, vocalSeparatorModel: filename },
      });
      onSettingsChange?.(next);
    } catch {
      /* keep local selection */
    }
  };

  const persistSliceReview = async (patch: Partial<SliceReviewSettings>) => {
    const cur = sliceReviewSettings(settings);
    try {
      const next = await invoke<AppSettings>("set_settings", {
        settings: {
          ...settings,
          sliceReview: { ...cur, ...patch },
        },
      });
      onSettingsChange?.(next);
    } catch {
      /* */
    }
  };

  const startJob = async (opts?: { resume?: TrainResumeInfo }) => {
    const resume = opts?.resume;
    const folder = stripPathQuotes(resume?.inputDir ?? inputDir);
    const name = (resume?.speakerName ?? speakerName).trim();
    // 新規開始は UI の inputMode、再開は保存済み mode を使う
    const mode = (
      (resume?.inputMode ?? inputMode) === "sliced" ? "sliced" : "raw"
    ) as TrainInputMode;
    const speedRaw = resume?.speed ?? trainSpeed;
    const speed = Math.min(
      2,
      Math.max(0.5, Number.isFinite(speedRaw) ? speedRaw : 1),
    );
    const doVocal = resume
      ? Boolean(resume.vocalSeparate)
      : vocalSeparate;
    const model =
      (resume?.vocalModel || vocalModel || DEFAULT_VOCAL_SEPARATOR_MODEL).trim() ||
      DEFAULT_VOCAL_SEPARATOR_MODEL;
    if (!resume) {
      if (folder !== inputDir) setInputDir(folder);
    } else {
      setInputDir(folder);
      setSpeakerName(name);
      setInputMode(mode);
      setTrainSpeed(speed);
      setVocalSeparatePersist(doVocal);
      setVocalModel(model);
    }
    if (!folder || !name) {
      setStatus("音声フォルダと話者名を入力してください");
      return;
    }
    if (!resume) setLogs([]);
    else setLogs((prev) => [...prev, "── 再開 ──"]);
    setProgress(null);
    setRunning(true);
    setCancelling(false);
    setResumeInfo(null);
    setConfirmOpen(false);
    setStatus(
      resume ? "学習パイプラインを再開中…" : "学習パイプライン実行中…",
    );
    try {
      await invoke("start_training", {
        inputDir: folder,
        speakerName: name,
        inputMode: mode,
        speed,
        vocalSeparate: doVocal,
        vocalModel: model,
        jobDir: resume?.jobDir || null,
        reviewMode: (resume?.reviewMode as SliceReviewMode) || reviewMode,
      });
    } catch (e) {
      setRunning(false);
      setStatus(String(e));
    }
  };

  const start = () => {
    const folder = stripPathQuotes(inputDir);
    const name = speakerName.trim();
    if (!folder || !name) {
      setStatus("音声フォルダと話者名を入力してください");
      return;
    }
    if (folder !== inputDir) setInputDir(folder);
    setConfirmOpen(true);
  };

  const cancel = async () => {
    if (!running || cancelling) return;
    const ok = window.confirm(
      "学習を中断しますか？\n\n実行中のステップは途中まで破棄され、完了済みのステップからは再開できます。",
    );
    if (!ok) return;
    setCancelling(true);
    setStatus("中断しています…");
    try {
      await invoke("cancel_training");
    } catch (e) {
      setCancelling(false);
      setStatus(String(e));
    }
  };

  const resume = () => {
    if (!resumeInfo) return;
    void startJob({ resume: resumeInfo });
  };

  const discardResume = async () => {
    try {
      await invoke("clear_train_resume");
    } catch {
      /* */
    }
    setResumeInfo(null);
  };

  const modelOptions = (() => {
    const base = (
      vocalModels.length > 0
        ? vocalModels
        : [
            {
              arch: "MDXC",
              name: "BS-Roformer（推奨・既定）",
              filename: DEFAULT_VOCAL_SEPARATOR_MODEL,
            },
          ]
    ).map((m) => ({
      value: m.filename,
      label: m.name || m.filename,
    }));
    if (!base.some((o) => o.value === vocalModel)) {
      return [{ value: vocalModel, label: `${vocalModel}（非推奨・旧設定）` }, ...base];
    }
    return base;
  })();

  const speedAltered = Math.abs(trainSpeed - 1) >= 0.001;

  return (
    <div className="train-layout" ref={layoutRef}>
      {reviewJobDir ? (
        <SliceReviewView
          jobDir={reviewJobDir}
          readOnly={reviewReadOnly}
          onCancel={() => setReviewJobDir(null)}
          onContinue={() => {
            const jd = reviewJobDir;
            setReviewJobDir(null);
            if (!resumeInfo && jd) {
              void startJob({
                resume: {
                  inputDir,
                  speakerName,
                  inputMode,
                  jobDir: jd,
                  speed: trainSpeed,
                  vocalSeparate,
                  vocalModel,
                  reviewMode,
                },
              });
            } else if (resumeInfo) {
              void startJob({
                resume: {
                  ...resumeInfo,
                  jobDir: jd || resumeInfo.jobDir,
                  reviewMode: resumeInfo.reviewMode || reviewMode,
                  pausedForReview: false,
                },
              });
            }
          }}
        />
      ) : null}
      <section className="panel">
        <header className="panel-header">
          <h3>Speaker Embedding 学習</h3>
        </header>
        <div className="panel-body form-stack">
          <p className="hint">
            使用エンジン: <strong>{engineLabel}</strong>
            {" — "}
            <span title={paths.checkpointPath}>{paths.irodoriRoot}</span>
          </p>
          <TrainInputModeTabs
            inputMode={inputMode}
            disabled={running}
            onChange={setInputMode}
          />
          <label>
            {inputMode === "sliced"
              ? "スライス済み音声フォルダ"
              : "音声フォルダ"}
            <div className="row">
              <input
                value={inputDir}
                onChange={(e) => applyInputDir(e.target.value)}
                placeholder={
                  inputMode === "sliced"
                    ? "slice_000.wav などが入ったフォルダ"
                    : "mp3 / mp4 / wav が入ったフォルダ"
                }
                disabled={running}
              />
              <button type="button" onClick={pickFolder} disabled={running}>
                参照
              </button>
            </div>
          </label>
          <label>
            話者名
            <input
              value={speakerName}
              onChange={(e) => setSpeakerName(e.target.value)}
              placeholder="例: Hanako"
              disabled={running}
            />
          </label>
          <label className={`param-field${speedAltered ? " is-speed-altered" : ""}`}>
            <span className="param-label">
              音源速度 ({trainSpeed.toFixed(2)}
              {speedAltered ? " · 変更あり" : " · 変更なし"})
            </span>
            <div className="param-controls">
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.01}
                value={trainSpeed}
                disabled={running}
                onChange={(e) => setTrainSpeed(Number(e.target.value))}
              />
              <input
                type="number"
                min={0.5}
                max={2}
                step={0.01}
                value={trainSpeed}
                disabled={running}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v)) return;
                  setTrainSpeed(Math.min(2, Math.max(0.5, v)));
                }}
              />
              <button
                type="button"
                className="icon-btn"
                disabled={running}
                title="1.00 に戻す"
                onClick={() => setTrainSpeed(1)}
              >
                ↺
              </button>
            </div>
            {speedAltered && (
              <span className="param-altered-hint">
                既定の 1.00 から変更されています。スライス後にピッチ維持の速度調整をかけます。
              </span>
            )}
          </label>
          <div className={`train-vocal-block${vocalSeparate ? " is-vocal-altered" : ""}`}>
            <label className="train-announce-check" title="学習前に UVR 系モデルでボーカルのみ抽出します（Instrumental は出力しません）">
              <input
                type="checkbox"
                checked={vocalSeparate}
                disabled={running}
                onChange={(e) => setVocalSeparatePersist(e.target.checked)}
              />
              学習前にボーカル分離を行う{vocalSeparate ? " · 有効" : ""}
            </label>
            {vocalSeparate && (
              <label>
                分離モデル
                <BoundedSelect
                  value={vocalModel}
                  options={modelOptions}
                  disabled={running}
                  onChange={(v) => void persistVocalModel(v)}
                />
              </label>
            )}
            {vocalSeparate && (
              <span className="param-altered-hint">
                学習前にボーカルのみ抽出します（元フォルダは書き換えません）。
              </span>
            )}
          </div>
          <div
            className={`train-review-block${reviewMode === "auto" ? " is-review-auto" : ""}`}
          >
            <label>
              スライスレビュー{reviewMode === "auto" ? " · 自動除外" : ""}
              <BoundedSelect
                value={reviewMode}
                disabled={running}
                options={[
                  { value: "manual", label: "manual（指標表示・人手確認）" },
                  { value: "auto", label: "auto（総合スコア＋観点で自動除外）" },
                  { value: "skip", label: "skip（レビューなし）" },
                ]}
                onChange={(v) =>
                  setReviewMode(
                    v === "skip" || v === "auto" || v === "manual" ? v : "manual",
                  )
                }
              />
            </label>
            {reviewMode === "auto" && (
              <>
                <div className="slice-review-settings-grid">
                  <label>
                    auto 除去率（総合スコア上位 %）
                    <input
                      type="number"
                      min={0}
                      max={90}
                      step={1}
                      disabled={running}
                      value={sliceReviewSettings(settings).autoRemovePercent ?? 0}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        void persistSliceReview({
                          autoRemovePercent: Number.isFinite(n)
                            ? Math.min(90, Math.max(0, Math.round(n)))
                            : 0,
                        });
                      }}
                    />
                  </label>
                  <label>
                    auto 残件数上限（0=無制限）
                    <input
                      type="number"
                      min={0}
                      step={1}
                      disabled={running}
                      value={sliceReviewSettings(settings).autoKeepMax ?? 0}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        void persistSliceReview({
                          autoKeepMax: Number.isFinite(n)
                            ? Math.max(0, Math.floor(n))
                            : 0,
                        });
                      }}
                    />
                  </label>
                </div>
                <span className="param-altered-hint">
                  確認画面なしで外れ値スライスを自動除外して学習に進みます。
                </span>
              </>
            )}
          </div>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={running}
              onClick={start}
            >
              {running ? "実行中…" : "学習開始"}
            </button>
            {running && (
              <button
                type="button"
                className="danger"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {cancelling ? "中断中…" : "中断"}
              </button>
            )}
            {!running && resumeInfo && !reviewJobDir && (
              <>
                <button type="button" className="primary" onClick={resume}>
                  再開
                </button>
                {resumeInfo.pausedForReview && (
                  <button
                    type="button"
                    onClick={() => {
                      setReviewReadOnly(false);
                      setReviewJobDir(resumeInfo.jobDir);
                    }}
                  >
                    レビューを開く
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (resumeInfo.jobDir) {
                      setReviewReadOnly(true);
                      setReviewJobDir(resumeInfo.jobDir);
                    }
                  }}
                >
                  除外を確認
                </button>
                <button type="button" onClick={() => void discardResume()}>
                  破棄
                </button>
              </>
            )}
            <label className="train-announce-check" title="学習完了時、学習した声で「学習終了しました」と発話します">
              <input
                type="checkbox"
                checked={announceDone}
                disabled={announcing}
                onChange={(e) => setAnnounceDonePersist(e.target.checked)}
              />
              終了通知
            </label>
            <span className="status-text">{status}</span>
          </div>
          {(running || progress) && (
            <TrainProgressBars progress={progress} running={running} />
          )}
          {!running && resumeInfo && (
            <p className="hint">
              中断したジョブがあります（{resumeInfo.jobDir}
              ）。「再開」で完了済みステップをスキップして続行できます。
            </p>
          )}
          <p className="hint">
            {inputMode === "sliced"
              ? "すでに分割済みのクリップ（推奨: 1秒以上の wav）をそのまま使い、データ準備 → 話者埋め込み学習を実行します。非 wav は自動で wav 化します（再スライスはしません）。"
              : "音声の形式変換（すでに wav なら省略）→ 分割 → データ準備 → 話者埋め込みの学習、までを自動で順に実行します。"}
            {vocalSeparate
              ? inputMode === "raw"
                ? " ボーカル分離はスライスより前に実行し、Vocals のみの WAV を後段に渡します（to_wav は省略）。"
                : " ボーカル分離を各クリップに適用してから学習します。4秒未満は無音パディングして分離し、元の長さに戻します。"
              : ""}
            音源速度が 1.00 以外のときは、スライス後に各クリップへピッチ維持の速度調整をかけてから学習します（元フォルダは書き換えません）。
            学習中は生成・設定画面へは移動できません。設定のエンジン版（v3/v4）に応じた
            YAML / Checkpoint が使われます。
          </p>
          <pre className="log-view" ref={logRef}>
            {logs.join("\n") || "ログはここに表示されます"}
          </pre>
        </div>
      </section>

      {confirmOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="modal panel train-confirm-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="panel-header">
              <h3>学習設定の確認</h3>
            </header>
            <div className="panel-body form-stack">
              <p className="hint">
                内容を確認・変更してから開始できます。
              </p>
              <TrainInputModeTabs
                inputMode={inputMode}
                onChange={setInputMode}
              />
              <label>
                {inputMode === "sliced"
                  ? "スライス済み音声フォルダ"
                  : "音声フォルダ"}
                <div className="row">
                  <input
                    value={inputDir}
                    onChange={(e) => applyInputDir(e.target.value)}
                  />
                  <button type="button" onClick={() => void pickFolder()}>
                    参照
                  </button>
                </div>
              </label>
              <label>
                話者名
                <input
                  value={speakerName}
                  onChange={(e) => setSpeakerName(e.target.value)}
                />
              </label>
              <label className={`param-field${speedAltered ? " is-speed-altered" : ""}`}>
                <span className="param-label">
                  音源速度 ({trainSpeed.toFixed(2)}
                  {speedAltered ? " · 変更あり" : " · 変更なし"})
                </span>
                <div className="param-controls">
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.01}
                    value={trainSpeed}
                    onChange={(e) => setTrainSpeed(Number(e.target.value))}
                  />
                  <input
                    type="number"
                    min={0.5}
                    max={2}
                    step={0.01}
                    value={trainSpeed}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      setTrainSpeed(Math.min(2, Math.max(0.5, v)));
                    }}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    title="1.00 に戻す"
                    onClick={() => setTrainSpeed(1)}
                  >
                    ↺
                  </button>
                </div>
                {speedAltered && (
                  <span className="param-altered-hint">
                    既定の 1.00 から変更されています。スライス後にピッチ維持の速度調整をかけます。
                  </span>
                )}
              </label>
              <div className={`train-vocal-block${vocalSeparate ? " is-vocal-altered" : ""}`}>
                <label className="train-announce-check">
                  <input
                    type="checkbox"
                    checked={vocalSeparate}
                    onChange={(e) => setVocalSeparatePersist(e.target.checked)}
                  />
                  学習前にボーカル分離を行う{vocalSeparate ? " · 有効" : ""}
                </label>
                {vocalSeparate && (
                  <label>
                    分離モデル
                    <BoundedSelect
                      value={vocalModel}
                      options={modelOptions}
                      onChange={(v) => void persistVocalModel(v)}
                    />
                  </label>
                )}
                {vocalSeparate && (
                  <span className="param-altered-hint">
                    学習前にボーカルのみ抽出します（元フォルダは書き換えません）。
                  </span>
                )}
              </div>
              <div
                className={`train-review-block${reviewMode === "auto" ? " is-review-auto" : ""}`}
              >
                <label>
                  スライスレビュー{reviewMode === "auto" ? " · 自動除外" : ""}
                  <select
                    value={reviewMode}
                    onChange={(e) => {
                      const v = e.target.value;
                      setReviewMode(
                        v === "skip" || v === "auto" || v === "manual"
                          ? v
                          : "manual",
                      );
                    }}
                  >
                    <option value="manual">manual（人手確認）</option>
                    <option value="auto">auto（総合スコア＋観点で自動除外）</option>
                    <option value="skip">skip</option>
                  </select>
                </label>
                {reviewMode === "auto" && (
                  <span className="param-altered-hint">
                    確認画面なしで外れ値スライスを自動除外して学習に進みます。
                  </span>
                )}
              </div>
              <label className="train-announce-check">
                <input
                  type="checkbox"
                  checked={announceDone}
                  onChange={(e) => setAnnounceDonePersist(e.target.checked)}
                />
                終了通知
              </label>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void startJob()}
                >
                  この内容で開始
                </button>
                <button type="button" onClick={() => setConfirmOpen(false)}>
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
