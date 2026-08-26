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
  autoFix?: {
    ops?: string[];
    changed?: boolean;
    c50?: number | null;
    rt60?: number | null;
    tilt?: number | null;
    snr?: number | null;
    batchReverb?: boolean;
    batchMuffle?: boolean;
    backupDir?: string;
  };
};

type ExclusionMeta = {
  excluded?: boolean;
  flagged?: boolean;
  source?: string;
  aspects?: string[];
  /** true = use pre-Auto-Fix backup for listen + training */
  autoFixOff?: boolean;
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

const AUTOFIX_OP_LABELS: Record<string, string> = {
  wpe: "WPE",
  late: "後期残響",
  tilt: "tilt EQ",
  box: "箱鳴りEQ",
  hp: "HP",
  denoise: "NR",
  declip: "デクリップ",
};

function backupPathFor(jobDir: string, row: SliceMetricsRow): string {
  const dir = (row.autoFix?.backupDir || "").trim();
  const base = (dir || `${jobDir.replace(/[\\/]+$/, "")}/sliced_pre_autofix`).replace(
    /[\\/]+$/,
    "",
  );
  return `${base}/${row.file}`;
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
  const [autoFixLog, setAutoFixLog] = useState<{
    changedCount?: number;
    total?: number;
    backupDir?: string;
    batch?: {
      reverb?: boolean;
      muffle?: boolean;
      medianC50?: number;
      medianRt60?: number;
    };
  } | null>(null);
  const [tab, setTab] = useState<"all" | SliceReviewAspectId>("all");
  const [allSort, setAllSort] = useState<"outlier" | "name">("outlier");
  const [flagPct, setFlagPct] = useState(5);
  const [playIdx, setPlayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadedFile, setLoadedFile] = useState<string | null>(null);
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
  const loadedFileRef = useRef<string | null>(null);
  const playGenRef = useRef(0);
  const exclusionsRef = useRef(exclusions);
  exclusionsRef.current = exclusions;

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
      const af = await invoke<{
        changedCount?: number;
        total?: number;
        backupDir?: string;
        batch?: {
          reverb?: boolean;
          muffle?: boolean;
          medianC50?: number;
          medianRt60?: number;
        };
      }>("load_slice_autofix_log_cmd", { jobDir });
      setSlices(Array.isArray(metrics?.slices) ? metrics.slices : []);
      setHist(
        Array.isArray(metrics?.speakerSimHistogram)
          ? metrics.speakerSimHistogram
          : [],
      );
      setExclusions(excl && typeof excl === "object" ? excl : {});
      setReviewLog(log || null);
      setAutoFixLog(
        af && typeof af === "object" && typeof af.total === "number" ? af : null,
      );
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

  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listParentRef.current,
    estimateSize: (index) => {
      const row = filtered[index];
      const extra = row?.autoFix?.changed ? 22 : 0;
      return (row && loadedFile === row.file && playDur > 0 ? 78 : 52) + extra;
    },
    overscan: 12,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [loadedFile, playDur, exclusions, virtualizer]);

  const clearAudioElement = useCallback(() => {
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
  }, []);

  const stopAudio = useCallback(() => {
    playGenRef.current += 1;
    loadedFileRef.current = null;
    clearAudioElement();
    setLoadedFile(null);
    setPlaying(false);
    setPlayTime(0);
    setPlayDur(0);
  }, [clearAudioElement]);

  const resetPlaybackForListChange = useCallback(() => {
    setAutoPlay(false);
    stopAudio();
    setPlayIdx(0);
    listParentRef.current?.scrollTo({ top: 0 });
  }, [stopAudio]);

  const pauseAudio = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(false);
    setAutoPlay(false);
  }, []);

  const resumeAudio = useCallback(async () => {
    const a = audioRef.current;
    if (!a?.src || !loadedFileRef.current) return false;
    const file = loadedFileRef.current;
    try {
      await a.play();
      if (loadedFileRef.current !== file) {
        a.pause();
        return false;
      }
      setPlaying(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  const playAt = useCallback(
    async (idx: number) => {
      const row = filteredRef.current[idx];
      if (!row) return;
      const gen = ++playGenRef.current;
      clearAudioElement();
      setPlaying(false);
      setPlayTime(0);
      setPlayIdx(idx);
      loadedFileRef.current = row.file;
      setLoadedFile(row.file);
      setPlayDur(row.duration && row.duration > 0 ? row.duration : 0);
      try {
        let path = row.path;
        const useOrig =
          !!row.autoFix?.changed &&
          !!exclusionsRef.current[row.file]?.autoFixOff;
        if (useOrig) {
          const bak = backupPathFor(jobDir, row);
          const exists = await invoke<boolean>("file_exists", { path: bak });
          if (exists) path = bak;
        }
        const bytes = await invoke<number[]>("read_file_bytes", {
          path,
        });
        if (gen !== playGenRef.current) return;
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
          if (gen !== playGenRef.current) return;
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            setPlayDur(audio.duration);
          }
        };
        audio.onended = () => {
          if (gen !== playGenRef.current) return;
          setPlaying(false);
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            setPlayTime(audio.duration);
          }
          if (autoPlayRef.current) {
            const list = filteredRef.current;
            const current = list.findIndex((r) => r.file === row.file);
            const next = (current >= 0 ? current : idx) + 1;
            if (next < list.length) {
              void playAt(next);
            } else {
              setAutoPlay(false);
            }
          }
        };
        await audio.play();
        if (gen !== playGenRef.current) {
          audio.pause();
          return;
        }
        setPlaying(true);
        virtualizer.scrollToIndex(idx, { align: "center" });
      } catch (e) {
        if (gen !== playGenRef.current) return;
        setStatus(`再生失敗: ${e}`);
        setPlaying(false);
        loadedFileRef.current = null;
        setLoadedFile(null);
        setPlayDur(0);
      }
    },
    [clearAudioElement, jobDir, virtualizer],
  );

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const a = audioRef.current;
      if (!a || seekingRef.current || !loadedFileRef.current) return;
      setPlayTime(a.currentTime);
      if (Number.isFinite(a.duration) && a.duration > 0) {
        setPlayDur(a.duration);
      }
    }, 80);
    return () => window.clearInterval(id);
  }, [playing]);

  const seekPlaying = (time: number, file: string) => {
    if (loadedFileRef.current !== file) return;
    const a = audioRef.current;
    const dur = playDur > 0 ? playDur : a?.duration ?? 0;
    if (!a?.src || !(dur > 0)) return;
    const t = Math.min(dur, Math.max(0, time));
    a.currentTime = t;
    setPlayTime(t);
  };

  const toggleRowPlay = useCallback(
    (idx: number) => {
      const row = filteredRef.current[idx];
      if (!row) return;
      if (loadedFileRef.current === row.file && audioRef.current?.src) {
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
    const file = loadedFileRef.current;
    if (!file) {
      if (playIdxRef.current >= filtered.length) setPlayIdx(0);
      return;
    }
    const i = filtered.findIndex((r) => r.file === file);
    if (i < 0) {
      setAutoPlay(false);
      stopAudio();
      setPlayIdx(0);
      return;
    }
    if (i !== playIdxRef.current) setPlayIdx(i);
  }, [filtered, stopAudio]);

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
    const cursorIdx = () => {
      const file = loadedFileRef.current;
      if (file) {
        const i = filteredRef.current.findIndex((r) => r.file === file);
        if (i >= 0) return i;
      }
      return playIdxRef.current;
    };
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const list = filteredRef.current;
      if (ev.key === " " || ev.code === "Space") {
        ev.preventDefault();
        toggleRowPlay(cursorIdx());
      } else if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
        ev.preventDefault();
        const next = Math.min(list.length - 1, cursorIdx() + 1);
        if (next >= 0) void playAt(next);
      } else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        const next = Math.max(0, cursorIdx() - 1);
        void playAt(next);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const row = list[cursorIdx()];
        if (row) toggleFlag(row.file);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playAt, toggleFlag, toggleRowPlay]);

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
  const autoFixedCount = useMemo(
    () => slices.filter((s) => s.autoFix?.changed).length,
    [slices],
  );
  const autoFixOffCount = useMemo(
    () =>
      slices.filter((s) => s.autoFix?.changed && exclusions[s.file]?.autoFixOff)
        .length,
    [slices, exclusions],
  );

  const reloadIfLoaded = (file: string) => {
    const i = filteredRef.current.findIndex((r) => r.file === file);
    if (i < 0 || loadedFileRef.current !== file) return;
    const t = audioRef.current?.currentTime ?? 0;
    const wasPlaying = playing;
    void playAt(i).then(() => {
      const a = audioRef.current;
      if (!a || loadedFileRef.current !== file) return;
      if (t > 0 && Number.isFinite(a.duration) && t < a.duration) {
        a.currentTime = t;
        setPlayTime(t);
      }
      if (!wasPlaying) {
        a.pause();
        setPlaying(false);
      }
    });
  };

  const toggleAutoFix = (file: string) => {
    if (readOnly) return;
    const row = slices.find((s) => s.file === file);
    if (!row?.autoFix?.changed) return;
    const prev = exclusions[file] || {};
    const next = {
      ...exclusions,
      [file]: { ...prev, autoFixOff: !prev.autoFixOff },
    };
    exclusionsRef.current = next;
    void persistExclusions(next);
    reloadIfLoaded(file);
  };

  const setAllAutoFixOff = (off: boolean) => {
    if (readOnly) return;
    const next = { ...exclusions };
    for (const row of slices) {
      if (!row.autoFix?.changed) continue;
      const prev = next[row.file] || {};
      next[row.file] = { ...prev, autoFixOff: off };
    }
    exclusionsRef.current = next;
    void persistExclusions(next);
    const file = loadedFileRef.current;
    if (file) reloadIfLoaded(file);
  };

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
        exclusions: exclusionsRef.current,
      });
      const reverted = await invoke<number>("complete_slice_review_cmd", {
        jobDir,
      });
      if (reverted > 0) {
        setStatus(`Auto Fix を ${reverted} 件、処理前に戻して続行します`);
      }
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
          Space=再生/停止 · ←→=前後 · Enter=フラグ · Auto Fix ON/OFF=処理前後
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
          <span
            className={`slice-review-stat${autoFixedCount > 0 ? " is-autofix" : ""}`}
          >
            Auto Fix
            <strong>{autoFixedCount - autoFixOffCount}</strong>
            <span className="slice-review-stat-unit">
              /{autoFixedCount} 件
            </span>
          </span>
        </div>
        {autoFixLog && (autoFixLog.changedCount ?? autoFixedCount) > 0 && (
          <p className="hint">
            Auto Fix: {autoFixLog.changedCount ?? autoFixedCount}/
            {autoFixLog.total ?? slices.length} 件を処理
            {autoFixLog.batch?.reverb ? " · セッション残響あり（WPE）" : ""}
            {autoFixLog.batch?.muffle ? " · セッションこもりあり（EQ）" : ""}
            {autoFixLog.batch?.medianC50 != null
              ? ` · 中央DRR ${autoFixLog.batch.medianC50.toFixed(1)} dB`
              : ""}
            {autoFixOffCount > 0
              ? ` · ${autoFixOffCount} 件は処理前のまま学習します`
              : ""}
            。行の Auto Fix を切り替えて聞き比べできます。
          </p>
        )}
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
              if (tab === "all") return;
              resetPlaybackForListChange();
              setTab("all");
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
                  if (tab === a) return;
                  resetPlaybackForListChange();
                  setTab(a);
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
                  if (allSort === "outlier") return;
                  resetPlaybackForListChange();
                  setAllSort("outlier");
                }}
              >
                外れ値順
              </button>
              <button
                type="button"
                className={allSort === "name" ? "chip active" : "chip"}
                onClick={() => {
                  if (allSort === "name") return;
                  resetPlaybackForListChange();
                  setAllSort("name");
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
          {autoFixedCount > 0 && !readOnly && (
            <>
              <button
                type="button"
                className={autoFixOffCount === autoFixedCount ? "chip active" : "chip"}
                disabled={busy || autoFixOffCount === autoFixedCount}
                onClick={() => setAllAutoFixOff(true)}
                title="Auto Fix 済みをすべて処理前に戻します（続行時に学習へ反映）"
              >
                すべて処理前
              </button>
              <button
                type="button"
                className={autoFixOffCount === 0 ? "chip active" : "chip"}
                disabled={busy || autoFixOffCount === 0}
                onClick={() => setAllAutoFixOff(false)}
                title="すべて Auto Fix 後の音に戻します"
              >
                すべて Auto Fix
              </button>
            </>
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
              const isLoaded = loadedFile === row.file;
              const active = isLoaded || (!loadedFile && vi.index === playIdx);
              const rowPlaying = isLoaded && playing;
              const showSeek = isLoaded && playDur > 0;
              const autoFixed = !!row.autoFix?.changed;
              const autoFixOff = autoFixed && !!meta.autoFixOff;
              const remainSec =
                showSeek && rate > 0
                  ? Math.max(0, (playDur - playTime) / rate)
                  : 0;
              return (
                <div
                  key={`${tab}:${row.file}`}
                  className={[
                    "slice-review-row",
                    active ? "playing" : "",
                    meta.excluded ? "excluded" : "",
                    meta.flagged ? "flagged" : "",
                    meta.excluded &&
                    (meta.source === "auto" || meta.source === "auto-score")
                      ? "auto-excluded"
                      : "",
                    autoFixOff ? "autofix-off" : "",
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
                    {autoFixed && (
                      <span className="slice-review-ops">
                        {(row.autoFix?.ops || []).map((op) => (
                          <span key={op} className="slice-review-op">
                            {AUTOFIX_OP_LABELS[op] || op}
                          </span>
                        ))}
                        {autoFixOff ? (
                          <span className="slice-review-op is-orig">処理前</span>
                        ) : (
                          <span className="slice-review-op">Auto Fix</span>
                        )}
                      </span>
                    )}
                  </div>
                  {!readOnly && (
                    <div className="row">
                      {autoFixed && (
                        <button
                          type="button"
                          className={
                            autoFixOff
                              ? "slice-review-autofix-btn is-off"
                              : "slice-review-autofix-btn is-on"
                          }
                          disabled={busy}
                          onClick={() => toggleAutoFix(row.file)}
                          title={
                            autoFixOff
                              ? "いまは処理前。ONにすると Auto Fix 後の音で学習します"
                              : "いまは Auto Fix 後。OFFにすると処理前の音で学習します"
                          }
                        >
                          {autoFixOff ? "Auto Fix OFF" : "Auto Fix ON"}
                        </button>
                      )}
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
                          seekPlaying(Number(e.target.value), row.file);
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
                : `学習を続ける（残り ${remainingCount} 件${
                    autoFixOffCount > 0
                      ? ` · 処理前 ${autoFixOffCount}`
                      : ""
                  }）`}
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
