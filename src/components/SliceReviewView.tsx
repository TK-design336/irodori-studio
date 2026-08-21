import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SliceReviewAspectId } from "../types";

export type SliceMetricsRow = {
  file: string;
  path: string;
  scriptText?: string | null;
  asrText?: string | null;
  duration?: number;
  silenceRatio?: number;
  lufs?: number;
  peakDb?: number;
  clipRatio?: number;
  speedMoraPerSec?: number | null;
  moraCount?: number;
  cer?: number | null;
  speechRatio?: number | null;
  speakerSim?: number | null;
  f0Mean?: number | null;
  spectralCentroid?: number;
  highBandRatio?: number;
  spectralTilt?: number;
  rolloff85Hz?: number;
  bandwidthHz?: number;
  spectralFlatness?: number;
  spectralCrest?: number;
  tailRatio?: number;
  hfSustain?: number;
  envCrest?: number;
  mos?: { sig?: number; bak?: number; ovrl?: number } | null;
  flags?: Partial<Record<SliceReviewAspectId, boolean>>;
  scores?: Record<string, { badness?: number; z?: number | null } & Record<string, unknown>>;
  hitAspects?: string[];
  hitCount?: number;
  outlierScore?: number;
};

type ExclusionMeta = {
  excluded?: boolean;
  flagged?: boolean;
  source?: string;
  aspects?: string[];
};

type Props = {
  jobDir: string;
  onContinue: () => void;
  onCancel: () => void;
  readOnly?: boolean;
};

const ASPECTS: SliceReviewAspectId[] = [
  "A",
  "B",
  "C",
  "D",
  "F",
  "G",
  "H",
  "I",
];

const ASPECT_LABELS: Record<SliceReviewAspectId, string> = {
  A: "長さ",
  B: "発話速度",
  C: "無音比率",
  D: "音量",
  E: "転写整合",
  F: "話者一貫",
  G: "スペクトル",
  H: "非音声",
  I: "こもり/響き",
  J: "MOS",
};

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function formatHitAspect(id: string, row: SliceMetricsRow): string {
  if (id !== "I") return id;
  const s = row.scores?.I as
    | { muffleHit?: boolean; ringHit?: boolean }
    | undefined;
  if (s?.muffleHit && s?.ringHit) return "I:こもり/響き";
  if (s?.ringHit) return "I:響き";
  if (s?.muffleHit) return "I:こもり";
  return "I";
}

