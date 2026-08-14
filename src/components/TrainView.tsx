import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { BoundedSelect } from "./BoundedSelect";
import type { AppSettings, SpeakerInfo } from "../types";
import {
  activePaths,
  defaultSampling,
  isIrodoriV4,
  speakerOptionLabel,
} from "../types";

type Props = {
  speakers: SpeakerInfo[];
  settings: AppSettings;
  onSpeakersChanged: () => void;
  onRunningChange?: (running: boolean) => void;
};

type ProfileKind = "ref" | "caption";

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
};

const ANNOUNCE_STORAGE_KEY = "irodori.trainAnnounceDone";
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

export function TrainView({
  speakers,
  settings,
  onSpeakersChanged,
  onRunningChange,
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
  const [announcing, setAnnouncing] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const announceDoneRef = useRef(announceDone);
  announceDoneRef.current = announceDone;
  const announceAudioRef = useRef<HTMLAudioElement | null>(null);
  const playDoneAnnounceRef = useRef<
    ((embedPath: string) => Promise<void>) | null
  >(null);

  // Blend state
  const [embedA, setEmbedA] = useState("");
  const [embedB, setEmbedB] = useState("");
  const [alpha, setAlpha] = useState(0.5);
  const [blendName, setBlendName] = useState("");
  const [blendMsg, setBlendMsg] = useState("");

  // Ref / caption profile editor
  const [profileEditPath, setProfileEditPath] = useState<string | null>(null);
  const [profileKind, setProfileKind] = useState<ProfileKind>("ref");
  const [profileName, setProfileName] = useState("");
  const [profileRefWav, setProfileRefWav] = useState("");
  const [profileCaption, setProfileCaption] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);

  const profileSpeakers = useMemo(
    () => speakers.filter((s) => s.kind === "ref" || s.kind === "caption"),
    [speakers],
  );

  const embedSpeakers = useMemo(
    () => speakers.filter((s) => s.kind === "trained" || s.kind === "blend"),
    [speakers],
  );

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
      }>("train-done", (e) => {
        setRunning(false);
        setCancelling(false);
        if (e.payload.cancelled) {
          setStatus(e.payload.message);
          void invoke<TrainResumeInfo | null>("get_train_resume")
            .then((info) => setResumeInfo(info))
            .catch(() => setResumeInfo(null));
        } else if (e.payload.ok) {
          setStatus(`完了: ${e.payload.embedPath ?? e.payload.message}`);
          setProgress((prev) =>
            prev ? { ...prev, fraction: 1, detail: "完了" } : prev,
          );
          setResumeInfo(null);
          onSpeakersChanged();
          if (announceDoneRef.current && e.payload.embedPath) {
            void playDoneAnnounceRef.current?.(e.payload.embedPath);
          }
        } else {
          setStatus(`失敗: ${e.payload.message}`);
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
        if (info) setResumeInfo(info);
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

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setInputDir(selected);
  };

  const pickRefWav = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "mp3", "flac", "ogg", "m4a", "aac"],
        },
      ],
    });
    if (typeof selected === "string") setProfileRefWav(selected);
  };

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
    if (!resume) {
      if (folder !== inputDir) setInputDir(folder);
    } else {
      setInputDir(folder);
      setSpeakerName(name);
      setInputMode(mode);
      setTrainSpeed(speed);
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
    setStatus(
      resume ? "学習パイプラインを再開中…" : "学習パイプライン実行中…",
    );
    try {
      await invoke("start_training", {
        inputDir: folder,
        speakerName: name,
        inputMode: mode,
        speed,
        jobDir: resume?.jobDir || null,
      });
    } catch (e) {
      setRunning(false);
      setStatus(String(e));
    }
  };

  const start = () => {
    void startJob();
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

  const nameA = embedSpeakers.find((s) => s.embedPath === embedA)?.name ?? "A";
  const nameB = embedSpeakers.find((s) => s.embedPath === embedB)?.name ?? "B";

  const speakerOptions = useMemo(
    () => [
      { value: "", label: "選択…" },
      ...embedSpeakers.map((s) => ({
        value: s.embedPath,
        label: speakerOptionLabel(s),
      })),
    ],
    [embedSpeakers],
  );

  const doBlend = async () => {
    if (!embedA || !embedB) {
      setBlendMsg("2つの埋め込みを選択してください");
      return;
    }
    const name =
      blendName.trim() || `${nameA}_${nameB}_${Math.round(alpha * 100)}`;
    try {
      const out = await invoke<string>("blend_embeddings", {
        embedA,
        embedB,
        alpha,
        outputName: name,
      });
      setBlendMsg(`保存: ${out}`);
      onSpeakersChanged();
    } catch (e) {
      setBlendMsg(String(e));
    }
  };

  const resetProfileForm = () => {
    setProfileEditPath(null);
    setProfileKind("ref");
    setProfileName("");
    setProfileRefWav("");
    setProfileCaption("");
    setProfileMsg("");
  };

  const beginEditProfile = (sp: SpeakerInfo) => {
    setProfileEditPath(sp.embedPath);
    setProfileKind(sp.kind === "caption" ? "caption" : "ref");
    setProfileName(sp.name);
    setProfileRefWav(sp.refWav ?? "");
    setProfileCaption(sp.caption ?? "");
    setProfileMsg(`編集中: ${sp.name}`);
  };

  const saveProfile = async () => {
    const name = profileName.trim();
    if (!name) {
      setProfileMsg("話者名を入力してください");
      return;
    }
    setProfileBusy(true);
    setProfileMsg("");
    try {
      const saved = await invoke<SpeakerInfo>("upsert_speaker_profile_cmd", {
        args: {
          profilePath: profileEditPath,
          name,
          kind: profileKind,
          refWav:
            profileKind === "ref" ? stripPathQuotes(profileRefWav) : null,
          caption: profileKind === "caption" ? profileCaption.trim() : null,
        },
      });
      setProfileMsg(
        profileEditPath
          ? `更新しました: ${saved.name}`
          : `作成しました: ${saved.name}`,
      );
      setProfileEditPath(saved.embedPath);
      onSpeakersChanged();
    } catch (e) {
      setProfileMsg(String(e));
    } finally {
      setProfileBusy(false);
    }
  };

  const deleteProfile = async (sp: SpeakerInfo) => {
    if (!window.confirm(`話者「${sp.name}」を削除しますか？`)) return;
    setProfileBusy(true);
    try {
      await invoke("delete_speaker_profile_cmd", {
        profilePath: sp.embedPath,
      });
      if (profileEditPath === sp.embedPath) resetProfileForm();
      setProfileMsg(`削除しました: ${sp.name}`);
      onSpeakersChanged();
    } catch (e) {
      setProfileMsg(String(e));
    } finally {
      setProfileBusy(false);
    }
  };

  return (
    <div className="train-layout">
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
          <div className="profile-kind-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={inputMode === "raw" ? "active" : ""}
              aria-selected={inputMode === "raw"}
              disabled={running}
              onClick={() => setInputMode("raw")}
            >
              元音声・動画から
            </button>
            <button
              type="button"
              role="tab"
              className={inputMode === "sliced" ? "active" : ""}
              aria-selected={inputMode === "sliced"}
              disabled={running}
              onClick={() => setInputMode("sliced")}
            >
              スライス済みから
            </button>
          </div>
          <label>
            {inputMode === "sliced"
              ? "スライス済み音声フォルダ"
              : "音声フォルダ"}
            <div className="row">
              <input
                value={inputDir}
                onChange={(e) => setInputDir(e.target.value)}
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
          <label className="param-field">
            <span className="param-label">
              音源速度 ({trainSpeed.toFixed(2)}
              {Math.abs(trainSpeed - 1) < 0.001 ? " · 変更なし" : ""})
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
          </label>
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
            {!running && resumeInfo && (
              <>
                <button type="button" className="primary" onClick={resume}>
                  再開
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
            音源速度が 1.00 以外のときは、スライス後に各クリップへピッチ維持の速度調整をかけてから学習します（元フォルダは書き換えません）。
            学習中は生成・設定画面へは移動できません。設定のエンジン版（v3/v4）に応じた
            YAML / Checkpoint が使われます。
          </p>
          <pre className="log-view" ref={logRef}>
            {logs.join("\n") || "ログはここに表示されます"}
          </pre>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h3>参照音源 / VoiceDesign 話者</h3>
        </header>
        <div className="panel-body form-stack">
          <p className="hint">
            Embedding 学習なしで使えます。参照音源はゼロショットクローン、キャプションは
            No-Ref（声デザイン）です。v4 は統合モデルのため同一 Checkpoint
            で両方使えます。v3 の caption は VoiceDesign 系 Checkpoint が必要です。
            mp3 / aac などは保存時に WAV へ変換します。
          </p>

          <div className="profile-kind-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={profileKind === "ref" ? "active" : ""}
              aria-selected={profileKind === "ref"}
              onClick={() => setProfileKind("ref")}
            >
              参照音源
            </button>
            <button
              type="button"
              role="tab"
              className={profileKind === "caption" ? "active" : ""}
              aria-selected={profileKind === "caption"}
              onClick={() => setProfileKind("caption")}
            >
              キャプション
            </button>
          </div>

          <label>
            話者名
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="例: Ref_Hanako / SoftVoice"
            />
          </label>

          {profileKind === "ref" ? (
            <label>
              参照音源
              <div className="row">
                <input
                  value={profileRefWav}
                  onChange={(e) => setProfileRefWav(e.target.value)}
                  placeholder="wav / mp3 など"
                />
                <button type="button" onClick={() => void pickRefWav()}>
                  参照
                </button>
              </div>
            </label>
          ) : (
            <label>
              キャプション（声のデザイン）
              <textarea
                className="profile-caption"
                rows={3}
                value={profileCaption}
                onChange={(e) => setProfileCaption(e.target.value)}
                placeholder="例: 落ち着いた若い女性の声、少し息多め"
              />
            </label>
          )}

          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={profileBusy}
              onClick={() => void saveProfile()}
            >
              {profileEditPath ? "更新" : "追加"}
            </button>
            {profileEditPath && (
              <button
                type="button"
                disabled={profileBusy}
                onClick={resetProfileForm}
              >
                新規作成に切替
              </button>
            )}
            <span className="status-text">{profileMsg}</span>
          </div>

          <div className="profile-list">
            {profileSpeakers.length === 0 ? (
              <p className="hint">まだ登録された話者はありません</p>
            ) : (
              profileSpeakers.map((sp) => (
                <div
                  key={sp.embedPath}
                  className={`profile-list-item ${
                    profileEditPath === sp.embedPath ? "active" : ""
                  }`}
                >
                  <div className="profile-list-main">
                    <strong>{sp.name}</strong>
                    <span className="profile-kind-badge">
                      {sp.kind === "ref" ? "参照" : "caption"}
                    </span>
                    <span
                      className="profile-list-detail"
                      title={
                        sp.kind === "ref"
                          ? (sp.refWav ?? "")
                          : (sp.caption ?? "")
                      }
                    >
                      {sp.kind === "ref" ? (sp.refWav ?? "") : (sp.caption ?? "")}
                    </span>
                  </div>
                  <div className="row profile-list-actions">
                    <button
                      type="button"
                      disabled={profileBusy}
                      onClick={() => beginEditProfile(sp)}
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={profileBusy}
                      onClick={() => void deleteProfile(sp)}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h3>埋め込みブレンド</h3>
        </header>
        <div className="panel-body form-stack">
          <div className="blend-row">
            <label>
              話者 A
              <BoundedSelect
                value={embedA}
                options={speakerOptions}
                onChange={setEmbedA}
                placeholder="選択…"
                aria-label="話者 A"
              />
            </label>
            <label>
              話者 B
              <BoundedSelect
                value={embedB}
                options={speakerOptions}
                onChange={setEmbedB}
                placeholder="選択…"
                aria-label="話者 B"
              />
            </label>
          </div>

          <div className="blend-slider">
            <span className="blend-name">{nameA}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={alpha}
              onChange={(e) => setAlpha(Number(e.target.value))}
            />
            <span className="blend-name">{nameB}</span>
            <span className="blend-alpha">{alpha.toFixed(2)}</span>
          </div>

          <label>
            出力名
            <input
              value={blendName}
              onChange={(e) => setBlendName(e.target.value)}
              placeholder="空欄なら自動命名"
            />
          </label>
          <div className="row">
            <button type="button" className="primary" onClick={doBlend}>
              ブレンド保存
            </button>
            <span className="status-text">{blendMsg}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