export function SliceReviewView({
  jobDir,
  onContinue,
  onCancel,
  readOnly,
}: Props) {
  const [slices, setSlices] = useState<SliceMetricsRow[]>([]);
  const [hist, setHist] = useState<number[]>([]);
  const [exclusions, setExclusions] = useState<Record<string, ExclusionMeta>>(
    {},
  );
  const [reviewLog, setReviewLog] = useState<{
    mode?: string;
    excludedCount?: number;
    byAspect?: Record<string, number>;
  } | null>(null);
  const [tab, setTab] = useState<"all" | SliceReviewAspectId>("all");
  const [allSort, setAllSort] = useState<"outlier" | "name">("outlier");
  const [flagPct, setFlagPct] = useState(5);
  const [playIdx, setPlayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [rate, setRate] = useState(1);
  const [playTime, setPlayTime] = useState(0);
  const [playDur, setPlayDur] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const listParentRef = useRef<HTMLDivElement>(null);
  const seekingRef = useRef(false);
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;
  const playIdxRef = useRef(playIdx);
  playIdxRef.current = playIdx;
  const rateRef = useRef(rate);
  rateRef.current = rate;

  const load = useCallback(async () => {
    setStatus("指標を読み込み中…");
    try {
      const metrics = await invoke<{
        slices?: SliceMetricsRow[];
        speakerSimHistogram?: number[];
      }>("load_slice_review_metrics_cmd", { jobDir });
      const excl = await invoke<Record<string, ExclusionMeta>>(
        "load_slice_review_exclusions_cmd",
        { jobDir },
      );
      const log = await invoke<{
        mode?: string;
        excludedCount?: number;
        byAspect?: Record<string, number>;
      }>("load_slice_review_log_cmd", { jobDir });
      setSlices(Array.isArray(metrics?.slices) ? metrics.slices : []);
      setHist(
        Array.isArray(metrics?.speakerSimHistogram)
          ? metrics.speakerSimHistogram
          : [],
      );
      setExclusions(excl && typeof excl === "object" ? excl : {});
      setReviewLog(log || null);
      setStatus("");
    } catch (e) {
      setStatus(String(e));
    }
  }, [jobDir]);

  useEffect(() => {
    void load();
  }, [load]);

  const persistExclusions = useCallback(
    async (next: Record<string, ExclusionMeta>) => {
      setExclusions(next);
      if (readOnly) return;
      try {
        await invoke("save_slice_review_exclusions_cmd", {
          jobDir,
          exclusions: next,
        });
      } catch (e) {
        setStatus(String(e));
      }
    },
    [jobDir, readOnly],
  );

  const filtered = useMemo(() => {
    let rows = [...slices];
    if (tab !== "all") {
      rows = rows.filter((r) => r.flags?.[tab] || r.hitAspects?.includes(tab));
    }
    const nameKey = (name: string) =>
      name.split(/(\d+)/).map((p) => (/^\d+$/.test(p) ? Number(p) : p.toLowerCase()));
    const cmpName = (a: SliceMetricsRow, b: SliceMetricsRow) => {
      const ka = nameKey(a.file);
      const kb = nameKey(b.file);
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        const x = ka[i];
        const y = kb[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (x < y) return -1;
        if (x > y) return 1;
      }
      return 0;
    };
    const aspectBadness = (row: SliceMetricsRow, aspect: SliceReviewAspectId) => {
      const s = row.scores?.[aspect];
      if (s && typeof s.badness === "number") return s.badness;
      if (s && typeof s.z === "number") return Math.abs(s.z);
      return row.hitAspects?.includes(aspect) ? 1 : 0;
    };
    rows.sort((a, b) => {
      if (allSort === "name") return cmpName(a, b);
      if (tab === "all") {
        const d = (b.outlierScore ?? 0) - (a.outlierScore ?? 0);
        if (d !== 0) return d;
        return cmpName(a, b);
      }
      const d = aspectBadness(b, tab) - aspectBadness(a, tab);
      if (d !== 0) return d;
      return cmpName(a, b);
    });
    return rows;
  }, [slices, tab, allSort]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listParentRef.current,
    estimateSize: (index) => (index === playIdx && playDur > 0 ? 78 : 52),
    overscan: 12,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [playIdx, playDur, virtualizer]);

  const stopAudio = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      a.onended = null;
      a.onloadedmetadata = null;
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setPlaying(false);
    setPlayTime(0);
    setPlayDur(0);
  }, []);

  const pauseAudio = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(false);
    setAutoPlay(false);
  }, []);

  const resumeAudio = useCallback(async () => {
    const a = audioRef.current;
    if (!a?.src) return false;
    try {
      await a.play();
      setPlaying(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  const playAt = useCallback(
    async (idx: number) => {
      const row = filtered[idx];
      if (!row) return;
      setPlayIdx(idx);
      stopAudio();
      setPlayTime(0);
      setPlayDur(row.duration && row.duration > 0 ? row.duration : 0);
      try {
        const bytes = await invoke<number[]>("read_file_bytes", {
          path: row.path,
        });
        const u8 = Uint8Array.from(bytes);
        const blob = new Blob([u8], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        let audio = audioRef.current;
        if (!audio) {
          audio = new Audio();
          audioRef.current = audio;
        }
        audio.preservesPitch = true;
        // @ts-expect-error vendor prefix
        audio.mozPreservesPitch = true;
        // @ts-expect-error vendor prefix
        audio.webkitPreservesPitch = true;
        audio.playbackRate = rateRef.current;
        audio.src = url;
        audio.onloadedmetadata = () => {
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            setPlayDur(audio.duration);
          }
        };
        audio.onended = () => {
          setPlaying(false);
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            setPlayTime(audio.duration);
          }
          if (autoPlayRef.current) {
            const next = playIdxRef.current + 1;
            if (next < filtered.length) {
              void playAt(next);
            } else {
              setAutoPlay(false);
            }
          }
        };
        await audio.play();
        setPlaying(true);
        virtualizer.scrollToIndex(idx, { align: "center" });
      } catch (e) {
        setStatus(`再生失敗: ${e}`);
        setPlaying(false);
      }
    },
    [filtered, stopAudio, virtualizer],
  );

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const a = audioRef.current;
      if (!a || seekingRef.current) return;
      setPlayTime(a.currentTime);
      if (Number.isFinite(a.duration) && a.duration > 0) {
        setPlayDur(a.duration);
      }
    }, 80);
    return () => window.clearInterval(id);
  }, [playing]);

  const seekPlaying = (time: number) => {
    const a = audioRef.current;
    const dur = playDur > 0 ? playDur : a?.duration ?? 0;
    if (!a || !(dur > 0)) return;
    const t = Math.min(dur, Math.max(0, time));
    a.currentTime = t;
    setPlayTime(t);
  };

  const toggleRowPlay = useCallback(
    (idx: number) => {
      if (idx === playIdxRef.current && audioRef.current?.src) {
        if (playing) pauseAudio();
        else {
          void resumeAudio().then((ok) => {
            if (!ok) void playAt(idx);
          });
        }
        return;
      }
      void playAt(idx);
    },
    [pauseAudio, playAt, playing, resumeAudio],
  );

  useEffect(() => {
    const a = audioRef.current;
    if (a) {
      a.playbackRate = rate;
      a.preservesPitch = true;
    }
  }, [rate]);

  const toggleFlag = useCallback(
    (file: string) => {
      if (readOnly) return;
      const prev = exclusions[file] || {};
      const flagged = !prev.flagged;
      const next = {
        ...exclusions,
        [file]: { ...prev, flagged, aspects: prev.aspects || [] },
      };
      void persistExclusions(next);
    },
    [exclusions, persistExclusions, readOnly],
  );

  const applyExcludedFromFlags = useCallback(() => {
    if (readOnly) return;
    const next = { ...exclusions };
    for (const [k, v] of Object.entries(next)) {
      if (v.flagged) {
        next[k] = {
          ...v,
          excluded: true,
          source: v.source || "manual",
        };
      }
    }
    void persistExclusions(next);
  }, [exclusions, persistExclusions, readOnly]);

  const flagAllInTab = useCallback(() => {
    if (readOnly || tab === "all") return;
    const next = { ...exclusions };
    for (const row of filtered) {
      const prev = next[row.file] || {};
      next[row.file] = {
        ...prev,
        flagged: true,
        aspects: Array.from(
          new Set([...(prev.aspects || []), tab]),
        ),
      };
    }
    void persistExclusions(next);
  }, [exclusions, filtered, persistExclusions, readOnly, tab]);

  const eligibleForOutlierFlag = useMemo(
    () => slices.filter((s) => !exclusions[s.file]?.excluded),
    [slices, exclusions],
  );

  const topOutlierCount = useMemo(() => {
    const n = eligibleForOutlierFlag.length;
    if (n === 0) return 0;
    const pct = Math.min(90, Math.max(1, flagPct));
    return Math.min(n, Math.max(1, Math.ceil((n * pct) / 100)));
  }, [eligibleForOutlierFlag, flagPct]);

  const flagTopOutlierPercent = useCallback(() => {
    if (readOnly || topOutlierCount <= 0) return;
    const ranked = [...eligibleForOutlierFlag].sort(
      (a, b) => (b.outlierScore ?? 0) - (a.outlierScore ?? 0),
    );
    const next = { ...exclusions };
    for (const row of ranked.slice(0, topOutlierCount)) {
      const prev = next[row.file] || {};
      next[row.file] = {
        ...prev,
        flagged: true,
        source: prev.source || "outlier-pct",
        aspects: prev.aspects || [],
      };
    }
    void persistExclusions(next);
  }, [
    eligibleForOutlierFlag,
    exclusions,
    persistExclusions,
    readOnly,
    topOutlierCount,
  ]);

  const restoreFile = useCallback(
    (file: string) => {
      if (readOnly) return;
      const prev = exclusions[file] || {};
      void persistExclusions({
        ...exclusions,
        [file]: { ...prev, excluded: false, flagged: false },
      });
    },
    [exclusions, persistExclusions, readOnly],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (ev.key === " " || ev.code === "Space") {
        ev.preventDefault();
        toggleRowPlay(playIdxRef.current);
      } else if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
        ev.preventDefault();
        const next = Math.min(filtered.length - 1, playIdxRef.current + 1);
        void playAt(next);
      } else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        const next = Math.max(0, playIdxRef.current - 1);
        void playAt(next);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const row = filtered[playIdxRef.current];
        if (row) toggleFlag(row.file);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, playAt, toggleFlag, toggleRowPlay]);

  useEffect(() => () => stopAudio(), [stopAudio]);

  const excludedCount = useMemo(
    () => slices.filter((s) => exclusions[s.file]?.excluded).length,
    [slices, exclusions],
  );
  const remainingCount = Math.max(0, slices.length - excludedCount);
  const flaggedCount = useMemo(
    () =>
      slices.filter(
        (s) => exclusions[s.file]?.flagged && !exclusions[s.file]?.excluded,
      ).length,
    [slices, exclusions],
  );

  const histBins = useMemo(() => {
    const bins = new Array(20).fill(0) as number[];
    for (const s of hist) {
      const i = Math.min(19, Math.max(0, Math.floor(s * 20)));
      bins[i] += 1;
    }
    const max = Math.max(1, ...bins);
    return bins.map((c) => c / max);
  }, [hist]);

  const continueTraining = async () => {
    if (readOnly) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      await invoke("save_slice_review_exclusions_cmd", {
        jobDir,
        exclusions,
      });
      await invoke("complete_slice_review_cmd", { jobDir });
      stopAudio();
      onContinue();
    } catch (e) {
      setStatus(String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className={`slice-review panel${reviewLog?.mode === "auto" ? " is-auto-mode" : ""}`}
      id="slice-review-panel"
    >
      <header className="panel-header">
        <h3>スライスレビュー</h3>
        <span className="hint">
          Space=再生/停止 · ←→=前後 · Enter=フラグ
        </span>
      </header>
      <div className="panel-body form-stack">
        <div className="slice-review-stats" aria-live="polite">
          <span className="slice-review-stat">
            全体
            <strong>{slices.length}</strong>
            <span className="slice-review-stat-unit">件</span>
          </span>
          <span
            className={`slice-review-stat${excludedCount > 0 ? " is-excluded" : ""}`}
          >
            除外済み
            <strong>{excludedCount}</strong>
            <span className="slice-review-stat-unit">件</span>
          </span>
          <span className="slice-review-stat is-remain">
            残り
            <strong>{remainingCount}</strong>
            <span className="slice-review-stat-unit">件（学習に使う）</span>
          </span>
          <span
            className={`slice-review-stat${flaggedCount > 0 ? " is-flagged" : ""}`}
          >
            フラグ中
            <strong>{flaggedCount}</strong>
            <span className="slice-review-stat-unit">件</span>
          </span>
        </div>
        {reviewLog && reviewLog.mode === "auto" && (
          <p className="param-altered-hint slice-review-auto-banner">
            auto で自動除外されています。オレンジの行が学習から外れたスライスです。
          </p>
        )}
        {reviewLog && (reviewLog.excludedCount ?? 0) > 0 && (
          <p className="hint">
            ログ: mode={reviewLog.mode} 除外={reviewLog.excludedCount}
            {reviewLog.byAspect
              ? ` （${Object.entries(reviewLog.byAspect)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(", ")}）`
              : ""}
          </p>
        )}
        <div className="row slice-review-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={tab === "all" ? "chip active" : "chip"}
            aria-selected={tab === "all"}
            onClick={() => {
              setTab("all");
              setPlayIdx(0);
            }}
          >
            全体 ({remainingCount}/{slices.length})
          </button>
          {ASPECTS.map((a) => {
            const n = slices.filter(
              (s) => s.flags?.[a] || s.hitAspects?.includes(a),
            ).length;
            return (
              <button
                key={a}
                type="button"
                role="tab"
                className={tab === a ? "chip active" : "chip"}
                aria-selected={tab === a}
                onClick={() => {
                  setTab(a);
                  setPlayIdx(0);
                }}
              >
                {a}:{ASPECT_LABELS[a]} ({n})
              </button>
            );
          })}
        </div>
        {tab === "F" && histBins.length > 0 && (
          <div className="slice-review-hist" title="話者類似度ヒストグラム">
            <span className="hint">話者類似度分布（二峰なら別人混入の可能性）</span>
            <div className="slice-review-hist-bars">
              {histBins.map((h, i) => (
                <div
                  key={i}
                  className="slice-review-hist-bar"
                  style={{ height: `${Math.max(4, h * 64)}px` }}
                />
              ))}
            </div>
          </div>
        )}
        <div className="row">
          <button
            type="button"
            disabled={filtered.length === 0}
            onClick={() => {
              setAutoPlay(true);
              void playAt(playIdx);
            }}
          >
            連続再生
          </button>
          <button
            type="button"
            disabled={!autoPlay && !playing}
            onClick={() => {
              setAutoPlay(false);
              stopAudio();
            }}
          >
            停止
          </button>
          <label className="row" style={{ gap: 6, alignItems: "center" }}>
            速度
            <select
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s.toFixed(2)}x
                </option>
              ))}
            </select>
          </label>
          <div className="slice-review-sort" role="group" aria-label="並び順">
              <button
                type="button"
                className={allSort === "outlier" ? "chip active" : "chip"}
                onClick={() => {
                  setAllSort("outlier");
                  setPlayIdx(0);
                }}
              >
                外れ値順
              </button>
              <button
                type="button"
                className={allSort === "name" ? "chip active" : "chip"}
                onClick={() => {
                  setAllSort("name");
                  setPlayIdx(0);
                }}
              >
                名前順
              </button>
            </div>
          {!readOnly && tab === "all" && (
            <label className="row slice-review-pct-flag">
              総合スコア上位
              <input
                type="number"
                min={1}
                max={90}
                step={1}
                value={flagPct}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v)) return;
                  setFlagPct(Math.min(90, Math.max(1, Math.round(v))));
                }}
                style={{ width: "4.5rem" }}
              />
              %
              <button
                type="button"
                disabled={topOutlierCount <= 0}
                onClick={flagTopOutlierPercent}
                title="除外済みを除き、外れ値スコアが高い順にフラグします（1〜90%）"
              >
                をフラグ（{topOutlierCount}件）
              </button>
            </label>
          )}
          {!readOnly && tab !== "all" && (
            <button type="button" onClick={flagAllInTab}>
              この観点の候補を全部フラグ
            </button>
          )}
          {!readOnly && (
            <button type="button" onClick={applyExcludedFromFlags}>
              フラグ済みを一括除外
            </button>
          )}
        </div>
        <div
          className="slice-review-list"
          ref={listParentRef}
          style={{ height: 360, overflow: "auto" }}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const row = filtered[vi.index];
              const meta = exclusions[row.file] || {};
              const active = vi.index === playIdx;
              const rowPlaying = active && playing;
              const showSeek = active && playDur > 0;
              const remainSec =
                showSeek && rate > 0
                  ? Math.max(0, (playDur - playTime) / rate)
                  : 0;
              return (
                <div
                  key={row.file}
                  className={[
                    "slice-review-row",
                    active ? "playing" : "",
                    meta.excluded ? "excluded" : "",
                    meta.flagged ? "flagged" : "",
                    meta.excluded &&
                    (meta.source === "auto" || meta.source === "auto-score")
                      ? "auto-excluded"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: vi.size,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <button
                    type="button"
                    className="slice-review-play"
                    onClick={() => toggleRowPlay(vi.index)}
                    title={rowPlaying ? "一時停止" : "再生"}
                  >
                    {rowPlaying ? "❚❚" : "▶"}
                  </button>
                  <div className="slice-review-meta">
                    <strong>{row.file}</strong>
                    <span className="hint">
                      {row.duration?.toFixed(2)}s · 外れ値=
                      {(row.outlierScore ?? 0).toFixed(2)} · hit=
                      {row.hitCount ?? 0}
                      {row.hitAspects?.length
                        ? ` [${row.hitAspects
                            .map((id) => formatHitAspect(id, row))
                            .join(",")}]`
                        : ""}
                      {row.speakerSim != null
                        ? ` · sim=${row.speakerSim.toFixed(2)}`
                        : ""}
                      {row.lufs != null ? ` · ${row.lufs.toFixed(1)} LUFS` : ""}
                    </span>
                  </div>
                  {!readOnly && (
                    <div className="row">
                      <button
                        type="button"
                        className={meta.flagged ? "danger" : undefined}
                        onClick={() => toggleFlag(row.file)}
                      >
                        {meta.flagged ? "フラグ済" : "フラグ"}
                      </button>
                      {meta.excluded ? (
                        <button type="button" onClick={() => restoreFile(row.file)}>
                          復帰
                        </button>
                      ) : null}
                    </div>
                  )}
                  {showSeek && (
                    <div className="slice-review-seek">
                      <input
                        type="range"
                        min={0}
                        max={playDur}
                        step={0.01}
                        value={Math.min(playTime, playDur)}
                        aria-label="再生位置"
                        onPointerDown={() => {
                          seekingRef.current = true;
                        }}
                        onChange={(e) => {
                          seekPlaying(Number(e.target.value));
                        }}
                        onPointerUp={() => {
                          seekingRef.current = false;
                        }}
                      />
                      <span className="slice-review-seek-time">
                        {playTime.toFixed(1)} / {playDur.toFixed(1)}s
                        {rowPlaying ? ` · 残り ${remainSec.toFixed(1)}秒` : ""}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="row">
          {!readOnly && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void continueTraining()}
            >
              {busy
                ? "続行中…"
                : `学習を続ける（残り ${remainingCount} 件）`}
            </button>
          )}
          <button type="button" disabled={busy} onClick={onCancel}>
            {readOnly ? "閉じる" : "キャンセル"}
          </button>
          <span className="status-text">{status}</span>
        </div>
      </div>
    </div>
  );
}
