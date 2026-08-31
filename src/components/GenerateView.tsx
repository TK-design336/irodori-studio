import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  AppSettings,
  ExportAudioFormat,
  Project,
  ProjectLine,
  SamplingParams,
  SpeakerInfo,
} from "../types";
import {
  defaultSampling,
  newLineId,
  speakerConditionKey,
  speakerOptionLabel,
  activePaths,
  isIrodoriV4,
  lineCfgScaleCaption,
  DEFAULT_CFG_SCALE_CAPTION,
  asrCerWarnThreshold,
  generateCompactLinesOf,
  samplingEqualIgnoringSeed,
  normalizeLineVariants,
  syncLineWavPath,
  wavPathBelongsToLine,
  backfillLineVariants,
  inheritLineGeneration,
  newVariantId,
  clampCandidateCount,
  MAX_LINE_VARIANTS,
  multiGenerateModeOf,
  audioFxOf,
  type LineVariant,
} from "../types";
import { SamplingPanel } from "./SamplingPanel";
import { AudioAdjustmentPanel } from "./AudioAdjustmentPanel";
import { CaptionPanel } from "./CaptionPanel";
import { BulkAddDialog } from "./BulkAddDialog";
import { isSupportedDocFile, filesFromDataTransfer, acceptFileDrag } from "../lib/docImport/index";
import { AnnotationReviewDialog, type NumericConvertModes } from "./AnnotationReviewDialog";
import { AnnotationOverlay } from "./AnnotationOverlay";
import { BoundedSelect } from "./BoundedSelect";
import { SpeakerSelect } from "./SpeakerSelect";
import { EmojiPalette } from "./EmojiPalette";
import { BatchMoreMenu } from "./BatchMoreMenu";
import { lineExportFileName } from "../lib/exportFileName";
import {
  EXPORT_AUDIO_FORMAT_LABELS,
  EXPORT_AUDIO_FORMATS,
  exportAudioExt,
  exportAudioFormatOf,
  exportBitrateKbps,
  exportDialogFilters,
  formatFromDestPath,
  withAudioExt,
} from "../lib/exportAudio";
import { reconcileProjectSpeakers } from "../lib/speakerResolve";
import { SpeakerApplyMenu } from "./SpeakerApplyMenu";
import { IconSave, IconTrash } from "./icons";
import { LineAudioPlayer, type PlaybackSnapshot } from "../lib/audioPlayer";
import type { ImportedLine } from "../lib/scriptImport";
import {
  applyAutoReplacements,
  previewReplacements,
  type ReplaceEntry,
  type ReplaceSnippet,
} from "../lib/replaceApply";
import {
  DICTS_CHANGED_EVENT,
  emitDictionariesChanged,
  upsertReadingDictExtra,
  type Dictionaries,
} from "../lib/dictionaries";
import {
  filterPendingAnnotations,
  isNovelCandidate,
  newReadingId,
  normalizeDetectedAnnotations,
  readingForApply,
  synthTextForLine,
  validateReadings,
  type AnnotationKind,
  type AppliedReading,
  type DetectedAnnotation,
} from "../lib/annotations";
import {
  buildLabelTrack,
  buildSrt,
  buildVtt,
  cuesFromDurations,
} from "../lib/subtitleExport";
type Props = {
  speakers: SpeakerInfo[];
  settings: AppSettings;
  project: Project | null;
  openProjects: Project[];
  projectNameDraft: string;
  onProjectChange: (p: Project | null) => void;
  onOpenProjectsChange: (projects: Project[]) => void;
  onActiveProjectChange: (name: string | null) => void;
  onProjectNameDraft: (name: string) => void;
};

function lineCaptionOf(line: ProjectLine): string {
  return line.caption ?? "";
}

function speakerOf(
  speakers: SpeakerInfo[],
  embedPath: string,
): SpeakerInfo | undefined {
  return speakers.find((s) => s.embedPath === embedPath);
}

function lineSpeakerDisplayLabel(
  line: ProjectLine,
  speakers: SpeakerInfo[],
): string | undefined {
  const sp = speakerOf(speakers, line.speakerEmbedPath);
  if (sp) return speakerOptionLabel(sp);
  const name = line.speakerName.trim();
  if (name && !/[\\/]/.test(name) && !/^[a-zA-Z]:/.test(name)) return name;
  return undefined;
}

/** Style caption UI / synth for v4 speakers (ref + embed kinds all support caption). */
function usesStyleCaption(speaker: SpeakerInfo | null | undefined): boolean {
  const k = speaker?.kind;
  return k === "ref" || k === "trained" || k === "blend";
}

function effectiveLineCaption(
  line: ProjectLine,
  speakers: SpeakerInfo[],
): string {
  return usesStyleCaption(speakerOf(speakers, line.speakerEmbedPath))
    ? lineCaptionOf(line)
    : "";
}

function effectiveCfgScaleCaption(
  line: ProjectLine,
  speakers: SpeakerInfo[],
): number {
  return usesStyleCaption(speakerOf(speakers, line.speakerEmbedPath))
    ? lineCfgScaleCaption(line)
    : DEFAULT_CFG_SCALE_CAPTION;
}

function lineSynthText(line: ProjectLine): string {
  return synthTextForLine(line.text, line.readings);
}

type VariantGenerationSnap = {
  generatedText: string;
  generatedSpeakerEmbedPath: string;
  generatedCaption: string;
  generatedCfgScaleCaption: number;
  generatedSampling: SamplingParams;
};

function generationSnap(
  text: string,
  speakerKey: string,
  caption: string,
  cfgScaleCaption: number,
  sampling: SamplingParams,
): VariantGenerationSnap {
  return {
    generatedText: text,
    generatedSpeakerEmbedPath: speakerKey,
    generatedCaption: caption,
    generatedCfgScaleCaption: cfgScaleCaption,
    generatedSampling: generatedSamplingSnapshot(sampling),
  };
}

function stampVariantGeneration(
  variant: LineVariant,
  snap: VariantGenerationSnap,
): LineVariant {
  return { ...variant, ...snap };
}

type DirtyDiff = {
  label: string;
  from: string;
  to: string;
};

function truncateDiffText(s: string, max = 56): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return "（空）";
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function displayPathTail(path: string): string {
  if (!path) return "（なし）";
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function formatDiffNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

function formatDiffSeconds(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "自動";
  return `${v}秒`;
}

function formatTSchedule(mode: string): string {
  if (mode === "sway") return "Sway";
  if (mode === "linear") return "線形";
  return mode || "（空）";
}

function formatCfgMode(mode: string): string {
  if (mode === "independent") return "独立";
  if (mode === "joint") return "一括";
  if (mode === "alternating") return "交互";
  return mode || "（空）";
}

function parseSpeakerConditionKey(key: string): {
  kind: "embed" | "ref" | "caption";
  embedPath: string;
  extra: string;
} {
  if (key.startsWith("ref\0")) {
    const rest = key.slice("ref\0".length);
    const i = rest.indexOf("\0");
    if (i >= 0) {
      return {
        kind: "ref",
        embedPath: rest.slice(0, i),
        extra: rest.slice(i + 1),
      };
    }
    return { kind: "ref", embedPath: rest, extra: "" };
  }
  if (key.startsWith("caption\0")) {
    const rest = key.slice("caption\0".length);
    const i = rest.indexOf("\0");
    if (i >= 0) {
      return {
        kind: "caption",
        embedPath: rest.slice(0, i),
        extra: rest.slice(i + 1),
      };
    }
    return { kind: "caption", embedPath: rest, extra: "" };
  }
  return { kind: "embed", embedPath: key, extra: "" };
}

function speakerConditionDisplay(
  speakers: SpeakerInfo[],
  key: string,
): string {
  if (!key) return "（なし）";
  const parsed = parseSpeakerConditionKey(key);
  const sp = speakers.find((s) => s.embedPath === parsed.embedPath);
  const name = sp
    ? speakerOptionLabel(sp)
    : displayPathTail(parsed.embedPath);
  if (parsed.kind === "ref") {
    const wav = displayPathTail(parsed.extra);
    return wav !== "（なし）" ? `${name} / ${wav}` : name;
  }
  if (parsed.kind === "caption" && parsed.extra) {
    return `${name} / ${truncateDiffText(parsed.extra, 32)}`;
  }
  return name || "（なし）";
}

function samplingDirtyDiffs(
  current: SamplingParams,
  generated: SamplingParams,
): DirtyDiff[] {
  const diffs: DirtyDiff[] = [];
  const add = (label: string, from: string, to: string) => {
    if (from !== to) diffs.push({ label, from, to });
  };
  add("ステップ数", formatDiffNum(generated.numSteps), formatDiffNum(current.numSteps));
  add("長さ", formatDiffSeconds(generated.seconds), formatDiffSeconds(current.seconds));
  add(
    "長さ倍率",
    formatDiffNum(generated.durationScale),
    formatDiffNum(current.durationScale),
  );
  add(
    "時間スケジュール",
    formatTSchedule(generated.tScheduleMode),
    formatTSchedule(current.tScheduleMode),
  );
  add("Sway係数", formatDiffNum(generated.swayCoeff), formatDiffNum(current.swayCoeff));
  add(
    "CFG方式",
    formatCfgMode(generated.cfgGuidanceMode),
    formatCfgMode(current.cfgGuidanceMode),
  );
  add(
    "テキスト強度",
    formatDiffNum(generated.cfgScaleText),
    formatDiffNum(current.cfgScaleText),
  );
  add(
    "話者強度",
    formatDiffNum(generated.cfgScaleSpeaker),
    formatDiffNum(current.cfgScaleSpeaker),
  );
  return diffs;
}

function variantDirtyDiffs(
  line: ProjectLine,
  variant: LineVariant,
  speakers: SpeakerInfo[],
): DirtyDiff[] {
  const diffs: DirtyDiff[] = [];
  if (!wavPathMatchesLine(line, variant.wavPath)) {
    diffs.push({
      label: "WAV",
      from: variant.wavPath ? displayPathTail(variant.wavPath) : "（なし）",
      to: "この行のものではない",
    });
  }
  const genText = variant.generatedText ?? line.generatedText ?? "";
  const curText = lineSynthText(line);
  if (genText !== curText) {
    diffs.push({
      label: "テキスト",
      from: truncateDiffText(genText),
      to: truncateDiffText(curText),
    });
  }
  const curSpeaker = speakerConditionKey(speakers, line.speakerEmbedPath);
  const genSpeaker =
    variant.generatedSpeakerEmbedPath ?? line.generatedSpeakerEmbedPath ?? "";
  if (genSpeaker !== curSpeaker) {
    const genP = parseSpeakerConditionKey(genSpeaker);
    const curP = parseSpeakerConditionKey(curSpeaker);
    if (genP.embedPath && genP.embedPath === curP.embedPath) {
      if (genP.kind === "ref" || curP.kind === "ref") {
        diffs.push({
          label: "参照音源",
          from: displayPathTail(genP.extra),
          to: displayPathTail(curP.extra),
        });
      } else if (genP.kind === "caption" || curP.kind === "caption") {
        diffs.push({
          label: "話者キャプション",
          from: truncateDiffText(genP.extra),
          to: truncateDiffText(curP.extra),
        });
      } else {
        diffs.push({
          label: "話者",
          from: speakerConditionDisplay(speakers, genSpeaker),
          to: speakerConditionDisplay(speakers, curSpeaker),
        });
      }
    } else {
      diffs.push({
        label: "話者",
        from: speakerConditionDisplay(speakers, genSpeaker),
        to: speakerConditionDisplay(speakers, curSpeaker),
      });
    }
  }
  const curCaption = effectiveLineCaption(line, speakers);
  const genCaption = variant.generatedCaption ?? line.generatedCaption ?? "";
  if (genCaption !== curCaption) {
    diffs.push({
      label: "キャプション",
      from: truncateDiffText(genCaption),
      to: truncateDiffText(curCaption),
    });
  }
  if (curCaption || genCaption) {
    const genCfg =
      variant.generatedCfgScaleCaption ??
      line.generatedCfgScaleCaption ??
      DEFAULT_CFG_SCALE_CAPTION;
    const curCfg = effectiveCfgScaleCaption(line, speakers);
    if (genCfg !== curCfg) {
      diffs.push({
        label: "キャプション強度",
        from: formatDiffNum(genCfg),
        to: formatDiffNum(curCfg),
      });
    }
  }
  const genSampling = variant.generatedSampling ?? line.generatedSampling;
  if (
    genSampling != null &&
    !samplingEqualIgnoringSeed(line.sampling, genSampling)
  ) {
    diffs.push(...samplingDirtyDiffs(line.sampling, genSampling));
  }
  return diffs;
}

function dirtyDiffKey(diffs: DirtyDiff[]): string {
  return diffs.map((d) => `${d.label}\0${d.from}\0${d.to}`).join("\n");
}

function lineDirtyGroups(
  line: ProjectLine,
  speakers: SpeakerInfo[],
): { title: string; diffs: DirtyDiff[] }[] {
  const variants = normalizeLineVariants(line);
  const listed =
    variants.length > 0
      ? variants
      : line.wavPath
        ? [{ id: line.id, seed: 0, wavPath: line.wavPath }]
        : [];
  const groups = listed
    .map((v, i) => ({
      title: `音声 ${i + 1}`,
      diffs: variantDirtyDiffs(line, v, speakers),
    }))
    .filter((g) => g.diffs.length > 0);
  if (groups.length === 0) return [];
  const allSame =
    groups.length === listed.length &&
    groups.every((g) => dirtyDiffKey(g.diffs) === dirtyDiffKey(groups[0].diffs));
  if (groups.length === 1 || allSame) {
    return [{ title: "", diffs: groups[0].diffs }];
  }
  return groups;
}

function isVariantDirty(
  line: ProjectLine,
  variant: LineVariant,
  speakers: SpeakerInfo[],
): boolean {
  return variantDirtyDiffs(line, variant, speakers).length > 0;
}

function isDirty(
  line: ProjectLine,
  speakers: SpeakerInfo[],
): boolean {
  const variants = normalizeLineVariants(line);
  if (variants.length === 0 && !line.wavPath) return true;
  if (variants.length === 0) {
    return isVariantDirty(
      line,
      { id: line.id, seed: 0, wavPath: line.wavPath ?? "" },
      speakers,
    );
  }
  return variants.some((v) => isVariantDirty(line, v, speakers));
}

/** Line-level 要再生成: every held WAV is stale. Mixed lines stay on per-track stale UI. */
function allHeldAudioDirty(
  line: ProjectLine,
  speakers: SpeakerInfo[],
): boolean {
  const variants = normalizeLineVariants(line);
  if (variants.length === 0) {
    if (!line.wavPath) return false;
    return isVariantDirty(
      line,
      { id: line.id, seed: 0, wavPath: line.wavPath },
      speakers,
    );
  }
  return variants.every((v) => isVariantDirty(line, v, speakers));
}

/** Persist a novel reading to the reading dict only if it is not already a candidate. */
async function persistNovelReadingDict(
  specs: {
    kind: string;
    surface: string;
    reading: string;
    candidateReadings: string[];
  }[],
): Promise<void> {
  let dicts: Dictionaries;
  try {
    dicts = await invoke<Dictionaries>("get_dictionaries");
  } catch {
    return;
  }
  let reading = dicts.reading ?? [];
  let changed = false;
  for (const s of specs) {
    const kind = s.kind as AnnotationKind;
    if (kind !== "english" && kind !== "heteronym" && kind !== "numeric") continue;
    const value = s.reading.trim();
    if (!value || s.candidateReadings.includes(value)) continue;
    const next = upsertReadingDictExtra(reading, kind, s.surface, value);
    if (next !== reading) {
      reading = next;
      changed = true;
    }
  }
  if (!changed) return;
  try {
    await invoke("set_dictionaries", { dicts: { ...dicts, reading } });
    emitDictionariesChanged();
  } catch {
    /* dict extension is best-effort */
  }
}

/** Legacy projects: assume current sampling matches the existing wav. */
function backfillGeneratedSampling(p: Project): Project {
  let changed = false;
  const lines = p.lines.map((l) => {
    if (l.wavPath && l.generatedSampling == null) {
      changed = true;
      return { ...l, generatedSampling: { ...l.sampling, seed: null } };
    }
    return l;
  });
  return changed ? { ...p, lines } : p;
}

function backfillProject(p: Project): Project {
  return backfillLineVariants(backfillGeneratedSampling(p));
}

/** Apply new sampling; freeze prior values as the generation snapshot if missing. */
function withLineSampling(
  line: ProjectLine,
  next: SamplingParams,
): ProjectLine {
  const snap =
    line.generatedSampling ??
    (line.wavPath ? { ...line.sampling } : null);
  return {
    ...line,
    sampling: { ...next },
    generatedSampling: snap,
  };
}

/** wavPath must belong to this line's cache file (guards against stale/shared paths). */
function wavPathMatchesLine(line: ProjectLine, wavPath?: string): boolean {
  const path = wavPath ?? line.wavPath;
  if (!path) return false;
  return wavPathBelongsToLine(line, path);
}

function variantDurationKey(lineId: string, variantId: string, speed: number) {
  return `${lineId}:${variantId}:${speed.toFixed(2)}`;
}

function samplingForContentKey(
  sampling: SamplingParams | null | undefined,
): SamplingParams | null {
  if (!sampling) return null;
  return { ...sampling, seed: null };
}

function generatedSamplingSnapshot(
  sampling: SamplingParams,
): SamplingParams {
  return { ...sampling, seed: null };
}

function lineContentKey(
  text: string,
  speakerKey: string,
  caption = "",
  cfgScaleCaption = DEFAULT_CFG_SCALE_CAPTION,
  sampling: SamplingParams | null | undefined = null,
) {
  const samp = samplingForContentKey(sampling);
  const sampStr = samp ? JSON.stringify(samp) : "";
  return `${speakerKey}\0${text}\0${caption}\0${cfgScaleCaption}\0${sampStr}`;
}

function joinPath(dir: string, name: string) {
  const sep = /\\/.test(dir) && !/\//.test(dir) ? "\\" : "/";
  return `${dir.replace(/[/\\]+$/, "")}${sep}${name}`;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(0, i) : trimmed;
}

type BatchSaveMode = "individual" | "concat";
type BatchSubtitleMode = "none" | "srt" | "vtt";
type BatchLabelMode = "none" | "audacity" | "reaper";

type AsrLineResult = {
  cer: number;
  asrText: string;
  expectedText: string;
  expectedKana: string;
  actualKana: string;
  /** CER over threshold (successful run) */
  warn: boolean;
  /** Pipeline/setup failure */
  error?: string;
  /** Line changed / regenerated since last verify */
  needsReverify?: boolean;
};

function asrIsAlert(result: AsrLineResult): boolean {
  return !!(result.needsReverify || result.error || result.warn);
}

function AsrBadge({ result }: { result: AsrLineResult }) {
  if (result.needsReverify) {
    return (
      <span className="badge asr-stale asr-badge">
        要再検証
        <span className="asr-tooltip" role="tooltip">
          行が更新されたため、文字起こし検証をやり直してください
          {result.asrText ? (
            <>
              <br />
              <span className="asr-tooltip-label">前回の文字起こし</span>
              {result.asrText}
              <br />
              <span className="asr-tooltip-label">前回CER</span>
              {(result.cer * 100).toFixed(1)}%
            </>
          ) : null}
        </span>
      </span>
    );
  }
  if (result.error) {
    return (
      <span className="badge asr-fail asr-badge">
        検証失敗
        <span className="asr-tooltip" role="tooltip">
          <strong>エラー</strong>
          <br />
          {result.error}
        </span>
      </span>
    );
  }
  if (result.warn) {
    return (
      <span className="badge asr-warn asr-badge">
        ずれあり
        <span className="asr-tooltip" role="tooltip">
          <strong>CER {(result.cer * 100).toFixed(1)}%</strong>
          <br />
          <span className="asr-tooltip-label">台本</span>
          {result.expectedText || "（空）"}
          <br />
          <span className="asr-tooltip-label">台本かな</span>
          {result.expectedKana || "（空）"}
          <br />
          <span className="asr-tooltip-label">文字起こし</span>
          {result.asrText || "（空）"}
          <br />
          <span className="asr-tooltip-label">文字起こしかな</span>
          {result.actualKana || "（空）"}
        </span>
      </span>
    );
  }
  return (
    <span className="badge asr-badge">
      検証OK
      <span className="asr-tooltip" role="tooltip">
        <strong>CER {(result.cer * 100).toFixed(1)}%</strong>
        <br />
        <span className="asr-tooltip-label">文字起こし</span>
        {result.asrText || "（空）"}
      </span>
    </span>
  );
}

function DirtyDiffRows({ diffs }: { diffs: DirtyDiff[] }) {
  return (
    <>
      {diffs.map((d, i) => (
        <span className="dirty-diff-row" key={`${d.label}-${i}`}>
          <span className="asr-tooltip-label">{d.label}</span>
          <span className="dirty-diff-change">
            <span className="dirty-diff-from">{d.from}</span>
            <span className="dirty-diff-arrow">→</span>
            <span className="dirty-diff-to">{d.to}</span>
          </span>
        </span>
      ))}
    </>
  );
}

function DirtyDiffTooltip({
  diffs,
  groups,
  heading = "現在の設定と異なります",
}: {
  diffs?: DirtyDiff[];
  groups?: { title: string; diffs: DirtyDiff[] }[];
  heading?: string;
}) {
  const shown =
    groups && groups.length > 0
      ? groups
      : diffs && diffs.length > 0
        ? [{ title: "", diffs }]
        : [];
  if (shown.length === 0) {
    return (
      <span className="asr-tooltip" role="tooltip">
        音声が現在の設定と一致しません
      </span>
    );
  }
  return (
    <span className="asr-tooltip" role="tooltip">
      <strong>{heading}</strong>
      {shown.map((g, i) => (
        <span className="dirty-diff-group" key={g.title || i}>
          {g.title ? (
            <span className="dirty-diff-variant">{g.title}</span>
          ) : null}
          <DirtyDiffRows diffs={g.diffs} />
        </span>
      ))}
    </span>
  );
}

/** Orbiting accent stroke on the line-item border box (outer edge). */
function GenRing() {
  const hostRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0, bt: 1, bl: 1 });

  useEffect(() => {
    const parent = hostRef.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const cs = getComputedStyle(parent);
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const br = parseFloat(cs.borderRightWidth) || 0;
      const bb = parseFloat(cs.borderBottomWidth) || 0;
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      setBox({
        w: parent.clientWidth + bl + br,
        h: parent.clientHeight + bt + bb,
        bt,
        bl,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const { w, h, bt, bl } = box;
  if (w < 4 || h < 4) {
    return <svg ref={hostRef} className="gen-ring" aria-hidden />;
  }

  const stroke = 1.25;
  const inset = stroke / 2;
  // Outer corner radius of .line-item; path sits on outer edge so rx ≈ border-radius
  const rx = Math.max(0, 10 - inset);
  const rw = Math.max(0, w - stroke);
  const rh = Math.max(0, h - stroke);
  // pathLength=100: two 30% dashes, equally spaced (30 dash + 20 gap) × 2
  const dash = 30;
  const gap = 20;
  const periApprox = 2 * (rw + rh - 2 * rx) + 2 * Math.PI * rx;
  const durationSec = Math.max(0.55, periApprox / 1500);

  return (
    <svg
      ref={hostRef}
      className="gen-ring"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ top: -bt, left: -bl, width: w, height: h }}
      aria-hidden
    >
      <rect
        className="gen-ring-run"
        x={inset}
        y={inset}
        width={rw}
        height={rh}
        rx={rx}
        ry={rx}
        pathLength={100}
        style={{
          strokeDasharray: `${dash} ${gap}`,
          animationDuration: `${durationSec}s`,
        }}
      />
    </svg>
  );
}

type LineFocusRequest = {
  lineId: string;
  cursor: number;
  nonce: number;
};

function AutoTextarea({
  value,
  onChange,
  onDraftChange,
  onFocusLine,
  onSplit,
  onMergePrev,
  canMergePrev,
  focusRequest,
  insertRequest,
  onInsertConsumed,
  pendingAnnotations,
  appliedReadings,
  onApplyAnnotation,
  onUndoReading,
  autoReplaceEntries,
}: {
  value: string;
  onChange: (v: string) => void;
  onDraftChange: (v: string) => void;
  onFocusLine: () => void;
  onSplit: (before: string, after: string) => void;
  onMergePrev: (text: string) => void;
  canMergePrev: boolean;
  focusRequest: LineFocusRequest | null;
  insertRequest: { nonce: number; emoji: string } | null;
  onInsertConsumed?: (nonce: number) => void;
  pendingAnnotations?: DetectedAnnotation[];
  appliedReadings?: AppliedReading[];
  onApplyAnnotation?: (annotation: DetectedAnnotation, reading: string) => void;
  onUndoReading?: (readingId: string) => void;
  autoReplaceEntries?: ReplaceEntry[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);
  const debounceRef = useRef<number | null>(null);
  const caretRef = useRef({ start: 0, end: 0, touched: false });
  const lastInsertNonceRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const onSplitRef = useRef(onSplit);
  onSplitRef.current = onSplit;
  const onMergePrevRef = useRef(onMergePrev);
  onMergePrevRef.current = onMergePrev;
  const onInsertConsumedRef = useRef(onInsertConsumed);
  onInsertConsumedRef.current = onInsertConsumed;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const autoReplaceRef = useRef(autoReplaceEntries);
  autoReplaceRef.current = autoReplaceEntries;
  /** Skip blur→parent flush after Enter-split / Backspace-merge (avoids redundant persist). */
  const suppressBlurFlushRef = useRef(false);

  const rememberCaret = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    caretRef.current = {
      start: el.selectionStart ?? draftRef.current.length,
      end: el.selectionEnd ?? draftRef.current.length,
      touched: true,
    };
  }, []);

  const applyAutoIfNeeded = useCallback(
    (text: string, caret: number): { text: string; caret: number } => {
      const entries = autoReplaceRef.current;
      if (!entries || entries.length === 0) return { text, caret };
      const r = applyAutoReplacements(text, entries, caret);
      if (r.count === 0) return { text, caret };
      return { text: r.text, caret: r.caret };
    },
    [],
  );

  const restoreCaret = useCallback((caret: number) => {
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const c = Math.max(0, Math.min(caret, el.value.length));
      el.setSelectionRange(c, c);
      caretRef.current = { start: c, end: c, touched: true };
    });
  }, []);

  // Sync from parent only when not editing (avoids breaking IME)
  useEffect(() => {
    if (!focused && !composingRef.current) {
      setDraft(value);
      onDraftChangeRef.current(value);
    }
  }, [value, focused]);

  const setDraftBoth = useCallback((next: string) => {
    setDraft(next);
    draftRef.current = next;
    onDraftChangeRef.current(next);
  }, []);

  const flush = useCallback((next: string) => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    onChangeRef.current(next);
  }, []);

  const scheduleFlush = useCallback((next: string) => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      onChangeRef.current(next);
    }, 350);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const pad =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const borderY =
      (parseFloat(cs.borderTopWidth) || 0) +
      (parseFloat(cs.borderBottomWidth) || 0);
    const maxRows = focused ? 12 : 4;
    // border-box: height includes padding + border
    const maxHeight = maxRows * lineHeight + pad + borderY;
    // Drop min-height during measure so CSS floor doesn't inflate scrollHeight
    const prevMin = el.style.minHeight;
    el.style.minHeight = "0px";
    el.style.height = "0px";
    // scrollHeight includes padding, not border — add border for border-box
    const needed = el.scrollHeight + borderY;
    el.style.minHeight = prevMin;
    el.style.height = `${Math.min(needed, maxHeight)}px`;
  }, [focused]);

  useEffect(() => {
    // Resizing mid-composition can detach the IME candidate window on WebView2
    if (!composingRef.current) resize();
  }, [draft, focused, resize]);

  // External focus after split/merge
  useEffect(() => {
    if (!focusRequest) return;
    const el = ref.current;
    if (!el) return;
    setDraft(value);
    draftRef.current = value;
    onDraftChangeRef.current(value);
    const cursor = Math.max(0, Math.min(focusRequest.cursor, value.length));
    const apply = () => {
      el.focus({ preventScroll: true });
      el.setSelectionRange(cursor, cursor);
      caretRef.current = { start: cursor, end: cursor, touched: true };
      resize();
    };
    apply();
    // List insert/remove can steal focus for a frame; re-apply after layout.
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
    // Apply once per request; value is read from the render that issued the nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only nonce
  }, [focusRequest?.nonce]);

  // Emoji / external insert at last caret (pointerdown keeps focus)
  useEffect(() => {
    if (!insertRequest) return;
    // Same request must never apply twice (remount / reselect / Strict Mode)
    if (lastInsertNonceRef.current === insertRequest.nonce) return;
    lastInsertNonceRef.current = insertRequest.nonce;
    const consumedNonce = insertRequest.nonce;
    const emoji = insertRequest.emoji;

    const el = ref.current;
    if (!el) {
      onInsertConsumedRef.current?.(consumedNonce);
      return;
    }
    const text = draftRef.current;
    const focusedNow = document.activeElement === el;
    if (focusedNow) rememberCaret();
    const start = focusedNow
      ? Math.max(0, Math.min(caretRef.current.start, text.length))
      : caretRef.current.touched
        ? Math.max(0, Math.min(caretRef.current.start, text.length))
        : text.length;
    const end = focusedNow
      ? Math.max(start, Math.min(caretRef.current.end, text.length))
      : caretRef.current.touched
        ? Math.max(start, Math.min(caretRef.current.end, text.length))
        : text.length;
    let next = text.slice(0, start) + emoji + text.slice(end);
    let caret = start + emoji.length;
    const auto = applyAutoIfNeeded(next, caret);
    next = auto.text;
    caret = auto.caret;
    setDraftBoth(next);
    flush(next);
    onInsertConsumedRef.current?.(consumedNonce);
    requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
      el.setSelectionRange(caret, caret);
      caretRef.current = { start: caret, end: caret, touched: true };
      resize();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only nonce
  }, [insertRequest?.nonce]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || e.nativeEvent.isComposing) return;

    if (e.key === "Enter") {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const text = draftRef.current;

      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+Enter → internal newline within this line
        const next = text.slice(0, start) + "\n" + text.slice(end);
        setDraftBoth(next);
        flush(next);
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = start + 1;
          resize();
        });
        return;
      }

      // Enter → split into two project lines at caret (selection discarded)
      const before = text.slice(0, start);
      const after = text.slice(end);
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      // Parent persist owns the structural update; blur must not re-flush.
      suppressBlurFlushRef.current = true;
      setDraftBoth(before);
      onSplitRef.current(before, after);
      return;
    }

    if (
      e.key === "Backspace" &&
      canMergePrev &&
      elCaretAtStart(e.currentTarget)
    ) {
      e.preventDefault();
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      // Line may unmount (blur); skip flush so we don't no-op-persist the whole project.
      suppressBlurFlushRef.current = true;
      onMergePrevRef.current(draftRef.current);
    }
  };

  const showOverlay =
    !focused &&
    ((pendingAnnotations && pendingAnnotations.length > 0) ||
      (appliedReadings && appliedReadings.length > 0));

  return (
    <div className="line-text-wrap">
      {showOverlay && onApplyAnnotation ? (
        <AnnotationOverlay
          text={draft}
          pending={pendingAnnotations ?? []}
          applied={appliedReadings ?? []}
          onApply={onApplyAnnotation}
          onUndo={onUndoReading ?? (() => {})}
          onFocusEdit={() => ref.current?.focus()}
        />
      ) : null}
      <textarea
      ref={ref}
      className={`line-text ${
        showOverlay ? "line-text-editing-hidden" : ""
      }`}
      value={draft}
      rows={1}
      onChange={(e) => {
        let next = e.target.value;
        let caret = e.target.selectionStart ?? next.length;
        const composing =
          composingRef.current ||
          (e.nativeEvent as InputEvent).isComposing;
        // During IME composition, never rewrite or push to parent
        if (!composing) {
          const auto = applyAutoIfNeeded(next, caret);
          if (auto.text !== next) {
            next = auto.text;
            caret = auto.caret;
            setDraftBoth(next);
            scheduleFlush(next);
            restoreCaret(caret);
            return;
          }
        }
        setDraftBoth(next);
        rememberCaret();
        if (composing) return;
        scheduleFlush(next);
      }}
      onSelect={rememberCaret}
      onKeyUp={rememberCaret}
      onPointerDown={(e) => {
        if (e.button !== 0 || !isLineSelectModifier(e)) return;
        // Already editing: keep native Shift-click caret/range in the textarea.
        if (focused && e.shiftKey && !e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
      }}
      onClick={(e) => {
        if (isLineSelectModifier(e) && !(focused && e.shiftKey && !e.ctrlKey && !e.metaKey)) {
          return;
        }
        e.stopPropagation();
        rememberCaret();
      }}
      onKeyDown={onKeyDown}
      onCompositionStart={() => {
        composingRef.current = true;
        if (debounceRef.current) {
          window.clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
      }}
      onCompositionEnd={(e) => {
        composingRef.current = false;
        let next = e.currentTarget.value;
        let caret = e.currentTarget.selectionStart ?? next.length;
        const auto = applyAutoIfNeeded(next, caret);
        next = auto.text;
        caret = auto.caret;
        setDraftBoth(next);
        flush(next);
        restoreCaret(caret);
        // Resize after composition so candidate window stays attached
        requestAnimationFrame(() => resize());
      }}
      onFocus={() => {
        setFocused(true);
        onFocusLine();
        rememberCaret();
      }}
      onBlur={() => {
        rememberCaret();
        setFocused(false);
        composingRef.current = false;
        if (suppressBlurFlushRef.current) {
          suppressBlurFlushRef.current = false;
          return;
        }
        flush(draftRef.current);
      }}
    />
    </div>
  );
}

function elCaretAtStart(el: HTMLTextAreaElement) {
  return el.selectionStart === 0 && el.selectionEnd === 0;
}

const SELECT_DRAG_THRESHOLD_PX = 6;

function isLineSelectModifier(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return e.ctrlKey || e.metaKey || e.shiftKey;
}

function isLineTextTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(".line-text-wrap");
}

function isInteractiveLineTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    "textarea, button, input, select, a, .drag-handle, .bounded-select-trigger, .bounded-select-menu, .line-text-wrap, .seek-bar, .variant-seek-stack, .speaker-apply",
  );
}

/** Skip row multi-select for real controls; Ctrl/Shift on the text field is selection. */
function shouldSkipLinePointerSelection(e: ReactPointerEvent): boolean {
  if (!isInteractiveLineTarget(e.target)) return false;
  if (!isLineSelectModifier(e) || !isLineTextTarget(e.target)) return true;
  const textarea =
    e.target instanceof Element ? e.target.closest("textarea") : null;
  if (!textarea || document.activeElement !== textarea) return false;
  // Already editing this field: keep native Shift-click caret/range.
  return e.shiftKey && !e.ctrlKey && !e.metaKey;
}

function sameIdOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function rangeIdsFromAnchor(
  order: string[],
  anchorId: string | null,
  targetId: string,
): string[] {
  const anchor =
    anchorId && order.includes(anchorId) ? anchorId : targetId;
  const i = order.indexOf(anchor);
  const j = order.indexOf(targetId);
  if (i < 0 || j < 0) return [targetId];
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  return order.slice(lo, hi + 1);
}

/** Keep relative order; place the block so `grabbedId` stays at its index. */
function packBlockAtGrab(
  order: string[],
  moving: string[],
  grabbedId: string,
): string[] {
  const movingSet = new Set(moving);
  if (!movingSet.has(grabbedId)) return order;
  const block = order.filter((id) => movingSet.has(id));
  const rest = order.filter((id) => !movingSet.has(id));
  const grabIndex = order.indexOf(grabbedId);
  const grabOffset = block.indexOf(grabbedId);
  if (grabIndex < 0 || grabOffset < 0) return order;
  const dest = grabIndex - grabOffset;
  return [...rest.slice(0, dest), ...block, ...rest.slice(dest)];
}

/** Match Rust `project::sanitize_name` so create/load agree on folder names. */
function sanitizeProjectName(name: string): string {
  let out = "";
  for (const ch of name) {
    if ('<>:"/\\|?*'.includes(ch) || ch.charCodeAt(0) < 32) out += "_";
    else out += ch;
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : "untitled";
}

function isProjectNameTaken(
  candidate: string,
  diskNames: string[],
  openNames: string[],
): boolean {
  const folder = sanitizeProjectName(candidate);
  if (diskNames.includes(folder) || diskNames.includes(candidate)) return true;
  if (openNames.includes(candidate)) return true;
  return openNames.some((n) => sanitizeProjectName(n) === folder);
}

/** e.g. "Demo" → "Demo のコピー", then "Demo のコピー 2", … */
function allocateCopyProjectName(
  baseName: string,
  diskNames: string[],
  openNames: string[],
): string {
  const first = `${baseName} のコピー`;
  if (!isProjectNameTaken(first, diskNames, openNames)) return first;
  for (let i = 2; ; i++) {
    const candidate = `${baseName} のコピー ${i}`;
    if (!isProjectNameTaken(candidate, diskNames, openNames)) return candidate;
  }
}

type ProjectGatePanelsProps = {
  newName: string;
  onNewName: (name: string) => void;
  onCreate: () => void;
  existingNames: string[];
  selectedName: string | null;
  onSelectName: (name: string) => void;
  onLoad: () => void;
  onDelete: (name: string) => void;
  status: string;
  disabled?: boolean;
  openNames?: string[];
};

function ProjectGatePanels({
  newName,
  onNewName,
  onCreate,
  existingNames,
  selectedName,
  onSelectName,
  onLoad,
  onDelete,
  status,
  disabled = false,
  openNames = [],
}: ProjectGatePanelsProps) {
  return (
    <div className="project-start-row">
      <section className="panel">
        <header className="panel-header">
          <h3>新規プロジェクト</h3>
        </header>
        <div className="panel-body form-stack">
          <label>
            プロジェクト名
            <input
              value={newName}
              onChange={(e) => onNewName(e.target.value)}
              placeholder="例: episode01"
              disabled={disabled}
              onKeyDown={(e) => e.key === "Enter" && !disabled && onCreate()}
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={disabled || !newName.trim()}
            onClick={onCreate}
          >
            作成して開く
          </button>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h3>プロジェクト読み込み</h3>
        </header>
        <div className="panel-body form-stack">
          {existingNames.length === 0 ? (
            <p className="project-pick-empty">
              保存されたプロジェクトはありません
            </p>
          ) : (
            <ul className="project-pick-list" role="listbox" aria-label="既存プロジェクト">
              {existingNames.map((name) => {
                const isOpen = openNames.includes(name);
                const selected = selectedName === name;
                return (
                  <li key={name} className="project-pick-row">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`project-pick-item${selected ? " selected" : ""}`}
                      disabled={disabled}
                      onClick={() => onSelectName(name)}
                      onDoubleClick={() => {
                        if (!disabled) {
                          onSelectName(name);
                          onLoad();
                        }
                      }}
                    >
                      <span className="project-pick-name">{name}</span>
                      {isOpen && (
                        <span className="project-pick-badge">開いています</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="danger icon-btn project-pick-delete"
                      title={`「${name}」を削除`}
                      aria-label={`「${name}」を削除`}
                      disabled={disabled}
                      onClick={() => onDelete(name)}
                    >
                      <IconTrash />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            className="primary"
            disabled={disabled || !selectedName}
            onClick={onLoad}
          >
            {selectedName && openNames.includes(selectedName)
              ? "タブに切替"
              : "読み込んで開く"}
          </button>
        </div>
      </section>

      {status ? <span className="status-text project-gate-status">{status}</span> : null}
    </div>
  );
}

function ConfirmModal({
  message,
  onYes,
  onCancel,
}: {
  message: string;
  onYes: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal panel" onClick={(e) => e.stopPropagation()}>
        <header className="panel-header">
          <h3>確認</h3>
        </header>
        <div className="panel-body form-stack">
          <p>{message}</p>
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={() => {
                onYes();
              }}
            >
              OK
            </button>
            <button type="button" onClick={onCancel}>
              キャンセル
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type PipelinePlaybackItem = {
  line: ProjectLine;
  wavPath: string;
  variantId: string | null;
};

/** Queue consumed by sequential playback while generation keeps producing items. */
function createPipelinePlaybackQueue() {
  const queue: PipelinePlaybackItem[] = [];
  const waiters: Array<(item: PipelinePlaybackItem | null) => void> = [];
  let closed = false;

  return {
    push(item: PipelinePlaybackItem) {
      if (closed) return;
      if (waiters.length > 0) waiters.shift()!(item);
      else queue.push(item);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) waiters.shift()!(null);
    },
    next(): Promise<PipelinePlaybackItem | null> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

export function GenerateView({
  speakers,
  settings,
  project,
  openProjects,
  projectNameDraft,
  onProjectChange,
  onOpenProjectsChange,
  onActiveProjectChange,
  onProjectNameDraft,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [workerInfo, setWorkerInfo] = useState("");
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoadingLabel, setModelLoadingLabel] = useState("");
  const [samplingCollapsed, setSamplingCollapsed] = useState(false);
  const [audioCollapsed, setAudioCollapsed] = useState(false);
  const [captionCollapsed, setCaptionCollapsed] = useState(false);
  const [playback, setPlayback] = useState<PlaybackSnapshot | null>(null);
  const [variantDurations, setVariantDurations] = useState<Record<string, number>>(
    {},
  );
  const [seekDraft, setSeekDraft] = useState<{
    lineId: string;
    variantId: string;
    time: number;
  } | null>(null);
  const [variantKeepByLine, setVariantKeepByLine] = useState<
    Record<string, string[]>
  >({});
  const pendingSeekRef = useRef<{
    lineId: string;
    variantId: string | null;
    time: number;
  } | null>(null);
  const loadSeekKeyRef = useRef<string | null>(null);
  const userSeekingKeyRef = useRef<string | null>(null);
  const [confirm, setConfirm] = useState<{
    message: string;
    onYes: () => void;
  } | null>(null);
  const [batchSaveOpen, setBatchSaveOpen] = useState(false);
  const [batchFolder, setBatchFolder] = useState("");
  const [batchMode, setBatchMode] = useState<BatchSaveMode>("individual");
  const [batchSilenceSecs, setBatchSilenceSecs] = useState("0.5");
  const [batchSubtitle, setBatchSubtitle] = useState<BatchSubtitleMode>("none");
  const [batchLabel, setBatchLabel] = useState<BatchLabelMode>("none");
  const [batchFormat, setBatchFormat] = useState<ExportAudioFormat>("wav");
  const [batchSaving, setBatchSaving] = useState(false);
  const [bulkAddOpen, setBulkAddOpen] = useState(false);
  const [bulkAddInitialFile, setBulkAddInitialFile] = useState<File | undefined>(undefined);
  const [lineListDropOver, setLineListDropOver] = useState(false);
  const [annotationReview, setAnnotationReview] = useState<{
    items: {
      lineId: string;
      text: string;
      annotations: DetectedAnnotation[];
      applied: AppliedReading[];
      label: string;
    }[];
  } | null>(null);
  const [numericModes, setNumericModes] = useState<NumericConvertModes>({
    number: "hiragana",
    unit: "hiragana",
  });
  const [replacePreview, setReplacePreview] = useState<{
    changes: {
      lineId: string;
      before: string;
      after: string;
      count: number;
      snippets: ReplaceSnippet[];
    }[];
    total: number;
    selected: Record<string, boolean>;
  } | null>(null);
  const [annotationsByLine, setAnnotationsByLine] = useState<
    Record<string, DetectedAnnotation[]>
  >({});
  const [asrByLine, setAsrByLine] = useState<Record<string, AsrLineResult>>(
    {},
  );
  const [asrBusy, setAsrBusy] = useState(false);
  const [autoReplaceEntries, setAutoReplaceEntries] = useState<ReplaceEntry[]>(
    [],
  );

  const reloadDicts = useCallback(async () => {
    try {
      const dicts = await invoke<Dictionaries>("get_dictionaries");
      setAutoReplaceEntries(
        (dicts.replace ?? []).filter(
          (e) => e.enabled && e.autoReplace && e.from.trim().length > 0,
        ),
      );
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void reloadDicts();
  }, [reloadDicts]);

  useEffect(() => {
    const onFocus = () => void reloadDicts();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadDicts]);

  const invalidateAsr = useCallback((lineId: string) => {
    setAsrByLine((prev) => {
      const cur = prev[lineId];
      if (!cur || cur.needsReverify) return prev;
      // Keep cer/warn/asrText so reverting the edit can restore the badge.
      return {
        ...prev,
        [lineId]: { ...cur, needsReverify: true },
      };
    });
  }, []);

  const invalidateAsrMany = useCallback((lineIds: string[]) => {
    if (lineIds.length === 0) return;
    setAsrByLine((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of lineIds) {
        const cur = next[id];
        if (!cur || cur.needsReverify) continue;
        next[id] = { ...cur, needsReverify: true };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  const clearAsr = useCallback((lineId: string) => {
    setAsrByLine((prev) => {
      if (!(lineId in prev)) return prev;
      const { [lineId]: _, ...rest } = prev;
      return rest;
    });
  }, []);
  const [nameEdit, setNameEdit] = useState(project?.name ?? "");
  const [lineFocusRequest, setLineFocusRequest] =
    useState<LineFocusRequest | null>(null);
  const [existingProjects, setExistingProjects] = useState<string[]>([]);
  const [loadPickName, setLoadPickName] = useState<string | null>(null);
  const [projectGateOpen, setProjectGateOpen] = useState(false);
  const [gateNameDraft, setGateNameDraft] = useState("");
  const [gateBusy, setGateBusy] = useState(false);
  const [selectedByProject, setSelectedByProject] = useState<
    Record<string, string | null>
  >({});
  const [selectedIdsByProject, setSelectedIdsByProject] = useState<
    Record<string, string[]>
  >({});
  const [samplingByProject, setSamplingByProject] = useState<
    Record<string, SamplingParams>
  >({});
  const [tabRename, setTabRename] = useState<string | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const [linePlayContextMenu, setLinePlayContextMenu] = useState<{
    lineId: string;
    x: number;
    y: number;
  } | null>(null);
  const [lineSelectionContextMenu, setLineSelectionContextMenu] = useState<{
    x: number;
    y: number;
    count: number;
  } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiInsert, setEmojiInsert] = useState<{
    nonce: number;
    emoji: string;
    lineId: string;
  } | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [rangeSelecting, setRangeSelecting] = useState(false);

  const projectRef = useRef(project);
  const openProjectsRef = useRef(openProjects);
  openProjectsRef.current = openProjects;
  const selectedIdRef = useRef<string | null>(null);
  const selectedIdsRef = useRef<string[]>([]);
  const selectionAnchorRef = useRef<string | null>(null);
  const displayOrderRef = useRef<string[]>([]);
  const lineGestureConsumedRef = useRef(false);
  const lineListRef = useRef<HTMLDivElement>(null);
  const projectTabsRef = useRef<HTMLDivElement>(null);
  const docFileInputRef = useRef<HTMLInputElement>(null);
  const speakersRef = useRef(speakers);
  speakersRef.current = speakers;

  const selectedId = project
    ? (selectedByProject[project.name] ?? null)
    : null;
  const selectedIds = useMemo(() => {
    if (!project) return [] as string[];
    const ids = selectedIdsByProject[project.name];
    if (ids && ids.length > 0) return ids;
    return selectedId ? [selectedId] : [];
  }, [project, selectedIdsByProject, selectedId]);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const panelSampling = project
    ? (samplingByProject[project.name] ?? project.defaultSampling)
    : defaultSampling();
  const panelSamplingRef = useRef(panelSampling);
  panelSamplingRef.current = panelSampling;
  selectedIdRef.current = selectedId;

  const displayLines = useMemo(() => {
    if (!project) return [];
    if (!dragOrder) return project.lines;
    const map = new Map(project.lines.map((l) => [l.id, l]));
    return dragOrder
      .map((id) => map.get(id))
      .filter((l): l is ProjectLine => !!l);
  }, [project, dragOrder]);
  selectedIdsRef.current = selectedIds;
  displayOrderRef.current = displayLines.map((l) => l.id);

  const onSelectedId = useCallback((id: string | null) => {
    const name = projectRef.current?.name;
    if (!name) return;
    setSelectedByProject((prev) => ({ ...prev, [name]: id }));
    setSelectedIdsByProject((prev) => ({
      ...prev,
      [name]: id ? [id] : [],
    }));
    selectionAnchorRef.current = id;
    selectedIdRef.current = id;
    selectedIdsRef.current = id ? [id] : [];
  }, []);

  const onPanelSampling = useCallback((s: SamplingParams) => {
    const name = projectRef.current?.name;
    if (!name) return;
    panelSamplingRef.current = s;
    setSamplingByProject((prev) => ({ ...prev, [name]: s }));
  }, []);

  const samplingForLine = (line: ProjectLine): SamplingParams =>
    line.id === selectedIdRef.current
      ? panelSamplingRef.current
      : line.sampling;

  const playerRef = useRef<LineAudioPlayer | null>(null);
  const persistChain = useRef(Promise.resolve());
  const skipSamplingAutoApply = useRef(false);
  const skipAutoApplySamplingJson = useRef<string | null>(null);
  const speedTimer = useRef<number | null>(null);
  const lineDraftsRef = useRef<Map<string, string>>(new Map());
  /** Last text used for annotation detect (skip unchanged lines). */
  const annotationTextByLineRef = useRef<Record<string, string>>({});
  const annotationsByLineRef = useRef<Record<string, DetectedAnnotation[]>>({});
  useEffect(() => {
    annotationsByLineRef.current = annotationsByLine;
  }, [annotationsByLine]);
  useEffect(() => {
    const el = projectTabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const delta =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      e.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [project != null]);
  const synthInflight = useRef(
    new Map<
      string,
      Promise<{
        wav: string;
        line: ProjectLine;
        variantId: string;
        seed: number;
      } | null>
    >(),
  );
  /** Survives flaky project state — prevents repeat synth for same content. */
  const readyCacheRef = useRef(
    new Map<string, { key: string; wavPath: string }>(),
  );
  const playGenRef = useRef(0);
  /** Bumped to abort an in-flight `playBatch` loop. */
  const batchPlayGenRef = useRef(0);
  const batchPlayActiveRef = useRef(false);
  const [batchPlayActive, setBatchPlayActive] = useState(false);
  const dragRef = useRef<{
    id: string;
    ids: string[];
    pointerId: number;
    fromIndex: number;
    currentIndex: number;
    startOrder: string[];
    order: string[];
  } | null>(null);
  const dragListenersRef = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    key: (e: KeyboardEvent) => void;
  } | null>(null);
  const selectRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startIndex: number;
    startLineId: string;
    additive: boolean;
    startInGroup: boolean;
    baseIds: string[];
    mode: "pending" | "range";
  } | null>(null);
  const selectListenersRef = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: Event) => void;
    key: (e: KeyboardEvent) => void;
  } | null>(null);

  // Keep ref as source of truth. Never assign `project` during render — a
  // local setState (busy/status) can re-render with a stale project prop and
  // wipe a just-committed wavPath (causing shared/old audio + repeat synth).
  useEffect(() => {
    projectRef.current = project;
    if (!project) return;
    for (const line of project.lines) {
      if (
        !isDirty(line, speakersRef.current) &&
        wavPathMatchesLine(line) &&
        line.wavPath &&
        line.generatedText != null
      ) {
        readyCacheRef.current.set(line.id, {
          key: lineContentKey(
            lineSynthText(line),
            speakerConditionKey(speakersRef.current, line.speakerEmbedPath),
            effectiveLineCaption(line, speakersRef.current),
            effectiveCfgScaleCaption(line, speakersRef.current),
            line.sampling,
          ),
          wavPath: line.wavPath,
        });
      }
    }
  }, [project, speakers]);

  useEffect(() => {
    if (project) setNameEdit(project.name);
  }, [project?.name]);

  const refreshProjectList = useCallback(async () => {
    try {
      const names = await invoke<string[]>("list_projects_cmd");
      setExistingProjects(names);
      setLoadPickName((prev) => {
        if (prev && names.includes(prev)) return prev;
        const current = projectRef.current?.name;
        if (current && names.includes(current)) return current;
        return names[0] ?? null;
      });
    } catch {
      setExistingProjects([]);
      setLoadPickName(null);
    }
  }, []);

  useEffect(() => {
    if (!project || projectGateOpen) {
      void refreshProjectList();
    }
  }, [project, projectGateOpen, refreshProjectList, settings.projectsRoot]);

  useEffect(() => {
    playerRef.current = new LineAudioPlayer({
      onChange: (snap) => {
        setPlayback(snap);
        if (snap?.variantId && snap.duration > 0) {
          const speed =
            projectRef.current?.lines.find((l) => l.id === snap.lineId)
              ?.speed ?? 1;
          const key = variantDurationKey(snap.lineId, snap.variantId, speed);
          setVariantDurations((prev) =>
            prev[key] === snap.duration
              ? prev
              : { ...prev, [key]: snap.duration },
          );
        }
      },
    });
    return () => {
      batchPlayGenRef.current += 1;
      batchPlayActiveRef.current = false;
      setBatchPlayActive(false);
      playerRef.current?.stop(true);
      if (speedTimer.current) window.clearTimeout(speedTimer.current);
    };
  }, []);

  /** Abort sequential batch playback so single-line / edit ops take over. */
  const cancelBatchPlayback = (opts?: {
    stopAudio?: boolean;
    /** Leave sequential mode on (same-line variant takeover still pauses via the row button). */
    keepActive?: boolean;
  }) => {
    batchPlayGenRef.current += 1;
    playGenRef.current += 1;
    if (opts?.stopAudio) {
      playerRef.current?.stop(true);
    } else {
      playerRef.current?.cancelSilence();
      playerRef.current?.releaseEndedWaiters();
    }
    if (batchPlayActiveRef.current && !opts?.keepActive) {
      batchPlayActiveRef.current = false;
      setBatchPlayActive(false);
      setStatus("一括再生を停止");
    }
  };

  const abortSequentialOnLeaveLine = (nextLineId: string | null) => {
    if (!batchPlayActiveRef.current) return;
    const playing = playerRef.current?.activeLineId;
    if (playing && nextLineId && nextLineId !== playing) {
      cancelBatchPlayback({ stopAudio: true });
    }
  };

  const playingLineId = playback?.lineId ?? null;
  useLayoutEffect(() => {
    if (!batchPlayActive || !playingLineId) return;
    const list = lineListRef.current;
    if (!list) return;
    const el = Array.from(
      list.querySelectorAll<HTMLElement>(".line-item[data-line-id]"),
    ).find((item) => item.dataset.lineId === playingLineId);
    if (!el) return;
    const listRect = list.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const fab = list.parentElement?.querySelector<HTMLElement>(".overlay-fab");
    const fabTop = fab?.getBoundingClientRect().top;
    const visibleBottom =
      Math.min(listRect.bottom, fabTop ?? listRect.bottom) - 8;
    const overflow = elRect.bottom - visibleBottom;
    if (overflow > 1) {
      list.scrollBy({ top: overflow, behavior: "smooth" });
    }
  }, [batchPlayActive, playingLineId]);

  const selected = useMemo(
    () => project?.lines.find((l) => l.id === selectedId) ?? null,
    [project, selectedId],
  );
  const variantDurationsRef = useRef(variantDurations);
  variantDurationsRef.current = variantDurations;
  const selectedDurationSig = selected
    ? `${selected.id}:${selected.speed}:${normalizeLineVariants(selected)
        .map((v) => `${v.id}:${v.wavPath}`)
        .join("|")}`
    : "";

  useEffect(() => {
    if (!selected) return;
    const variants = normalizeLineVariants(selected);
    const speed = selected.speed;
    const lineId = selected.id;
    let cancelled = false;
    for (const variant of variants) {
      const key = variantDurationKey(lineId, variant.id, speed);
      if (variantDurationsRef.current[key] != null) continue;
      if (!wavPathBelongsToLine(selected, variant.wavPath)) continue;
      void invoke<number>("wav_duration_secs", { path: variant.wavPath })
        .then((secs) => {
          if (cancelled || !(secs > 0)) return;
          const playbackSecs = secs / Math.max(0.5, speed);
          setVariantDurations((prev) =>
            prev[key] === playbackSecs ? prev : { ...prev, [key]: playbackSecs },
          );
        })
        .catch(() => {
          /* duration stays unknown until playback */
        });
    }
    return () => {
      cancelled = true;
    };
    // selected is read for wav paths; signature avoids cancel-on-keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDurationSig]);

  const selectedSpeaker = useMemo(
    () =>
      speakers.find((s) => s.embedPath === selected?.speakerEmbedPath) ?? null,
    [speakers, selected?.speakerEmbedPath],
  );

  /** v4 only: per-line style caption for 参照音源 speakers. */
  const showLineCaption =
    isIrodoriV4(settings) && usesStyleCaption(selectedSpeaker);

  /** Apply project mutations to memory immediately; serialize disk saves only. */
  const persist = useCallback(
    (mutator: (prev: Project) => Project, updateStatus = true) => {
      const prev = projectRef.current;
      if (!prev) return Promise.resolve();
      const next = mutator(prev);
      if (next === prev) return persistChain.current;
      projectRef.current = next;
      onProjectChange(next);
      persistChain.current = persistChain.current.then(async () => {
        try {
          // Always persist the latest in-memory project (not a stale snapshot)
          const latest = projectRef.current;
          if (!latest) return;
          await invoke("save_project_cmd", { project: latest });
        } catch (e) {
          if (updateStatus) setStatus(`保存失敗: ${e}`);
        }
      });
      return persistChain.current;
    },
    [onProjectChange],
  );

  // Already-open tabs / HMR: backfill sampling snapshots without forcing 要再生成
  useEffect(() => {
    if (!project) return;
    if (
      !project.lines.some(
        (l) =>
          (l.wavPath && l.generatedSampling == null) ||
          (l.wavPath && (!l.variants || l.variants.length === 0)),
      )
    )
      return;
    void persist((prev) => backfillProject(prev), false);
  }, [project, persist]);

  // Remap stale speaker embed paths when outputs root / speaker scan changes.
  useEffect(() => {
    if (speakers.length === 0) return;
    const prevOpen = openProjectsRef.current;
    let anyChanged = false;
    const nextOpen = prevOpen.map((p) => {
      const r = reconcileProjectSpeakers(p, speakers);
      if (r !== p) anyChanged = true;
      return r;
    });
    if (!anyChanged) return;

    onOpenProjectsChange(nextOpen);
    const activeName = projectRef.current?.name;
    if (activeName) {
      const reconciled = nextOpen.find((p) => p.name === activeName);
      if (reconciled) {
        projectRef.current = reconciled;
        onProjectChange(reconciled);
      }
    }
    for (let i = 0; i < nextOpen.length; i++) {
      if (nextOpen[i] !== prevOpen[i]) {
        void invoke("save_project_cmd", { project: nextOpen[i] }).catch(
          () => {},
        );
      }
    }
  }, [speakers, onOpenProjectsChange, onProjectChange]);

  /** Push any unflushed textarea drafts into project before generate/play. */
  const commitDrafts = useCallback(() => {
    const drafts = lineDraftsRef.current;
    if (drafts.size === 0) return;
    void persist((prev) => {
      let changed = false;
      const lines = prev.lines.map((l) => {
        const draft = drafts.get(l.id);
        if (draft === undefined || draft === l.text) return l;
        changed = true;
        return { ...l, text: draft };
      });
      return changed ? { ...prev, lines } : prev;
    }, false);
  }, [persist]);

  // Live volume / EQ while playing
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !selected || player.activeLineId !== selected.id) return;
    player.setVolume(selected.volume);
    player.setAudioFx(audioFxOf(selected));
  }, [selected?.volume, selected?.id, selected?.audioFx]);

  // Speed + denoise: debounce during playback only (ffmpeg). Do not run on wavPath changes.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !selected || player.activeLineId !== selected.id) return;
    if (!player.isPlaying && !player.hasBuffer) return;
    if (!selected.wavPath || !wavPathMatchesLine(selected)) return;

    if (speedTimer.current) window.clearTimeout(speedTimer.current);
    const wavPath = selected.wavPath;
    const speed = selected.speed;
    const denoise = audioFxOf(selected).denoise;
    const lineId = selected.id;
    const gen = playGenRef.current;
    speedTimer.current = window.setTimeout(() => {
      void (async () => {
        try {
          if (gen !== playGenRef.current) return;
          const playPath = await invoke<string>("prepare_playback_wav", {
            src: wavPath,
            speed,
            denoise,
          });
          const bytes = await invoke<number[]>("read_file_bytes", {
            path: playPath,
          });
          if (gen !== playGenRef.current) return;
          if (playerRef.current?.activeLineId !== lineId) return;
          await playerRef.current.replaceBufferKeepPosition(
            new Uint8Array(bytes),
          );
        } catch (e) {
          setStatus(`音声調整の反映失敗: ${e}`);
        }
      })();
    }, 280);

    return () => {
      if (speedTimer.current) window.clearTimeout(speedTimer.current);
    };
  }, [selected?.speed, selected?.audioFx?.denoise, selected?.id]);

  // Auto-apply sampling to selected line (serialized, skip when syncing from line→panel)
  useEffect(() => {
    const skipProjectSwitch = skipSamplingAutoApply.current;
    skipSamplingAutoApply.current = false;
    const skipJson = skipAutoApplySamplingJson.current;
    skipAutoApplySamplingJson.current = null;
    if (skipProjectSwitch) return;
    const id = selectedIdRef.current;
    if (!id) return;
    if (skipJson !== null && skipJson === JSON.stringify(panelSampling)) {
      return;
    }
    void persist((prev) => {
      const line = prev.lines.find((l) => l.id === id);
      if (!line) return prev;
      if (JSON.stringify(line.sampling) === JSON.stringify(panelSampling)) {
        return prev;
      }
      return {
        ...prev,
        lines: prev.lines.map((l) =>
          l.id === id ? withLineSampling(l, panelSampling) : l,
        ),
      };
    }, false);
  }, [panelSampling, persist]);

  const syncPanelFromLine = (line: ProjectLine) => {
    skipAutoApplySamplingJson.current = JSON.stringify(line.sampling);
    onPanelSampling(line.sampling);
  };

  /** Keep panel + line.sampling on the values that will actually be synthesized. */
  const adoptSamplingForGenerate = (
    line: ProjectLine,
    sampling: SamplingParams,
  ) => {
    onSelectedId(line.id);
    skipAutoApplySamplingJson.current = JSON.stringify(sampling);
    onPanelSampling(sampling);
    const cur = projectRef.current?.lines.find((l) => l.id === line.id);
    if (!cur || JSON.stringify(cur.sampling) === JSON.stringify(sampling)) {
      return;
    }
    void persist((prev) => ({
      ...prev,
      lines: prev.lines.map((l) =>
        l.id === line.id ? withLineSampling(l, sampling) : l,
      ),
    }), false);
  };

  const ensureWorker = async () => {
    try {
      const resp = await invoke<{ status?: string }>("ensure_worker");
      setWorkerInfo(
        resp.status === "ready" || !resp.status
          ? "OPT 準備完了"
          : `ワーカー: ${resp.status}`,
      );
      return true;
    } catch (e) {
      setWorkerInfo("");
      setStatus(`モデル読込失敗: ${e}`);
      return false;
    }
  };

  // Periodic OPT worker health check while a project session is active.
  useEffect(() => {
    if (!project || modelLoading) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const resp = await invoke<{
          ok?: boolean;
          status?: string;
          recovered?: boolean;
          loaded?: boolean;
        }>("ping_worker");
        if (cancelled) return;
        if (resp.status === "busy") return;
        if (resp.recovered) {
          setWorkerInfo("OPT を再起動しました");
          setStatus("ワーカーが応答しなかったため再起動しました");
        } else if (resp.ok) {
          setWorkerInfo(
            resp.loaded ? "OPT 準備完了" : "OPT ワーカー起動中",
          );
        }
      } catch {
        /* next tick / synthesize will recover */
      }
    };
    const id = window.setInterval(() => void tick(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [project, modelLoading]);

  /** Flush drafts/saves for the current project before switching away. */
  const flushCurrentProject = async () => {
    if (!projectRef.current) return;
    commitDrafts();
    await persistChain.current;
  };

  /** Activate a project already in memory (tab switch) without reloading the model. */
  const switchToOpenProject = async (name: string) => {
    if (projectRef.current?.name === name) return;
    const target = openProjectsRef.current.find((p) => p.name === name);
    if (!target) return;

    cancelBatchPlayback({ stopAudio: true });
    await flushCurrentProject();
    lineDraftsRef.current.clear();
    synthInflight.current.clear();

    projectRef.current = target;
    onActiveProjectChange(name);
    onProjectNameDraft(name);
    setNameEdit(name);
    skipSamplingAutoApply.current = true;
    setStatus(`「${name}」に切り替え`);
  };

  /** Open / focus a project session (new tab or first load). Reloads worker once. */
  const activateProjectSession = async (
    p: Project,
    opts?: { asNewTab?: boolean },
  ) => {
    cancelBatchPlayback({ stopAudio: true });
    lineDraftsRef.current.clear();
    readyCacheRef.current.clear();
    synthInflight.current.clear();
    setProjectGateOpen(false);
    setGateBusy(false);
    setWorkerInfo("");
    setStatus("");
    setModelLoadingLabel(p.name);
    setModelLoading(true);

    try {
      const ok = await ensureWorker();
      if (!ok) return;

      const migrated = reconcileProjectSpeakers(
        backfillProject(p),
        speakersRef.current,
      );
      if (migrated !== p) {
        try {
          await invoke("save_project_cmd", { project: migrated });
        } catch {
          /* keep session even if snapshot persist fails */
        }
      }

      const asNewTab = opts?.asNewTab ?? openProjectsRef.current.length > 0;
      if (asNewTab) {
        const withoutDup = openProjectsRef.current.filter(
          (x) => x.name !== migrated.name,
        );
        onOpenProjectsChange([...withoutDup, migrated]);
      } else {
        onOpenProjectsChange([migrated]);
      }
      projectRef.current = migrated;
      onActiveProjectChange(migrated.name);
      onProjectNameDraft(migrated.name);
      setNameEdit(migrated.name);
      skipSamplingAutoApply.current = true;
      setSelectedByProject((prev) =>
        prev[migrated.name] !== undefined
          ? prev
          : { ...prev, [migrated.name]: null },
      );
      setSamplingByProject((prev) =>
        prev[migrated.name] !== undefined
          ? prev
          : { ...prev, [migrated.name]: migrated.defaultSampling },
      );
      setStatus(`プロジェクト「${migrated.name}」準備完了`);
      void refreshProjectList();
    } finally {
      setModelLoading(false);
      setModelLoadingLabel("");
    }
  };

  const closeProjectTab = async (name: string) => {
    const list = openProjectsRef.current;
    if (list.length === 0) return;

    if (projectRef.current?.name === name) {
      await flushCurrentProject();
      cancelBatchPlayback({ stopAudio: true });
    }

    const next = list.filter((p) => p.name !== name);
    setSelectedByProject((prev) => {
      const { [name]: _, ...rest } = prev;
      return rest;
    });
    setSelectedIdsByProject((prev) => {
      const { [name]: _, ...rest } = prev;
      return rest;
    });
    setSamplingByProject((prev) => {
      const { [name]: _, ...rest } = prev;
      return rest;
    });

    if (next.length === 0) {
      projectRef.current = null;
      onOpenProjectsChange([]);
      onActiveProjectChange(null);
      onProjectNameDraft("");
      setNameEdit("");
      setStatus("");
      return;
    }

    onOpenProjectsChange(next);
    if (projectRef.current?.name === name) {
      const fallback = next[next.length - 1];
      projectRef.current = fallback;
      onActiveProjectChange(fallback.name);
      onProjectNameDraft(fallback.name);
      setNameEdit(fallback.name);
      skipSamplingAutoApply.current = true;
      lineDraftsRef.current.clear();
      setStatus(`「${fallback.name}」に切り替え`);
    }
  };

  const createProjectByName = async (rawName: string) => {
    const name = rawName.trim();
    if (!name) {
      setStatus("プロジェクト名を入力してください");
      return;
    }
    const folderName = sanitizeProjectName(name);

    setGateBusy(true);
    try {
      await flushCurrentProject();
      const names = await invoke<string[]>("list_projects_cmd");
      if (names.includes(folderName) || names.includes(name)) {
        setStatus(
          `「${folderName}」は既に存在します。右側から読み込むか、別名を指定してください`,
        );
        setLoadPickName(folderName);
        await refreshProjectList();
        return;
      }

      // Already open with same name?
      if (openProjectsRef.current.some((p) => p.name === name)) {
        await switchToOpenProject(name);
        setProjectGateOpen(false);
        return;
      }

      const p: Project = {
        name,
        createdAt: new Date().toISOString(),
        lines: [],
        defaultSampling: defaultSampling(),
      };
      await invoke("save_project_cmd", { project: p });
      await activateProjectSession(p, { asNewTab: true });
    } catch (e) {
      setStatus(`作成失敗: ${e}`);
    } finally {
      setGateBusy(false);
    }
  };

  /** Duplicate an open project tab (lines + cached wavs) under a new name. */
  const duplicateOpenProject = async (sourceName: string) => {
    setTabContextMenu(null);
    setGateBusy(true);
    try {
      if (projectRef.current?.name === sourceName) {
        await flushCurrentProject();
      }

      const source =
        (projectRef.current?.name === sourceName
          ? projectRef.current
          : null) ??
        openProjectsRef.current.find((p) => p.name === sourceName);
      if (!source) {
        setStatus(`「${sourceName}」が見つかりません`);
        return;
      }

      const diskNames = await invoke<string[]>("list_projects_cmd");
      const openNames = openProjectsRef.current.map((p) => p.name);
      const newName = allocateCopyProjectName(
        source.name,
        diskNames,
        openNames,
      );

      const lines: ProjectLine[] = [];
      for (const line of source.lines) {
        const newId = newLineId();
        const sourceVariants = normalizeLineVariants(line);
        const copiedVariants: LineVariant[] = [];
        for (const variant of sourceVariants) {
          if (!wavPathMatchesLine(line, variant.wavPath)) continue;
          try {
            const ok = await invoke<boolean>("file_exists", {
              path: variant.wavPath,
            });
            if (!ok) continue;
            const copiedVariantId =
              sourceVariants.length === 1 && variant.id === line.id
                ? newId
                : newVariantId();
            const useLegacy =
              sourceVariants.length === 1 && variant.id === line.id;
            const dest = await invoke<string>("line_cache_wav_path", {
              projectName: newName,
              lineId: newId,
              variantId: useLegacy ? null : copiedVariantId,
            });
            await invoke("copy_file", { src: variant.wavPath, dest });
            copiedVariants.push({
              id: copiedVariantId,
              seed: variant.seed,
              wavPath: dest,
              generatedText: variant.generatedText,
              generatedSpeakerEmbedPath: variant.generatedSpeakerEmbedPath,
              generatedCaption: variant.generatedCaption,
              generatedCfgScaleCaption: variant.generatedCfgScaleCaption,
              generatedSampling: variant.generatedSampling
                ? { ...variant.generatedSampling }
                : variant.generatedSampling,
            });
          } catch {
            /* skip missing variant files */
          }
        }
        lines.push(
          syncLineWavPath({
            ...line,
            id: newId,
            variants: copiedVariants,
            sampling: { ...line.sampling },
            generatedSampling: line.generatedSampling
              ? { ...line.generatedSampling }
              : line.generatedSampling,
          }),
        );
      }

      const copy: Project = {
        name: newName,
        createdAt: new Date().toISOString(),
        lines,
        defaultSampling: { ...source.defaultSampling },
      };
      await invoke("save_project_cmd", { project: copy });
      await activateProjectSession(copy, { asNewTab: true });
      setStatus(`「${source.name}」のコピー「${newName}」を作成しました`);
    } catch (e) {
      setStatus(`コピー失敗: ${e}`);
    } finally {
      setGateBusy(false);
    }
  };

  const loadProjectByName = async (rawName: string | null) => {
    const name = rawName?.trim() ?? "";
    if (!name) {
      setStatus("読み込むプロジェクトを選択してください");
      return;
    }

    const already = openProjectsRef.current.find((p) => p.name === name);
    if (already) {
      await switchToOpenProject(name);
      setProjectGateOpen(false);
      setStatus(`「${name}」は既に開いています`);
      return;
    }

    setGateBusy(true);
    try {
      await flushCurrentProject();
      const p = await invoke<Project>("load_project_cmd", { name });
      await activateProjectSession(p, { asNewTab: true });
    } catch (e) {
      setStatus(`読み込み失敗: ${e}`);
    } finally {
      setGateBusy(false);
    }
  };

  const deleteProjectByName = async (rawName: string) => {
    const name = rawName.trim();
    if (!name) return;
    const isOpen = openProjectsRef.current.some((p) => p.name === name);
    const extra = isOpen ? "開いているタブは閉じます。" : "";
    askConfirm(
      `プロジェクト「${name}」を削除しますか？フォルダはゴミ箱に移動します。${extra}`,
      () => void doDeleteProject(name),
    );
  };

  const doDeleteProject = async (name: string) => {
    setGateBusy(true);
    try {
      if (openProjectsRef.current.some((p) => p.name === name)) {
        await closeProjectTab(name);
      }
      await invoke("delete_project_cmd", { name });
      await refreshProjectList();
      setStatus(`「${name}」を削除しました`);
    } catch (e) {
      setStatus(`削除失敗: ${e}`);
    } finally {
      setGateBusy(false);
    }
  };

  const startProject = () => {
    void createProjectByName(projectNameDraft);
  };

  const saveProjectNow = async () => {
    if (!projectRef.current) return;
    commitDrafts();
    try {
      await persistChain.current;
      const latest = projectRef.current;
      if (!latest) return;
      await invoke("save_project_cmd", { project: latest });
      setStatus(`「${latest.name}」を保存しました`);
      void refreshProjectList();
    } catch (e) {
      setStatus(`保存失敗: ${e}`);
    }
  };

  const openProjectGate = () => {
    setGateNameDraft("");
    setStatus("");
    setProjectGateOpen(true);
    void refreshProjectList();
  };

  useEffect(() => {
    if (!tabContextMenu) return;
    const close = () => setTabContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Defer so the opening contextmenu click does not immediately dismiss.
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("keydown", onKey);
      window.addEventListener("blur", close);
      window.addEventListener("resize", close);
      window.addEventListener("scroll", close, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    if (!linePlayContextMenu) return;
    const close = () => setLinePlayContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("keydown", onKey);
      window.addEventListener("blur", close);
      window.addEventListener("resize", close);
      window.addEventListener("scroll", close, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [linePlayContextMenu]);

  useEffect(() => {
    if (!lineSelectionContextMenu) return;
    const close = () => setLineSelectionContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("keydown", onKey);
      window.addEventListener("blur", close);
      window.addEventListener("resize", close);
      window.addEventListener("scroll", close, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [lineSelectionContextMenu]);

  const askConfirm = (message: string, onYes: () => void) => {
    setConfirm({ message, onYes });
  };

  const addEmptyLine = async () => {
    if (!projectRef.current) return;
    setEmojiInsert(null);
    const lines = projectRef.current.lines;
    const prev = lines.length > 0 ? lines[lines.length - 1] : null;
    const fallback = speakers[0];
    const line: ProjectLine = {
      id: newLineId(),
      text: "",
      speakerName: prev?.speakerName ?? fallback?.name ?? "",
      speakerEmbedPath: prev?.speakerEmbedPath ?? fallback?.embedPath ?? "",
      sampling: { ...panelSampling },
      wavPath: null,
      generatedText: null,
      generatedSpeakerEmbedPath: null,
      generatedSampling: null,
      caption: prev?.caption ?? "",
      generatedCaption: null,
      cfgScaleCaption:
        prev?.cfgScaleCaption ?? DEFAULT_CFG_SCALE_CAPTION,
      generatedCfgScaleCaption: null,
      volume: selected?.volume ?? 1,
      speed: selected?.speed ?? 1,
      audioFx: audioFxOf(selected),
    };
    await persist((prevProj) => ({
      ...prevProj,
      lines: [...prevProj.lines, line],
    }));
    onSelectedId(line.id);
  };

  const addLinesFromTexts = async (
    imported: ImportedLine[],
    { replace = false }: { replace?: boolean } = {},
  ) => {
    if (!projectRef.current || imported.length === 0) return;
    if (replace && projectRef.current.lines.length > 0) {
      askConfirm(
        `既存の ${projectRef.current.lines.length} 行を置き換えて ${imported.length} 行にします。よろしいですか？`,
        () => {
          void doAddLinesFromTexts(imported, true);
        },
      );
      return;
    }
    await doAddLinesFromTexts(imported, replace);
  };

  const doAddLinesFromTexts = async (
    imported: ImportedLine[],
    replace: boolean,
  ) => {
    if (!projectRef.current || imported.length === 0) return;
    const lines = projectRef.current.lines;
    const prev = lines.length > 0 ? lines[lines.length - 1] : null;
    const fallback = speakers[0];
    const vol = selected?.volume ?? 1;
    const spd = selected?.speed ?? 1;
    const fx = audioFxOf(selected);
    let curName = prev?.speakerName ?? fallback?.name ?? "";
    let curEmbed = prev?.speakerEmbedPath ?? fallback?.embedPath ?? "";
    const unmatched: string[] = [];
    const created: ProjectLine[] = imported.map((item) => {
      if (item.speakerName) {
        const sp = speakers.find((s) => s.name === item.speakerName);
        if (sp) {
          curName = sp.name;
          curEmbed = sp.embedPath;
        } else {
          unmatched.push(item.speakerName);
        }
      }
      return {
        id: newLineId(),
        text: item.text,
        speakerName: curName,
        speakerEmbedPath: curEmbed,
        sampling: { ...panelSampling },
        wavPath: null,
        generatedText: null,
        generatedSpeakerEmbedPath: null,
        generatedSampling: null,
        caption: prev?.caption ?? "",
        generatedCaption: null,
        cfgScaleCaption:
          prev?.cfgScaleCaption ?? DEFAULT_CFG_SCALE_CAPTION,
        generatedCfgScaleCaption: null,
        volume: vol,
        speed: spd,
        audioFx: { ...fx },
      };
    });
    if (replace) {
      cancelBatchPlayback({ stopAudio: true });
      lineDraftsRef.current.clear();
    }
    await persist((prevProj) => ({
      ...prevProj,
      lines: replace ? created : [...prevProj.lines, ...created],
    }));
    onSelectedId(created[0].id);
    const uniq = [...new Set(unmatched)];
    setStatus(
      uniq.length > 0
        ? replace
          ? `${created.length} 行に置き換えました（未マッチ話者: ${uniq.join(", ")}）`
          : `${created.length} 行を追加しました（未マッチ話者: ${uniq.join(", ")}）`
        : replace
          ? `${created.length} 行に置き換えました`
          : `${created.length} 行を追加しました`,
    );
    setBulkAddOpen(false);
  };

  const annotationRunId = useRef(0);
  const refreshAnnotations = useCallback(async () => {
    const runId = ++annotationRunId.current;
    const p = projectRef.current;
    if (!p) {
      setAnnotationsByLine({});
      annotationTextByLineRef.current = {};
      return;
    }
    const prevTexts = annotationTextByLineRef.current;
    const nextTexts: Record<string, string> = {};
    const next: Record<string, DetectedAnnotation[]> = {
      ...annotationsByLineRef.current,
    };
    let changed = false;
    for (const line of p.lines) {
      const text = lineDraftsRef.current.get(line.id) ?? line.text;
      nextTexts[line.id] = text;
      if (!text.trim()) {
        if ((next[line.id]?.length ?? 0) > 0 || prevTexts[line.id]) {
          next[line.id] = [];
          changed = true;
        }
        continue;
      }
      if (prevTexts[line.id] === text && next[line.id] !== undefined) {
        continue;
      }
      try {
        const detected = normalizeDetectedAnnotations(
          await invoke<DetectedAnnotation[]>(
            "detect_annotations_cmd",
            { text },
          ),
        );
        // Abort if a newer refresh has started while we were awaiting
        if (runId !== annotationRunId.current) return;
        // Re-read latest readings from projectRef (may have changed during await)
        const freshLine = projectRef.current?.lines.find((l) => l.id === line.id);
        const currentText = lineDraftsRef.current.get(line.id) ?? freshLine?.text ?? text;
        // If text changed during detect, skip this result (next refresh will pick it up)
        if (currentText !== text) {
          delete nextTexts[line.id];
          continue;
        }
        const applied = validateReadings(text, freshLine?.readings ?? line.readings ?? []);
        next[line.id] = filterPendingAnnotations(detected, applied);
        changed = true;
      } catch (e) {
        console.error("detect_annotations_cmd failed:", e);
        delete nextTexts[line.id];
      }
    }
    // Final stale check
    if (runId !== annotationRunId.current) return;
    for (const id of Object.keys(next)) {
      if (!(id in nextTexts)) {
        delete next[id];
        changed = true;
      }
    }
    annotationTextByLineRef.current = nextTexts;
    if (changed) {
      annotationsByLineRef.current = next;
      setAnnotationsByLine(next);
    }
  }, []);

  // Keep ASR badge in sync with 要再生成 (dirty / missing wav).
  // If the user only edits text then restores it (no re-synth), restore the
  // previous ASR result when the line is clean again and matches the verified text.
  useEffect(() => {
    if (!project) return;
    const staleIds: string[] = [];
    const restoreIds: string[] = [];
    for (const line of project.lines) {
      const asr = asrByLine[line.id];
      if (!asr) continue;
      const dirty =
        isDirty(line, speakers) ||
        !wavPathMatchesLine(line) ||
        !line.wavPath;
      if (dirty) {
        if (!asr.needsReverify) staleIds.push(line.id);
      } else if (
        asr.needsReverify &&
        lineSynthText(line) === asr.expectedText
      ) {
        restoreIds.push(line.id);
      }
    }
    if (staleIds.length > 0) invalidateAsrMany(staleIds);
    if (restoreIds.length > 0) {
      setAsrByLine((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const id of restoreIds) {
          const cur = next[id];
          if (!cur?.needsReverify) continue;
          next[id] = { ...cur, needsReverify: false };
          changed = true;
        }
        return changed ? next : prev;
      });
    }
  }, [project, speakers, asrByLine, invalidateAsrMany]);

  // Reset annotation cache when project changes
  useEffect(() => {
    annotationTextByLineRef.current = {};
    annotationsByLineRef.current = {};
    setAnnotationsByLine({});
  }, [project?.name]);

  // Debounced annotation refresh — schedules Python detection 700ms after last
  // trigger (text edit, project load, or dict change). Uses a ref timer so that
  // draft keystrokes don't force a React re-render.
  const annotationTimerRef = useRef<number | null>(null);
  const scheduleAnnotationRefresh = useCallback(() => {
    if (annotationTimerRef.current != null) {
      window.clearTimeout(annotationTimerRef.current);
    }
    annotationTimerRef.current = window.setTimeout(() => {
      annotationTimerRef.current = null;
      void refreshAnnotations();
    }, 700);
  }, [refreshAnnotations]);

  // Schedule when project lines change
  useEffect(() => {
    if (!project) return;
    scheduleAnnotationRefresh();
  }, [project?.lines, scheduleAnnotationRefresh]);

  useEffect(() => {
    const onDictsChanged = () => {
      annotationTextByLineRef.current = {};
      void reloadDicts();
      scheduleAnnotationRefresh();
    };
    window.addEventListener(DICTS_CHANGED_EVENT, onDictsChanged);
    return () => window.removeEventListener(DICTS_CHANGED_EVENT, onDictsChanged);
  }, [reloadDicts, scheduleAnnotationRefresh]);

  const openReplacePreview = async () => {
    commitDrafts();
    const p = projectRef.current;
    if (!p || p.lines.length === 0) {
      setStatus("置換する行がありません");
      return;
    }
    try {
      const dicts = await invoke<Dictionaries>("get_dictionaries");
      const changes = previewReplacements(
        p.lines.map((l) => ({
          id: l.id,
          text: lineDraftsRef.current.get(l.id) ?? l.text,
        })),
        dicts.replace ?? [],
      );
      const total = changes.reduce((s, c) => s + c.count, 0);
      if (total === 0) {
        setStatus("置換対象がありません（辞書を確認）");
        return;
      }
      const selected: Record<string, boolean> = {};
      for (const c of changes) selected[c.lineId] = true;
      setReplacePreview({ changes, total, selected });
      void reloadDicts();
    } catch (e) {
      setStatus(`辞書読込失敗: ${e}`);
    }
  };

  const applyReplacePreview = async () => {
    if (!replacePreview || !projectRef.current) return;
    const picked = replacePreview.changes.filter(
      (c) => replacePreview.selected[c.lineId],
    );
    if (picked.length === 0) {
      setStatus("適用する行が選択されていません");
      return;
    }
    const map = new Map(picked.map((c) => [c.lineId, c.after]));
    const n = picked.reduce((s, c) => s + c.count, 0);
    setReplacePreview(null);
    await persist((prev) => ({
      ...prev,
      lines: prev.lines.map((l) => {
        const after = map.get(l.id);
        if (after === undefined) return l;
        lineDraftsRef.current.set(l.id, after);
        return { ...l, text: after };
      }),
    }));
    invalidateAsrMany(picked.map((c) => c.lineId));
    setStatus(`語句置換: ${picked.length} 行 / ${n} 箇所を適用`);
    void refreshAnnotations();
  };

  const runAsrVerifyLine = async (line: ProjectLine) => {
    commitDrafts();
    const p = projectRef.current;
    const fresh = p?.lines.find((l) => l.id === line.id) ?? line;
    const wav = fresh.wavPath;
    if (!wav) {
      setStatus("WAV がありません（先に生成してください）");
      return;
    }
    if (isDirty(fresh, speakers) || !wavPathMatchesLine(fresh)) {
      setStatus("要再生成の行です。生成してから文字起こし検証してください");
      invalidateAsr(fresh.id);
      return;
    }
    const text = lineSynthText(fresh);
    setAsrBusy(true);
    setStatus("文字起こし検証の準備中（Whisper small・CPU／初回のみモデル取得）…");
    try {
      await invoke("ensure_asr_model_cmd");
      setStatus("文字起こし検証中…");
      const res = await invoke<{
        ok: boolean;
        asrText: string;
        expectedKana: string;
        actualKana: string;
        cer: number;
        error?: string | null;
      }>("verify_line_asr", {
        wavPath: wav,
        expectedText: text,
      });
      const thr = asrCerWarnThreshold(settings);
      const failed = !res.ok;
      const warn = !failed && res.cer >= thr;
      setAsrByLine((prev) => ({
        ...prev,
        [fresh.id]: {
          cer: res.cer,
          asrText: res.asrText,
          expectedText: text,
          expectedKana: res.expectedKana ?? "",
          actualKana: res.actualKana ?? "",
          warn,
          error: failed ? (res.error ?? "文字起こし検証失敗") : undefined,
          needsReverify: false,
        },
      }));
      setStatus(
        failed
          ? `文字起こし検証失敗: ${res.error ?? "unknown"}`
          : `文字起こし検証 CER ${(res.cer * 100).toFixed(1)}%${warn ? " ⚠" : ""}`,
      );
    } catch (e) {
      setStatus(`文字起こし検証失敗: ${e}`);
    } finally {
      setAsrBusy(false);
    }
  };

  const runAsrVerifyBatch = async () => {
    commitDrafts();
    const p = projectRef.current;
    if (!p) return;
    const dirtyVerified = p.lines.filter((l) => {
      const asr = asrByLine[l.id];
      return (
        asr &&
        !asr.needsReverify &&
        (isDirty(l, speakers) || !wavPathMatchesLine(l) || !l.wavPath)
      );
    });
    invalidateAsrMany(dirtyVerified.map((l) => l.id));

    const targets = p.lines.filter((l) => {
      if (
        !l.wavPath ||
        !l.text.trim() ||
        isDirty(l, speakers) ||
        !wavPathMatchesLine(l)
      ) {
        return false;
      }
      const asr = asrByLine[l.id];
      // 検証OK（警告・失敗・要再検証なし）はスキップ
      if (asr && !asr.needsReverify && !asr.error && !asr.warn) {
        return false;
      }
      return true;
    });
    if (targets.length === 0) {
      setStatus(
        "検証できる行がありません（検証OK・要再生成の行はスキップ）",
      );
      return;
    }
    setAsrBusy(true);
    const thr = asrCerWarnThreshold(settings);
    let warnCount = 0;
    let failCount = 0;
    try {
      setStatus("文字起こし検証の準備中（Whisper small・CPU／初回のみモデル取得）…");
      await invoke("ensure_asr_model_cmd");
      for (let i = 0; i < targets.length; i++) {
        const line = targets[i];
        setStatus(`文字起こし検証中… ${i + 1}/${targets.length}`);
        const text = lineSynthText(line);
        const res = await invoke<{
          ok: boolean;
          asrText: string;
          expectedKana: string;
          actualKana: string;
          cer: number;
          error?: string | null;
        }>("verify_line_asr", {
          wavPath: line.wavPath!,
          expectedText: text,
        });
        const failed = !res.ok;
        const warn = !failed && res.cer >= thr;
        if (failed) failCount += 1;
        else if (warn) warnCount += 1;
        setAsrByLine((prev) => ({
          ...prev,
          [line.id]: {
            cer: res.cer,
            asrText: res.asrText,
            expectedText: text,
            expectedKana: res.expectedKana ?? "",
            actualKana: res.actualKana ?? "",
            warn,
            error: failed ? (res.error ?? "文字起こし検証失敗") : undefined,
            needsReverify: false,
          },
        }));
      }
      setStatus(
        `文字起こし検証完了: ${targets.length} 行 / 警告 ${warnCount}` +
          (failCount > 0 ? ` / 失敗 ${failCount}` : "") +
          `（閾値 ${(thr * 100).toFixed(0)}%）`,
      );
    } catch (e) {
      setStatus(`文字起こし検証失敗: ${e}`);
    } finally {
      setAsrBusy(false);
    }
  };

  const applyAnnotationReading = useCallback(
    async (
      lineId: string,
      annotation: DetectedAnnotation,
      reading: string,
    ) => {
      const trimmed = readingForApply(annotation.kind, reading);
      if (!trimmed) return;
      const entry: AppliedReading = {
        id: newReadingId(),
        kind: annotation.kind,
        start: annotation.start,
        end: annotation.end,
        surface: annotation.surface,
        reading: trimmed,
      };
      await persist((prev) => ({
        ...prev,
        lines: prev.lines.map((l) =>
          l.id !== lineId
            ? l
            : { ...l, readings: [...(l.readings ?? []), entry] },
        ),
      }));
      if (isNovelCandidate(annotation, trimmed)) {
        await persistNovelReadingDict([
          {
            kind: annotation.kind,
            surface: annotation.surface,
            reading: trimmed,
            candidateReadings: annotation.candidates.map((c) => c.reading),
          },
        ]);
      }
      invalidateAsr(lineId);
      // Force re-detection by clearing the text cache for this line
      delete annotationTextByLineRef.current[lineId];
      void refreshAnnotations();
    },
    [invalidateAsr, persist, refreshAnnotations],
  );

  const undoReading = useCallback(
    async (lineId: string, readingId: string) => {
      await persist((prev) => ({
        ...prev,
        lines: prev.lines.map((l) =>
          l.id !== lineId
            ? l
            : { ...l, readings: (l.readings ?? []).filter((r) => r.id !== readingId) },
        ),
      }));
      invalidateAsr(lineId);
      delete annotationTextByLineRef.current[lineId];
      void refreshAnnotations();
    },
    [invalidateAsr, persist, refreshAnnotations],
  );

  const openAnnotationReview = async (line: ProjectLine) => {
    commitDrafts();
    const p = projectRef.current;
    const fresh = p?.lines.find((l) => l.id === line.id) ?? line;
    const draft = lineDraftsRef.current.get(fresh.id);
    const text = draft !== undefined ? draft : fresh.text;
    if (!text.trim()) {
      setStatus("テキストが空です");
      return;
    }
    try {
      setStatus("読み提案を取得中…");
      const detected = normalizeDetectedAnnotations(
        await invoke<DetectedAnnotation[]>(
          "detect_annotations_cmd",
          { text },
        ),
      );
      const applied = validateReadings(text, fresh.readings ?? []);
      const pending = filterPendingAnnotations(detected, applied);
      if (pending.length === 0) {
        setStatus("読み提案対象が見つかりませんでした");
        return;
      }
      const idx = (p?.lines.findIndex((l) => l.id === fresh.id) ?? 0) + 1;
      setAnnotationReview({
        items: [
          {
            lineId: fresh.id,
            text,
            annotations: pending,
            applied,
            label: `${idx} 行目`,
          },
        ],
      });
      setStatus("");
    } catch (e) {
      setStatus(`読み提案エラー: ${String(e)}`);
    }
  };

  const openAnnotationReviewBatch = async () => {
    commitDrafts();
    const p = projectRef.current;
    if (!p || p.lines.length === 0) {
      setStatus("読み提案する行がありません");
      return;
    }
    const candidates = p.lines
      .map((l, i) => {
        const text = lineDraftsRef.current.get(l.id) ?? l.text;
        return { line: l, text, label: `${i + 1} 行目` };
      })
      .filter((c) => c.text.trim());
    if (candidates.length === 0) {
      setStatus("テキストが空です");
      return;
    }
    try {
      setStatus("読み提案を取得中…");
      const items: {
        lineId: string;
        text: string;
        annotations: DetectedAnnotation[];
        applied: AppliedReading[];
        label: string;
      }[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        setStatus(`読み提案を取得中… ${i + 1}/${candidates.length}`);
        // Always call detection directly to get fresh results for the modal
        const detected = normalizeDetectedAnnotations(
          await invoke<DetectedAnnotation[]>(
            "detect_annotations_cmd",
            { text: c.text },
          ),
        );
        const applied = validateReadings(c.text, c.line.readings ?? []);
        const pending = filterPendingAnnotations(detected, applied);
        if (pending.length > 0) {
          items.push({
            lineId: c.line.id,
            text: c.text,
            annotations: pending,
            applied,
            label: c.label,
          });
        }
      }
      if (items.length === 0) {
        // Show what was detected for debugging
        setStatus("読み提案対象が見つかりませんでした（英単語・同形異音・数字を含む行がありません）");
        return;
      }
      setAnnotationReview({ items });
      setStatus("");
    } catch (e) {
      setStatus(`読み提案エラー: ${String(e)}`);
    }
  };

  /** Enter in a line: split into two project lines at the caret. */
  const splitLineAt = (id: string, before: string, after: string) => {
    const p = projectRef.current;
    if (!p) return;
    const idx = p.lines.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const cur = p.lines[idx];
    const newId = newLineId();
    const newLine: ProjectLine = {
      id: newId,
      text: after,
      speakerName: cur.speakerName,
      speakerEmbedPath: cur.speakerEmbedPath,
      sampling: { ...cur.sampling },
      wavPath: null,
      generatedText: null,
      generatedSpeakerEmbedPath: null,
      generatedSampling: null,
      caption: cur.caption ?? "",
      generatedCaption: null,
      cfgScaleCaption: cur.cfgScaleCaption ?? DEFAULT_CFG_SCALE_CAPTION,
      generatedCfgScaleCaption: null,
      volume: cur.volume,
      speed: cur.speed,
      audioFx: audioFxOf(cur),
    };
    lineDraftsRef.current.set(id, before);
    lineDraftsRef.current.set(newId, after);
    readyCacheRef.current.delete(id);
    // Avoid flushSync: forcing a sync re-render of the whole line list causes input lag.
    void persist((prev) => {
      const i = prev.lines.findIndex((l) => l.id === id);
      if (i < 0) return prev;
      const lines = [...prev.lines];
      lines[i] = { ...lines[i], text: before };
      lines.splice(i + 1, 0, newLine);
      return { ...prev, lines };
    });
    onSelectedId(newId);
    setLineFocusRequest({ lineId: newId, cursor: 0, nonce: Date.now() });
  };

  /**
   * Backspace at start of line 2+: append this line as a new internal row
   * on the previous line (`prev\ncurrent`), then remove this line.
   */
  const mergeLineWithPrevious = (id: string, text: string) => {
    const p = projectRef.current;
    if (!p) return;
    const idx = p.lines.findIndex((l) => l.id === id);
    if (idx <= 0) return;
    const prevLine = p.lines[idx - 1];
    const prevDraft =
      lineDraftsRef.current.get(prevLine.id) ?? prevLine.text;
    const joined = `${prevDraft}\n${text}`;
    const cursor = prevDraft.length + 1;

    lineDraftsRef.current.set(prevLine.id, joined);
    lineDraftsRef.current.delete(id);
    readyCacheRef.current.delete(prevLine.id);
    readyCacheRef.current.delete(id);

    if (playerRef.current?.activeLineId === id) {
      cancelBatchPlayback({ stopAudio: true });
    } else {
      cancelBatchPlayback();
    }

    void persist((prev) => {
      const i = prev.lines.findIndex((l) => l.id === id);
      if (i <= 0) return prev;
      const lines = [...prev.lines];
      lines[i - 1] = { ...lines[i - 1], text: joined };
      lines.splice(i, 1);
      return { ...prev, lines };
    });
    onSelectedId(prevLine.id);
    setLineFocusRequest({
      lineId: prevLine.id,
      cursor,
      nonce: Date.now(),
    });
  };

  const commitProjectName = async () => {
    const prev = projectRef.current;
    if (!prev) return;
    const trimmed = nameEdit.trim();
    if (!trimmed) {
      setNameEdit(prev.name);
      setStatus("プロジェクト名を入力してください");
      return;
    }
    if (trimmed === prev.name) {
      setNameEdit(prev.name);
      return;
    }
    try {
      // Flush pending saves so they don't recreate the old folder after rename.
      await persistChain.current;
      await invoke("rename_project_cmd", {
        oldName: prev.name,
        newName: trimmed,
      });
      setSelectedByProject((map) => {
        const v = map[prev.name] ?? null;
        const { [prev.name]: _, ...rest } = map;
        return { ...rest, [trimmed]: v };
      });
      setSelectedIdsByProject((map) => {
        const v = map[prev.name];
        const { [prev.name]: _, ...rest } = map;
        return v !== undefined ? { ...rest, [trimmed]: v } : rest;
      });
      setSamplingByProject((map) => {
        const v = map[prev.name];
        const { [prev.name]: _, ...rest } = map;
        return v !== undefined ? { ...rest, [trimmed]: v } : rest;
      });
      await persist((p) => ({ ...p, name: trimmed }));
      onActiveProjectChange(trimmed);
      onProjectNameDraft(trimmed);
      setStatus(`プロジェクト名を「${trimmed}」に変更`);
    } catch (e) {
      setNameEdit(prev.name);
      setStatus(`名前変更失敗: ${e}`);
    }
  };

  const updateLine = async (id: string, patch: Partial<ProjectLine>) => {
    const affectsAsr =
      "text" in patch ||
      "readings" in patch ||
      "speakerEmbedPath" in patch ||
      "speakerName" in patch ||
      "sampling" in patch ||
      "caption" in patch ||
      "cfgScaleCaption" in patch;
    let changed = false;
    await persist((prev) => {
      const idx = prev.lines.findIndex((l) => l.id === id);
      if (idx < 0) return prev;
      const cur = prev.lines[idx];
      let nextLine: ProjectLine;
      if (patch.sampling) {
        const { sampling: nextSampling, ...rest } = patch;
        nextLine = { ...withLineSampling(cur, nextSampling), ...rest };
      } else {
        nextLine = { ...cur, ...patch };
      }
      if ("text" in patch && patch.text !== undefined) {
        nextLine = {
          ...nextLine,
          readings: validateReadings(patch.text, nextLine.readings ?? []),
        };
      }
      if (nextLine === cur) return prev;
      // Skip no-op text/field writes (e.g. blur after split already persisted).
      const keys = Object.keys(patch) as (keyof ProjectLine)[];
      const same = keys.every((k) => {
        if (k === "sampling") {
          return (
            JSON.stringify(nextLine.sampling) === JSON.stringify(cur.sampling)
          );
        }
        if (k === "audioFx") {
          return (
            JSON.stringify(audioFxOf(nextLine)) === JSON.stringify(audioFxOf(cur))
          );
        }
        return nextLine[k] === cur[k];
      });
      if (same) return prev;
      changed = true;
      const lines = [...prev.lines];
      lines[idx] = nextLine;
      return { ...prev, lines };
    });
    if (changed && affectsAsr) invalidateAsr(id);
  };

  const removeLine = async (id: string) => {
    if (playerRef.current?.activeLineId === id) {
      cancelBatchPlayback({ stopAudio: true });
    } else {
      cancelBatchPlayback();
    }
    await persist((prev) => ({
      ...prev,
      lines: prev.lines.filter((l) => l.id !== id),
    }));
    lineDraftsRef.current.delete(id);
    const next = projectRef.current;
    if (selectedId === id) onSelectedId(next?.lines[0]?.id ?? null);
  };

  const removeLines = async (ids: string[]) => {
    const unique = [...new Set(ids)].filter((id) =>
      projectRef.current?.lines.some((l) => l.id === id),
    );
    if (unique.length === 0) return;
    if (unique.some((id) => playerRef.current?.activeLineId === id)) {
      cancelBatchPlayback({ stopAudio: true });
    } else {
      cancelBatchPlayback();
    }
    const idSet = new Set(unique);
    await persist((prev) => ({
      ...prev,
      lines: prev.lines.filter((l) => !idSet.has(l.id)),
    }));
    for (const id of unique) lineDraftsRef.current.delete(id);
    const name = projectRef.current?.name;
    if (name) {
      const remaining = projectRef.current?.lines.map((l) => l.id) ?? [];
      setSelectedIdsByProject((prev) => ({
        ...prev,
        [name]: remaining.filter((id) => selectedIdsRef.current.includes(id)),
      }));
      if (selectedId && idSet.has(selectedId)) {
        onSelectedId(remaining[0] ?? null);
      }
    }
  };

  const deleteMultiSelectedLines = () => {
    const ids = selectedIdsRef.current;
    if (ids.length < 2) return;
    const lines = projectRef.current?.lines ?? [];
    const targets = lines.filter((l) => ids.includes(l.id));
    if (targets.length < 2) return;
    const hasAudio = targets.some((l) => l.wavPath);
    const msg = hasAudio
      ? `${targets.length} 行を削除しますか？（生成済みの音声も削除されます）`
      : `${targets.length} 行を削除しますか？`;
    askConfirm(msg, () => {
      void removeLines(targets.map((l) => l.id));
    });
  };

  const deleteLine = async (id: string) => {
    const line = projectRef.current?.lines.find((l) => l.id === id);
    if (!line) return;
    const draft = lineDraftsRef.current.get(id);
    const text = (draft ?? line.text).trim();
    if (!text) {
      await removeLine(id);
      return;
    }
    askConfirm("この行を削除しますか？", () => {
      void removeLine(id);
    });
  };

  const applyLineSelection = (
    ids: string[],
    focusId: string | null,
    keepAnchor = false,
  ) => {
    const name = projectRef.current?.name;
    if (!name) return;
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }
    const prevFocus = selectedIdRef.current;
    setSelectedByProject((prev) =>
      prev[name] === focusId ? prev : { ...prev, [name]: focusId },
    );
    setSelectedIdsByProject((prev) => {
      const cur = prev[name];
      if (cur && sameIdOrder(cur, unique)) return prev;
      return { ...prev, [name]: unique };
    });
    selectedIdRef.current = focusId;
    selectedIdsRef.current = unique;
    if (!keepAnchor) selectionAnchorRef.current = focusId;
    if (focusId && focusId !== prevFocus) {
      abortSequentialOnLeaveLine(focusId);
      const line = projectRef.current?.lines.find((l) => l.id === focusId);
      if (line) syncPanelFromLine(line);
    }
  };

  const indexContainingClientY = (clientY: number) => {
    const list = lineListRef.current;
    if (!list) return 0;
    const items = Array.from(
      list.querySelectorAll<HTMLElement>(".line-item[data-line-id]"),
    );
    if (items.length === 0) return 0;
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      if (clientY < rect.bottom) return i;
    }
    return items.length - 1;
  };

  const insertDestFromClientY = (
    clientY: number,
    movingSet: Set<string>,
  ): number | null => {
    const list = lineListRef.current;
    if (!list) return 0;
    const items = Array.from(
      list.querySelectorAll<HTMLElement>(".line-item[data-line-id]"),
    );
    if (items.length === 0) return 0;
    for (const el of items) {
      const id = el.dataset.lineId ?? "";
      if (!movingSet.has(id)) continue;
      const rect = el.getBoundingClientRect();
      if (clientY >= rect.top && clientY < rect.bottom) return null;
    }
    const rest = items.filter(
      (el) => !movingSet.has(el.dataset.lineId ?? ""),
    );
    if (rest.length === 0) return 0;
    for (let i = 0; i < rest.length; i++) {
      const rect = rest[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return rest.length;
  };

  const scrollLineListIfNeeded = (clientY: number) => {
    const list = lineListRef.current;
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const margin = 36;
    if (clientY < rect.top + margin) list.scrollTop -= 18;
    else if (clientY > rect.bottom - margin) list.scrollTop += 18;
  };

  const detachDragListeners = useCallback(() => {
    const listeners = dragListenersRef.current;
    if (!listeners) return;
    window.removeEventListener("pointermove", listeners.move);
    window.removeEventListener("pointerup", listeners.up);
    window.removeEventListener("pointercancel", listeners.up);
    window.removeEventListener("blur", listeners.up as EventListener);
    window.removeEventListener("keydown", listeners.key);
    dragListenersRef.current = null;
  }, []);

  const detachSelectListeners = useCallback(() => {
    const listeners = selectListenersRef.current;
    if (!listeners) return;
    window.removeEventListener("pointermove", listeners.move);
    window.removeEventListener("pointerup", listeners.up);
    window.removeEventListener("pointercancel", listeners.up);
    window.removeEventListener("blur", listeners.up as EventListener);
    window.removeEventListener("keydown", listeners.key);
    selectListenersRef.current = null;
  }, []);

  const endDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) {
        detachDragListeners();
        setDraggingIds([]);
        setDragOrder(null);
        return;
      }
      const order = drag.order;
      const changed = commit && !sameIdOrder(drag.startOrder, order);
      dragRef.current = null;
      detachDragListeners();
      setDraggingIds([]);
      setDragOrder(null);
      if (changed) {
        void persist((prev) => {
          const map = new Map(prev.lines.map((l) => [l.id, l]));
          const lines = order
            .map((id) => map.get(id))
            .filter((l): l is ProjectLine => !!l);
          if (lines.length !== prev.lines.length) return prev;
          return { ...prev, lines };
        });
      }
    },
    [detachDragListeners, persist],
  );

  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;

  const endSelect = (restore: boolean) => {
    const sel = selectRef.current;
    selectRef.current = null;
    detachSelectListeners();
    setRangeSelecting(false);
    if (restore && sel) {
      const focus = sel.baseIds.includes(sel.startLineId)
        ? sel.startLineId
        : (sel.baseIds[0] ?? null);
      applyLineSelection(sel.baseIds, focus, true);
    }
  };

  // Safety: clear stuck drag only on unmount
  useEffect(
    () => () => {
      endDragRef.current(false);
      detachSelectListeners();
    },
    [detachSelectListeners],
  );

  const beginReorder = (
    pointerId: number,
    lineId: string,
    movingIds: string[],
    captureEl: HTMLElement | null,
  ) => {
    const p = projectRef.current;
    if (!p) return;

    if (dragRef.current) endDrag(false);
    endSelect(false);

    const startOrder = p.lines.map((l) => l.id);
    const movingSet = new Set(
      movingIds.includes(lineId) && movingIds.length > 0
        ? movingIds
        : [lineId],
    );
    const moving = startOrder.filter((id) => movingSet.has(id));
    const packed = packBlockAtGrab(startOrder, moving, lineId);
    const rest = packed.filter((id) => !movingSet.has(id));
    const blockStart = packed.indexOf(moving[0] ?? lineId);
    const dest = rest.length === 0 ? 0 : Math.max(0, blockStart);

    dragRef.current = {
      id: lineId,
      ids: moving,
      pointerId,
      fromIndex: dest,
      currentIndex: dest,
      startOrder,
      order: packed,
    };
    setDraggingIds(moving);
    setDragOrder(packed);
    applyLineSelection(moving, lineId, moving.length > 1);

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      ev.preventDefault();
      scrollLineListIfNeeded(ev.clientY);
      const movingNow = new Set(drag.ids);
      const nextDest = insertDestFromClientY(ev.clientY, movingNow);
      if (nextDest === null || nextDest === drag.currentIndex) return;
      const restIds = drag.order.filter((id) => !movingNow.has(id));
      const next = [
        ...restIds.slice(0, nextDest),
        ...drag.ids,
        ...restIds.slice(nextDest),
      ];
      drag.order = next;
      drag.currentIndex = nextDest;
      setDragOrder(next);
    };

    const onUp = (ev: Event) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (ev instanceof PointerEvent && drag.pointerId !== ev.pointerId) return;
      endDrag(true);
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") endDrag(false);
    };

    dragListenersRef.current = { move: onMove, up: onUp, key: onKey };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    window.addEventListener("keydown", onKey);

    if (captureEl) {
      try {
        captureEl.setPointerCapture(pointerId);
      } catch {
        /* capture optional — window listeners are the source of truth */
      }
    }
  };

  const onHandlePointerDown = (
    e: ReactPointerEvent,
    lineId: string,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    lineGestureConsumedRef.current = true;
    const group = selectedIdsRef.current;
    const moving =
      group.includes(lineId) && group.length > 1 ? group : [lineId];
    beginReorder(
      e.pointerId,
      lineId,
      moving,
      e.currentTarget as HTMLElement,
    );
  };

  const onLinePointerDown = (
    e: ReactPointerEvent,
    lineId: string,
    index: number,
  ) => {
    if (e.button !== 0) return;
    if (shouldSkipLinePointerSelection(e)) return;
    if (dragRef.current) return;
    e.preventDefault();
    lineGestureConsumedRef.current = true;

    const order = displayOrderRef.current;
    const additive = e.ctrlKey || e.metaKey;
    const range = e.shiftKey;
    const group = selectedIdsRef.current;
    const startInGroup = group.includes(lineId) && group.length > 1 && !additive && !range;
    const anchorId =
      selectionAnchorRef.current && order.includes(selectionAnchorRef.current)
        ? selectionAnchorRef.current
        : lineId;
    const rangeStartIndex = range
      ? Math.max(0, order.indexOf(anchorId))
      : index;

    if (range) {
      const ids = rangeIdsFromAnchor(order, anchorId, lineId);
      applyLineSelection(ids, lineId, true);
    } else if (!additive && !startInGroup) {
      applyLineSelection([lineId], lineId, false);
    }

    if (selectRef.current) endSelect(false);
    selectRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startIndex: rangeStartIndex,
      startLineId: lineId,
      additive,
      startInGroup,
      baseIds: startInGroup || additive ? [...group] : [lineId],
      mode: range ? "range" : "pending",
    };
    if (range) setRangeSelecting(true);

    const onMove = (ev: PointerEvent) => {
      const sel = selectRef.current;
      if (!sel || sel.pointerId !== ev.pointerId) return;
      const dx = ev.clientX - sel.startX;
      const dy = ev.clientY - sel.startY;
      if (sel.mode === "pending") {
        if (dx * dx + dy * dy < SELECT_DRAG_THRESHOLD_PX ** 2) return;
        if (sel.startInGroup) {
          const moving = sel.baseIds.includes(sel.startLineId)
            ? sel.baseIds
            : [sel.startLineId];
          selectRef.current = null;
          detachSelectListeners();
          setRangeSelecting(false);
          beginReorder(sel.pointerId, sel.startLineId, moving, null);
          return;
        }
        sel.mode = "range";
        setRangeSelecting(true);
      }
      if (sel.mode !== "range") return;
      ev.preventDefault();
      scrollLineListIfNeeded(ev.clientY);
      const hover = indexContainingClientY(ev.clientY);
      const orderNow = displayOrderRef.current;
      const rangeNow = orderNow.slice(
        Math.min(sel.startIndex, hover),
        Math.max(sel.startIndex, hover) + 1,
      );
      const ids = sel.additive
        ? [...sel.baseIds, ...rangeNow]
        : rangeNow;
      applyLineSelection(ids, sel.startLineId, true);
    };

    const onUp = (ev: Event) => {
      const sel = selectRef.current;
      if (!sel) return;
      if (ev instanceof PointerEvent && sel.pointerId !== ev.pointerId) return;
      if (sel.mode === "pending") {
        if (sel.additive) {
          const has = sel.baseIds.includes(sel.startLineId);
          const next = has
            ? sel.baseIds.filter((id) => id !== sel.startLineId)
            : [...sel.baseIds, sel.startLineId];
          const focus =
            next.includes(sel.startLineId)
              ? sel.startLineId
              : (next[next.length - 1] ?? null);
          applyLineSelection(next, focus, true);
        } else if (sel.startInGroup) {
          applyLineSelection([sel.startLineId], sel.startLineId, false);
        }
      }
      selectRef.current = null;
      detachSelectListeners();
      setRangeSelecting(false);
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") endSelect(true);
    };

    selectListenersRef.current = { move: onMove, up: onUp, key: onKey };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    window.addEventListener("keydown", onKey);

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture optional */
    }
  };

  const insertEmoji = useCallback(
    (emoji: string) => {
      const targetId =
        selectedIdRef.current ?? projectRef.current?.lines[0]?.id ?? null;
      if (!targetId) {
        setStatus("絵文字を挿入する行を選択してください");
        return;
      }
      if (selectedIdRef.current !== targetId) {
        onSelectedId(targetId);
      }
      setEmojiInsert({ nonce: Date.now(), emoji, lineId: targetId });
    },
    [onSelectedId],
  );

  const onEmojiInsertConsumed = useCallback((nonce: number) => {
    setEmojiInsert((prev) => (prev && prev.nonce === nonce ? null : prev));
  }, []);

  const applySpeakerToAll = (source: ProjectLine) => {
    if (!projectRef.current) return;
    const { speakerEmbedPath, speakerName } = source;
    const label = speakerName || "未選択";
    askConfirm(
      `話者「${label}」を全行に適用します。よろしいですか？`,
      () => {
        void persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) => ({
            ...l,
            speakerEmbedPath,
            speakerName,
          })),
        }));
        setStatus("全行に話者を適用");
      },
    );
  };

  const applySpeakerFromHere = (source: ProjectLine, displayIndex: number) => {
    if (!projectRef.current) return;
    const { speakerEmbedPath, speakerName } = source;
    const label = speakerName || "未選択";
    const orderedIds =
      dragOrder ?? projectRef.current.lines.map((l) => l.id);
    const targetIds = new Set(orderedIds.slice(displayIndex));
    askConfirm(
      `話者「${label}」をこの行以降に適用します。よろしいですか？`,
      () => {
        void persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) =>
            targetIds.has(l.id)
              ? { ...l, speakerEmbedPath, speakerName }
              : l,
          ),
        }));
        setStatus("以降の行に話者を適用");
      },
    );
  };

  const applySpeakerToParity = (source: ProjectLine, displayIndex: number) => {
    if (!projectRef.current) return;
    const { speakerEmbedPath, speakerName } = source;
    const label = speakerName || "未選択";
    const wantOdd = (displayIndex + 1) % 2 === 1;
    const parityLabel = wantOdd ? "奇数行" : "偶数行";
    const orderedIds =
      dragOrder ?? projectRef.current.lines.map((l) => l.id);
    const targetIds = new Set(
      orderedIds.filter(
        (_, idx) => (idx + 1) % 2 === (wantOdd ? 1 : 0),
      ),
    );
    askConfirm(
      `話者「${label}」を${parityLabel}に適用します。よろしいですか？`,
      () => {
        void persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) =>
            targetIds.has(l.id)
              ? { ...l, speakerEmbedPath, speakerName }
              : l,
          ),
        }));
        setStatus(`${parityLabel}に話者を適用`);
      },
    );
  };

  const applySamplingToAll = () => {
    if (!projectRef.current) return;
    askConfirm("Sampling を全行に一括適用します。よろしいですか？", () => {
      void persist((prev) => ({
        ...prev,
        defaultSampling: { ...panelSampling },
        lines: prev.lines.map((l) => withLineSampling(l, panelSampling)),
      }));
      setStatus("全行に Sampling を一括適用");
    });
  };

  const applySamplingToSameSpeaker = () => {
    if (!selected) return;
    const speakerPath = selected.speakerEmbedPath;
    const speakerName = selected.speakerName || "未選択";
    askConfirm(
      `Sampling を話者「${speakerName}」の全行に適用します。よろしいですか？`,
      () => {
        void persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) =>
            l.speakerEmbedPath === speakerPath
              ? withLineSampling(l, panelSampling)
              : l,
          ),
        }));
        setStatus("同一話者に Sampling を適用");
      },
    );
  };

  const applyAudioToAll = () => {
    if (!selected) return;
    const { volume, speed } = selected;
    const audioFx = audioFxOf(selected);
    askConfirm(
      `Volume ${volume.toFixed(2)} / Speed ${speed.toFixed(2)} と追加調整を全行に適用します。よろしいですか？`,
      () => {
        void persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) => ({ ...l, volume, speed, audioFx })),
        }));
        setStatus("全行に Audio Adjustment を一括適用");
      },
    );
  };

  const applyAudioToSameSpeaker = () => {
    if (!selected) return;
    const { volume, speed, speakerEmbedPath, speakerName } = selected;
    const audioFx = audioFxOf(selected);
    askConfirm(
      `Volume / Speed / 追加調整を話者「${speakerName || "未選択"}」の全行に適用します。よろしいですか？`,
      () => {
        void persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) =>
            l.speakerEmbedPath === speakerEmbedPath
              ? { ...l, volume, speed, audioFx }
              : l,
          ),
        }));
        setStatus("同一話者に Audio を適用");
      },
    );
  };

  const applyCaptionToAll = () => {
    if (!selected) return;
    const caption = lineCaptionOf(selected);
    const cfgScaleCaption = lineCfgScaleCaption(selected);
    askConfirm("Caption を全行に一括適用します。よろしいですか？", () => {
      void persist((prev) => ({
        ...prev,
        lines: prev.lines.map((l) => ({ ...l, caption, cfgScaleCaption })),
      }));
      setStatus("全行に Caption を一括適用");
    });
  };

  const applyCaptionToSameSpeaker = () => {
    if (!selected) return;
    const caption = lineCaptionOf(selected);
    const cfgScaleCaption = lineCfgScaleCaption(selected);
    const { speakerEmbedPath, speakerName } = selected;
    askConfirm(
      `Caption を話者「${speakerName || "未選択"}」の全行に適用します。よろしいですか？`,
      () => {
        void persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) =>
            l.speakerEmbedPath === speakerEmbedPath
              ? { ...l, caption, cfgScaleCaption }
              : l,
          ),
        }));
        setStatus("同一話者に Caption を適用");
      },
    );
  };

  const synthesizeVariant = async (
    line: ProjectLine,
    variantId: string,
    opts: {
      force?: boolean;
      useLegacyPath?: boolean;
      randomSeed?: boolean;
      persistToLine?: boolean;
      manageBusy?: boolean;
    } = {},
  ): Promise<{
    wav: string;
    line: ProjectLine;
    variantId: string;
    seed: number;
  } | null> => {
    const force = opts.force === true;
    const useLegacyPath = opts.useLegacyPath === true;
    const randomSeed = opts.randomSeed === true;
    const persistToLine = opts.persistToLine !== false;
    const manageBusy = opts.manageBusy !== false;
    const inflightKey = `${line.id}:${variantId}`;
    const inflight = synthInflight.current.get(inflightKey);
    if (inflight) return inflight;

    let settle!: (
      v: {
        wav: string;
        line: ProjectLine;
        variantId: string;
        seed: number;
      } | null,
    ) => void;
    const gate = new Promise<{
      wav: string;
      line: ProjectLine;
      variantId: string;
      seed: number;
    } | null>((r) => {
      settle = r;
    });
    synthInflight.current.set(inflightKey, gate);

    const finish = (
      v: {
        wav: string;
        line: ProjectLine;
        variantId: string;
        seed: number;
      } | null,
    ) => {
      synthInflight.current.delete(inflightKey);
      settle(v);
      return v;
    };

    try {
      commitDrafts();
      const p = projectRef.current;
      if (!p) return finish(null);
      const fresh = p.lines.find((l) => l.id === line.id) ?? line;
      if (!fresh.speakerEmbedPath) {
        setStatus("話者を選択してください");
        return finish(null);
      }
      if (!fresh.text.trim()) {
        setStatus("テキストが空です");
        return finish(null);
      }

      const speakerKey = speakerConditionKey(
        speakersRef.current,
        fresh.speakerEmbedPath,
      );
      const captionUsed = effectiveLineCaption(fresh, speakersRef.current);
      const cfgCaptionUsed = effectiveCfgScaleCaption(
        fresh,
        speakersRef.current,
      );
      const synthText = lineSynthText(fresh);
      const s = samplingForLine(fresh);
      const contentKey = lineContentKey(
        synthText,
        speakerKey,
        captionUsed,
        cfgCaptionUsed,
        s,
      );
      const outPath = await invoke<string>("line_cache_wav_path", {
        projectName: p.name,
        lineId: fresh.id,
        variantId: useLegacyPath ? null : variantId,
      });

      const existingVariants = normalizeLineVariants(fresh);
      const existingVariant = existingVariants.find((v) => v.id === variantId);

      if (!force && !randomSeed) {
        const mem = readyCacheRef.current.get(fresh.id);
        if (
          mem &&
          mem.key === contentKey &&
          mem.wavPath === outPath &&
          existingVariant?.wavPath === outPath
        ) {
          const ok = await invoke<boolean>("file_exists", { path: outPath });
          if (ok) {
            const readyLine = syncLineWavPath({
              ...fresh,
              variants: existingVariants,
              generatedText: synthText,
              generatedSpeakerEmbedPath: speakerKey,
              generatedCaption: captionUsed,
              generatedCfgScaleCaption: cfgCaptionUsed,
              generatedSampling: generatedSamplingSnapshot(s),
            });
            return finish({
              wav: outPath,
              line: readyLine,
              variantId,
              seed: existingVariant?.seed ?? 0,
            });
          }
        }
        if (
          !isDirty(fresh, speakersRef.current) &&
          existingVariant &&
          wavPathMatchesLine(fresh, existingVariant.wavPath)
        ) {
          const ok = await invoke<boolean>("file_exists", {
            path: existingVariant.wavPath,
          });
          if (ok) {
            readyCacheRef.current.set(fresh.id, {
              key: contentKey,
              wavPath: existingVariant.wavPath,
            });
            return finish({
              wav: existingVariant.wavPath,
              line: fresh,
              variantId,
              seed: existingVariant.seed,
            });
          }
        }
      }

      flushSync(() => {
        if (manageBusy) {
          setBusy(true);
          setBusyLineId(fresh.id);
        }
        setStatus(`生成中…「${fresh.text.slice(0, 20)}」`);
      });

      const sp = speakersRef.current.find(
        (x) => x.embedPath === fresh.speakerEmbedPath,
      );
      const synthArgs: Record<string, unknown> = {
        text: synthText,
        outputWav: outPath,
        numSteps: s.numSteps,
        numCandidates: 1,
        seed: randomSeed ? null : s.seed,
        seconds: s.seconds,
        durationScale: s.durationScale,
        tScheduleMode: s.tScheduleMode,
        swayCoeff: s.swayCoeff,
        cfgGuidanceMode: s.cfgGuidanceMode,
        cfgScaleText: s.cfgScaleText,
        cfgScaleSpeaker: s.cfgScaleSpeaker,
      };
      if (sp?.kind === "ref") {
        const wavs = sp.refWavs?.filter(Boolean);
        if (wavs && wavs.length > 0) {
          synthArgs.refWavs = wavs;
          synthArgs.refWav = wavs[0];
        } else if (sp.refWav) {
          synthArgs.refWav = sp.refWav;
        } else {
          setStatus("参照音源が未設定の話者です");
          return finish(null);
        }
      } else if (sp?.kind === "caption") {
        if (!sp.caption?.trim()) {
          setStatus("キャプションが未設定の話者です");
          return finish(null);
        }
        synthArgs.caption = sp.caption;
        synthArgs.noRef = true;
        synthArgs.cfgScaleCaption = cfgCaptionUsed;
      } else {
        // trained / blend → ref_embed
        synthArgs.refEmbed = fresh.speakerEmbedPath;
      }
      // v4: 行キャプションを話者キャプションに上書き・追記（ref / trained / blend 共通）
      if (
        isIrodoriV4(settings) &&
        sp?.kind !== "caption" &&
        captionUsed.trim()
      ) {
        synthArgs.caption = captionUsed.trim();
        synthArgs.cfgScaleCaption = cfgCaptionUsed;
      }

      const resp = await invoke<{ used_seed?: number }>("synthesize_line", {
        args: synthArgs,
      });
      const usedSeed =
        typeof resp.used_seed === "number" ? resp.used_seed : 0;

      const exists = await invoke<boolean>("file_exists", { path: outPath });
      if (!exists) {
        setStatus(`生成失敗: 出力ファイルがありません (${outPath})`);
        return finish(null);
      }

      const textUsed = synthText;
      const speakerUsed = speakerKey;
      const genSampling = generatedSamplingSnapshot(s);
      readyCacheRef.current.set(fresh.id, {
        key: lineContentKey(
          textUsed,
          speakerUsed,
          captionUsed,
          cfgCaptionUsed,
          s,
        ),
        wavPath: outPath,
      });
      lineDraftsRef.current.set(fresh.id, fresh.text);

      const nextVariant: LineVariant = {
        id: variantId,
        seed: usedSeed,
        wavPath: outPath,
        ...generationSnap(
          textUsed,
          speakerUsed,
          captionUsed,
          cfgCaptionUsed,
          s,
        ),
      };
      let updated = syncLineWavPath({
        ...(projectRef.current?.lines.find((l) => l.id === fresh.id) ??
          fresh),
        text: fresh.text,
        sampling: { ...s },
        generatedText: textUsed,
        generatedSpeakerEmbedPath: speakerUsed,
        generatedCaption: captionUsed,
        generatedCfgScaleCaption: cfgCaptionUsed,
        generatedSampling: genSampling,
      });
      if (persistToLine) {
        let nextVariants: LineVariant[];
        const inheritedExisting = existingVariants.map((v) =>
          inheritLineGeneration(fresh, v),
        );
        const idx = inheritedExisting.findIndex((v) => v.id === variantId);
        if (idx >= 0) {
          nextVariants = inheritedExisting.map((v, i) =>
            i === idx ? nextVariant : v,
          );
        } else if (inheritedExisting.length === 0) {
          nextVariants = [nextVariant];
        } else {
          nextVariants = [...inheritedExisting, nextVariant];
        }
        updated = syncLineWavPath({ ...updated, variants: nextVariants });
        await persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) => (l.id === fresh.id ? updated : l)),
        }));
        clearAsr(fresh.id);
      }
      setStatus("生成完了（キャッシュ）");
      return finish({
        wav: outPath,
        line: updated,
        variantId,
        seed: usedSeed,
      });
    } catch (e) {
      setStatus(String(e));
      return finish(null);
    } finally {
      if (manageBusy) {
        setBusy(false);
        setBusyLineId(null);
      }
    }
  };

  const persistVariantsForLine = async (
    lineId: string,
    variants: LineVariant[],
    dropped: LineVariant[] = [],
  ) => {
    for (const v of dropped) {
      try {
        await invoke("delete_file", { path: v.wavPath });
      } catch {
        /* ignore missing cache files */
      }
    }
    await persist((prev) => ({
      ...prev,
      lines: prev.lines.map((l) => {
        if (l.id !== lineId) return l;
        return syncLineWavPath({ ...l, variants });
      }),
    }));
  };

  const appendVariants = async (
    line: ProjectLine,
    added: LineVariant[],
  ): Promise<ProjectLine | null> => {
    const fresh =
      projectRef.current?.lines.find((l) => l.id === line.id) ?? line;
    const speakerKey = speakerConditionKey(
      speakersRef.current,
      fresh.speakerEmbedPath,
    );
    const captionUsed = effectiveLineCaption(fresh, speakersRef.current);
    const cfgCaptionUsed = effectiveCfgScaleCaption(
      fresh,
      speakersRef.current,
    );
    const s = samplingForLine(fresh);
    const snap = generationSnap(
      lineSynthText(fresh),
      speakerKey,
      captionUsed,
      cfgCaptionUsed,
      s,
    );
    const current = normalizeLineVariants(fresh).map((v) =>
      inheritLineGeneration(fresh, v),
    );
    const merged = [...current, ...added.map((v) => stampVariantGeneration(v, snap))];
    const dropped =
      merged.length > MAX_LINE_VARIANTS
        ? merged.slice(0, merged.length - MAX_LINE_VARIANTS)
        : [];
    const kept =
      merged.length > MAX_LINE_VARIANTS
        ? merged.slice(-MAX_LINE_VARIANTS)
        : merged;
    for (const v of dropped) {
      try {
        await invoke("delete_file", { path: v.wavPath });
      } catch {
        /* ignore missing cache files */
      }
    }
    await persist((prev) => ({
      ...prev,
      lines: prev.lines.map((l) => {
        if (l.id !== fresh.id) return l;
        return syncLineWavPath({
          ...l,
          sampling: { ...s },
          variants: kept,
          generatedText: snap.generatedText,
          generatedSpeakerEmbedPath: snap.generatedSpeakerEmbedPath,
          generatedCaption: snap.generatedCaption,
          generatedCfgScaleCaption: snap.generatedCfgScaleCaption,
          generatedSampling: snap.generatedSampling,
        });
      }),
    }));
    await persistChain.current;
    return (
      projectRef.current?.lines.find((l) => l.id === fresh.id) ??
      syncLineWavPath({ ...fresh, variants: kept })
    );
  };

  const candidateCountForLine = (line: ProjectLine): number =>
    clampCandidateCount(samplingForLine(line).numCandidates);

  const generateModeForLine = (line: ProjectLine) =>
    multiGenerateModeOf(samplingForLine(line));

  const synthesizeCandidateBatch = async (
    line: ProjectLine,
    mode: "overwrite" | "append",
  ): Promise<{
    line: ProjectLine;
    newVariants: LineVariant[];
  } | null> => {
    commitDrafts();
    const p = projectRef.current;
    if (!p) return null;
    const fresh = p.lines.find((l) => l.id === line.id) ?? line;
    if (!fresh.speakerEmbedPath) {
      setStatus("話者を選択してください");
      return null;
    }
    if (!fresh.text.trim()) {
      setStatus("テキストが空です");
      return null;
    }

    const n = candidateCountForLine(fresh);
    const s = samplingForLine(fresh);
    const speakerKey = speakerConditionKey(
      speakersRef.current,
      fresh.speakerEmbedPath,
    );
    const captionUsed = effectiveLineCaption(fresh, speakersRef.current);
    const cfgCaptionUsed = effectiveCfgScaleCaption(
      fresh,
      speakersRef.current,
    );
    const synthText = lineSynthText(fresh);

    const ids = Array.from({ length: n }, () => newVariantId());
    const paths: string[] = [];
    for (const id of ids) {
      paths.push(
        await invoke<string>("line_cache_wav_path", {
          projectName: p.name,
          lineId: fresh.id,
          variantId: id,
        }),
      );
    }

    const sp = speakersRef.current.find(
      (x) => x.embedPath === fresh.speakerEmbedPath,
    );
    const synthArgs: Record<string, unknown> = {
      text: synthText,
      outputWav: paths[0],
      outputWavs: paths,
      numSteps: s.numSteps,
      numCandidates: n,
      seed: null,
      seconds: s.seconds,
      durationScale: s.durationScale,
      tScheduleMode: s.tScheduleMode,
      swayCoeff: s.swayCoeff,
      cfgGuidanceMode: s.cfgGuidanceMode,
      cfgScaleText: s.cfgScaleText,
      cfgScaleSpeaker: s.cfgScaleSpeaker,
    };
    if (sp?.kind === "ref") {
      const wavs = sp.refWavs?.filter(Boolean);
      if (wavs && wavs.length > 0) {
        synthArgs.refWavs = wavs;
        synthArgs.refWav = wavs[0];
      } else if (sp.refWav) {
        synthArgs.refWav = sp.refWav;
      } else {
        setStatus("参照音源が未設定の話者です");
        return null;
      }
    } else if (sp?.kind === "caption") {
      if (!sp.caption?.trim()) {
        setStatus("キャプションが未設定の話者です");
        return null;
      }
      synthArgs.caption = sp.caption;
      synthArgs.noRef = true;
      synthArgs.cfgScaleCaption = cfgCaptionUsed;
    } else {
      synthArgs.refEmbed = fresh.speakerEmbedPath;
    }
    if (
      isIrodoriV4(settings) &&
      sp?.kind !== "caption" &&
      captionUsed.trim()
    ) {
      synthArgs.caption = captionUsed.trim();
      synthArgs.cfgScaleCaption = cfgCaptionUsed;
    }

    flushSync(() => {
      setBusy(true);
      setBusyLineId(fresh.id);
      setStatus(`生成中… ${n}件「${fresh.text.slice(0, 20)}」`);
    });

    try {
      const resp = await invoke<{
        used_seed?: number;
        output_wavs?: string[];
      }>("synthesize_line", { args: synthArgs });
      const usedSeed =
        typeof resp.used_seed === "number" ? resp.used_seed : 0;
      const saved =
        Array.isArray(resp.output_wavs) && resp.output_wavs.length > 0
          ? resp.output_wavs
          : paths;

      const newVariants: LineVariant[] = [];
      for (let i = 0; i < n; i++) {
        const wavPath = saved[i] ?? paths[i];
        const exists = await invoke<boolean>("file_exists", { path: wavPath });
        if (!exists) {
          if (newVariants.length === 0) {
            setStatus(`生成失敗: 出力ファイルがありません (${wavPath})`);
            return null;
          }
          break;
        }
        newVariants.push({
          id: ids[i],
          seed: usedSeed,
          wavPath,
          ...generationSnap(
            synthText,
            speakerKey,
            captionUsed,
            cfgCaptionUsed,
            s,
          ),
        });
      }
      if (newVariants.length === 0) return null;

      readyCacheRef.current.set(fresh.id, {
        key: lineContentKey(
          synthText,
          speakerKey,
          captionUsed,
          cfgCaptionUsed,
          s,
        ),
        wavPath: newVariants[0].wavPath,
      });
      lineDraftsRef.current.set(fresh.id, fresh.text);

      let updatedLine: ProjectLine | null;
      if (mode === "overwrite") {
        const existing = normalizeLineVariants(fresh);
        const dropped = existing.filter(
          (v) => !newVariants.some((nv) => nv.wavPath === v.wavPath),
        );
        for (const v of dropped) {
          try {
            await invoke("delete_file", { path: v.wavPath });
          } catch {
            /* ignore missing cache files */
          }
        }
        await persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) => {
            if (l.id !== fresh.id) return l;
            return syncLineWavPath({
              ...l,
              sampling: { ...s },
              variants: newVariants,
              generatedText: synthText,
              generatedSpeakerEmbedPath: speakerKey,
              generatedCaption: captionUsed,
              generatedCfgScaleCaption: cfgCaptionUsed,
              generatedSampling: generatedSamplingSnapshot(s),
            });
          }),
        }));
        await persistChain.current;
        updatedLine =
          projectRef.current?.lines.find((l) => l.id === fresh.id) ??
          syncLineWavPath({ ...fresh, variants: newVariants });
      } else {
        updatedLine = await appendVariants(fresh, newVariants);
      }

      if (!updatedLine) return null;
      clearAsr(fresh.id);
      setStatus(
        mode === "overwrite"
          ? `上書き生成完了: ${newVariants.length} 件`
          : `追加生成完了: ${newVariants.length} 件`,
      );
      return { line: updatedLine, newVariants };
    } catch (e) {
      setStatus(String(e));
      return null;
    } finally {
      setBusy(false);
      setBusyLineId(null);
    }
  };

  const runIndividualSynth = async (
    line: ProjectLine,
    mode: "overwrite" | "append",
    opts?: {
      onVariant?: (item: { line: ProjectLine; variant: LineVariant }) => void;
      abortGen?: number;
    },
  ): Promise<{ line: ProjectLine; newVariants: LineVariant[] } | null> => {
    commitDrafts();
    const p = projectRef.current;
    if (!p) return null;
    let fresh = p.lines.find((l) => l.id === line.id) ?? line;
    if (!fresh.speakerEmbedPath) {
      setStatus("話者を選択してください");
      return null;
    }
    if (!fresh.text.trim()) {
      setStatus("テキストが空です");
      return null;
    }

    const n = candidateCountForLine(fresh);
    flushSync(() => {
      setBusy(true);
      setBusyLineId(fresh.id);
      setStatus(`生成中… 1/${n}「${fresh.text.slice(0, 20)}」`);
    });

    const newVariants: LineVariant[] = [];
    try {
      if (mode === "overwrite") {
        const existing = normalizeLineVariants(fresh);
        if (existing.length > 0) {
          await persistVariantsForLine(fresh.id, [], existing);
          await persistChain.current;
        }
      }
      fresh =
        projectRef.current?.lines.find((l) => l.id === fresh.id) ?? fresh;

      for (let i = 0; i < n; i++) {
        if (
          opts?.abortGen != null &&
          opts.abortGen !== batchPlayGenRef.current
        ) {
          break;
        }
        setStatus(`生成中… ${i + 1}/${n}「${fresh.text.slice(0, 20)}」`);
        const variantId = newVariantId();
        const result = await synthesizeVariant(fresh, variantId, {
          force: true,
          randomSeed: true,
          persistToLine: false,
          manageBusy: false,
        });
        if (!result) {
          if (newVariants.length === 0) return null;
          break;
        }
        const variant: LineVariant = {
          id: variantId,
          seed: result.seed,
          wavPath: result.wav,
          ...generationSnap(
            lineSynthText(fresh),
            speakerConditionKey(
              speakersRef.current,
              fresh.speakerEmbedPath,
            ),
            effectiveLineCaption(fresh, speakersRef.current),
            effectiveCfgScaleCaption(fresh, speakersRef.current),
            samplingForLine(fresh),
          ),
        };
        const updated = await appendVariants(fresh, [variant]);
        if (!updated) {
          if (newVariants.length === 0) return null;
          break;
        }
        newVariants.push(variant);
        fresh = updated;
        opts?.onVariant?.({ line: updated, variant });
      }
      if (newVariants.length === 0) return null;
      setStatus(
        mode === "overwrite"
          ? `上書き生成完了: ${newVariants.length} 件`
          : `追加生成完了: ${newVariants.length} 件`,
      );
      return { line: fresh, newVariants };
    } catch (e) {
      setStatus(String(e));
      return null;
    } finally {
      setBusy(false);
      setBusyLineId(null);
    }
  };

  const synthesizeLineAudio = async (
    line: ProjectLine,
    mode: "overwrite" | "append",
    opts?: {
      onVariant?: (item: { line: ProjectLine; variant: LineVariant }) => void;
      abortGen?: number;
    },
  ): Promise<{ line: ProjectLine; newVariants: LineVariant[] } | null> => {
    if (generateModeForLine(line) === "individual") {
      return runIndividualSynth(line, mode, opts);
    }
    const result = await synthesizeCandidateBatch(line, mode);
    if (result && opts?.onVariant) {
      for (const variant of result.newVariants) {
        opts.onVariant({ line: result.line, variant });
      }
    }
    return result;
  };

  const runLineGenerate = async (
    line: ProjectLine,
    mode: "overwrite" | "append",
  ): Promise<{ line: ProjectLine; newVariants: LineVariant[] } | null> => {
    const fresh =
      projectRef.current?.lines.find((l) => l.id === line.id) ?? line;
    const sampling = samplingForLine(fresh);
    const n = clampCandidateCount(sampling.numCandidates);
    cancelBatchPlayback({ stopAudio: true });
    adoptSamplingForGenerate(fresh, sampling);

    const gen = batchPlayGenRef.current;
    playGenRef.current += 1;
    const queue = createPipelinePlaybackQueue();
    const playbackPromise = runPipelinePlaybackLoop(gen, queue, {
      statusPrefix:
        mode === "overwrite" ? "上書き結果を再生中…" : "追加結果を再生中…",
      total: n,
    });

    const result = await synthesizeLineAudio(fresh, mode, {
      abortGen: gen,
      onVariant: ({ line: readyLine, variant }) => {
        if (gen !== batchPlayGenRef.current) return;
        queue.push({
          line: readyLine,
          wavPath: variant.wavPath,
          variantId: variant.id,
        });
      },
    });
    queue.close();
    await playbackPromise;
    if (gen !== batchPlayGenRef.current) return null;
    return result;
  };

  const requestAppendGenerate = (line: ProjectLine) => {
    const fresh =
      projectRef.current?.lines.find((l) => l.id === line.id) ?? line;
    const current = normalizeLineVariants(fresh);
    const n = candidateCountForLine(fresh);
    const overflow = current.length + n - MAX_LINE_VARIANTS;
    const run = () => {
      void (async () => {
        const result = await runLineGenerate(line, "append");
        if (!result) return;
        await persistChain.current;
      })();
    };
    if (overflow > 0) {
      askConfirm(
        `追加すると古い音声から ${overflow} 件削除されます。続行しますか？`,
        run,
      );
      return;
    }
    run();
  };

  const requestOverwriteGenerate = (line: ProjectLine) => {
    const fresh =
      projectRef.current?.lines.find((l) => l.id === line.id) ?? line;
    const current = normalizeLineVariants(fresh);
    const n = candidateCountForLine(fresh);
    const run = () => {
      void (async () => {
        const result = await runLineGenerate(line, "overwrite");
        if (!result) return;
        await persistChain.current;
      })();
    };
    if (current.length > 0) {
      askConfirm(
        `既存の ${current.length} 件を破棄し、${n} 件で上書きします。続行しますか？`,
        run,
      );
      return;
    }
    run();
  };

  const startPlayback = async (
    line: ProjectLine,
    wavPath: string,
    variantId: string | null,
    opts?: { autoplay?: boolean },
  ) => {
    const player = playerRef.current;
    if (!player) return;
    const gen = ++playGenRef.current;
    player.stop(true);
    try {
      const playPath = await invoke<string>("prepare_playback_wav", {
        src: wavPath,
        speed: line.speed,
        denoise: audioFxOf(line).denoise,
      });
      if (gen !== playGenRef.current) return;
      const exists = await invoke<boolean>("file_exists", { path: playPath });
      if (!exists) {
        setStatus(`再生失敗: ファイルがありません (${playPath})`);
        return;
      }
      const bytes = await invoke<number[]>("read_file_bytes", {
        path: playPath,
      });
      if (gen !== playGenRef.current) return;
      player.setAudioFx(audioFxOf(line));
      await player.loadFromBytes(
        line.id,
        variantId,
        new Uint8Array(bytes),
        line.volume,
      );
      if (gen !== playGenRef.current) return;
      const pending = pendingSeekRef.current;
      if (
        pending &&
        pending.lineId === line.id &&
        pending.variantId === variantId
      ) {
        player.seek(pending.time);
        pendingSeekRef.current = null;
      }
      setSeekDraft((d) =>
        d && d.lineId === line.id && d.variantId === (variantId ?? d.variantId)
          ? null
          : d,
      );
      if (opts?.autoplay !== false) {
        player.resume();
      }
      onSelectedId(line.id);
    } catch (e) {
      if (gen === playGenRef.current) setStatus(`再生失敗: ${e}`);
    }
  };

  /** Play queued items in order while generation may still be running. */
  const runPipelinePlaybackLoop = async (
    gen: number,
    queue: ReturnType<typeof createPipelinePlaybackQueue>,
    opts: {
      statusPrefix: string;
      total?: number;
      /** Finish the already-loaded clip before consuming the queue. */
      continueAfterCurrent?: boolean;
      playedOffset?: number;
    },
  ) => {
    const player = playerRef.current;
    if (!player) return;
    player.cancelSilence();
    player.releaseEndedWaiters();
    batchPlayActiveRef.current = true;
    setBatchPlayActive(true);
    const silenceMs = Math.max(0, Number(settings.chunkSilenceMs) || 0);
    let playedAny = false;
    let played = opts.playedOffset ?? 0;
    try {
      if (opts.continueAfterCurrent) {
        if (player.isPlaying) {
          await player.waitUntilInactive();
          if (gen !== batchPlayGenRef.current) return;
        }
        playedAny = true;
      }
      while (true) {
        if (gen !== batchPlayGenRef.current) return;
        const item = await queue.next();
        if (!item) break;
        if (playedAny && silenceMs > 0) {
          await player.waitSilenceMs(silenceMs);
          if (gen !== batchPlayGenRef.current) return;
        }
        played += 1;
        const totalLabel =
          opts.total != null ? ` ${played}/${opts.total}` : ` ${played}`;
        setStatus(`${opts.statusPrefix}${totalLabel}`);
        const latest =
          projectRef.current?.lines.find((l) => l.id === item.line.id) ??
          item.line;
        await startPlayback(latest, item.wavPath, item.variantId);
        if (gen !== batchPlayGenRef.current) return;
        await player.waitUntilInactive();
        if (gen !== batchPlayGenRef.current) return;
        playedAny = true;
      }
    } finally {
      if (gen === batchPlayGenRef.current) {
        batchPlayActiveRef.current = false;
        setBatchPlayActive(false);
      }
    }
  };

  const lineSynthBusy = (lineId: string) => {
    for (const key of synthInflight.current.keys()) {
      if (key.startsWith(`${lineId}:`)) return true;
    }
    return false;
  };

  const playVariant = async (lineId: string, variantId: string) => {
    const player = playerRef.current;
    if (!player) return;
    if (busy || lineSynthBusy(lineId)) return;
    commitDrafts();
    const p = projectRef.current;
    if (!p) return;
    const line = p.lines.find((l) => l.id === lineId);
    if (!line) return;
    onSelectedId(line.id);
    syncPanelFromLine(line);

    if (
      player.isActiveVariant(line.id, variantId) &&
      player.hasBuffer
    ) {
      player.togglePause();
      return;
    }

    const keepSequential =
      batchPlayActiveRef.current && player.activeLineId === line.id;
    cancelBatchPlayback({ keepActive: keepSequential });
    const sequentialGen = keepSequential ? batchPlayGenRef.current : null;

    const variant = normalizeLineVariants(line).find((v) => v.id === variantId);
    if (!variant) return;

    const exists = await invoke<boolean>("file_exists", {
      path: variant.wavPath,
    });
    if (!exists) {
      setStatus(`再生失敗: ファイルがありません (${variant.wavPath})`);
      return;
    }
    await startPlayback(line, variant.wavPath, variantId);

    if (sequentialGen != null) {
      void player.waitUntilInactive().then(() => {
        if (sequentialGen !== batchPlayGenRef.current) return;
        if (!batchPlayActiveRef.current) return;
        batchPlayActiveRef.current = false;
        setBatchPlayActive(false);
      });
    }
  };

  const pruneVariantKeep = (lineId: string, keepIds: string[]) => {
    setVariantKeepByLine((prev) => {
      const cur = prev[lineId];
      if (!cur) return prev;
      if (keepIds.length === 0) {
        const { [lineId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [lineId]: keepIds };
    });
  };

  const toggleVariantKeep = (lineId: string, variantId: string) => {
    setVariantKeepByLine((prev) => {
      const cur = prev[lineId] ?? [];
      const next = cur.includes(variantId)
        ? cur.filter((id) => id !== variantId)
        : [...cur, variantId];
      if (next.length === 0) {
        const { [lineId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [lineId]: next };
    });
  };

  const keepOnlyVariants = async (lineId: string, keepIds: ReadonlySet<string>) => {
    const p = projectRef.current;
    if (!p) return;
    const line = p.lines.find((l) => l.id === lineId);
    if (!line) return;
    const variants = normalizeLineVariants(line);
    const kept = variants.filter((v) => keepIds.has(v.id));
    const dropped = variants.filter((v) => !keepIds.has(v.id));
    if (kept.length === 0 || dropped.length === 0) return;
    const player = playerRef.current;
    const droppingActive =
      player != null &&
      dropped.some((v) => player.isActiveVariant(lineId, v.id));
    if (droppingActive) {
      cancelBatchPlayback({ stopAudio: true });
    }
    await persistVariantsForLine(line.id, kept, dropped);
    await persistChain.current;
    pruneVariantKeep(lineId, []);
    setStatus(`${dropped.length}本を削除しました（${kept.length}本を保持）`);
  };

  const deleteVariant = async (lineId: string, variantId: string) => {
    const p = projectRef.current;
    if (!p) return;
    const line = p.lines.find((l) => l.id === lineId);
    if (!line) return;
    const variants = normalizeLineVariants(line);
    const target = variants.find((v) => v.id === variantId);
    if (!target) return;
    const kept = variants.filter((v) => v.id !== variantId);
    if (playerRef.current?.activeLineId === lineId) {
      cancelBatchPlayback({ stopAudio: true });
    }
    await persistVariantsForLine(line.id, kept, [target]);
    await persistChain.current;
    setVariantKeepByLine((prev) => {
      const cur = prev[lineId];
      if (!cur) return prev;
      const next = cur.filter((id) => id !== variantId);
      if (next.length === 0) {
        const { [lineId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [lineId]: next };
    });
  };

  const seekVariant = async (
    line: ProjectLine,
    variant: LineVariant,
    time: number,
  ) => {
    const player = playerRef.current;
    if (!player) return;
    pendingSeekRef.current = {
      lineId: line.id,
      variantId: variant.id,
      time,
    };
    if (player.isActiveVariant(line.id, variant.id) && player.hasBuffer) {
      player.seek(time);
      pendingSeekRef.current = null;
      return;
    }
    const loadKey = `${line.id}:${variant.id}`;
    if (loadSeekKeyRef.current === loadKey) return;
    loadSeekKeyRef.current = loadKey;
    if (
      batchPlayActiveRef.current &&
      !player.isActiveVariant(line.id, variant.id)
    ) {
      const keepSequential = player.activeLineId === line.id;
      cancelBatchPlayback({ keepActive: keepSequential });
    }
    try {
      const exists = await invoke<boolean>("file_exists", {
        path: variant.wavPath,
      });
      if (!exists) return;
      await startPlayback(line, variant.wavPath, variant.id, {
        autoplay: false,
      });
      const pending = pendingSeekRef.current;
      if (
        pending &&
        pending.lineId === line.id &&
        pending.variantId === variant.id
      ) {
        player.seek(pending.time);
        pendingSeekRef.current = null;
      }
    } finally {
      if (loadSeekKeyRef.current === loadKey) loadSeekKeyRef.current = null;
    }
  };

  const playSingleLine = async (lineId: string) => {
    const player = playerRef.current;
    if (!player) return;
    if (busy || lineSynthBusy(lineId)) return;

    commitDrafts();
    const p = projectRef.current;
    if (!p) return;
    const line = p.lines.find((l) => l.id === lineId);
    if (!line) return;

    onSelectedId(line.id);
    syncPanelFromLine(line);

    const variants = normalizeLineVariants(line);
    const activeThisLine =
      player.activeLineId === line.id && player.hasBuffer;
    if (
      activeThisLine &&
      (player.isPlaying ||
        variants.length <= 1 ||
        batchPlayActiveRef.current)
    ) {
      player.togglePause();
      return;
    }

    const pausedMidway =
      activeThisLine && player.getCurrentTime() > 0.02;
    if (pausedMidway && variants.length > 1) {
      const activeVariantId = player.activeVariantId;
      const startIdx = variants.findIndex((v) => v.id === activeVariantId);
      const remaining =
        startIdx >= 0 ? variants.slice(startIdx + 1) : [];

      cancelBatchPlayback({ keepActive: true });
      const gen = batchPlayGenRef.current;
      if (remaining.length > 0) {
        batchPlayActiveRef.current = true;
        setBatchPlayActive(true);
      }
      player.resume();
      if (remaining.length === 0) return;

      playGenRef.current += 1;
      const queue = createPipelinePlaybackQueue();
      const playbackPromise = runPipelinePlaybackLoop(gen, queue, {
        statusPrefix: "再生中…",
        total: variants.length,
        continueAfterCurrent: true,
        playedOffset: startIdx >= 0 ? startIdx + 1 : 0,
      });
      for (const variant of remaining) {
        const exists = await invoke<boolean>("file_exists", {
          path: variant.wavPath,
        });
        if (gen !== batchPlayGenRef.current) return;
        if (exists) {
          queue.push({
            line,
            wavPath: variant.wavPath,
            variantId: variant.id,
          });
        }
      }
      queue.close();
      await playbackPromise;
      return;
    }

    cancelBatchPlayback({ stopAudio: true });

    const playable: LineVariant[] = [];
    for (const variant of variants) {
      const exists = await invoke<boolean>("file_exists", {
        path: variant.wavPath,
      });
      if (exists) playable.push(variant);
    }

    if (playable.length === 0) {
      requestOverwriteGenerate(line);
      return;
    }

    if (playable.length === 1) {
      await startPlayback(line, playable[0].wavPath, playable[0].id);
      return;
    }

    const gen = batchPlayGenRef.current;
    playGenRef.current += 1;
    const queue = createPipelinePlaybackQueue();
    const playbackPromise = runPipelinePlaybackLoop(gen, queue, {
      statusPrefix: "再生中…",
      total: playable.length,
    });
    for (const variant of playable) {
      queue.push({
        line,
        wavPath: variant.wavPath,
        variantId: variant.id,
      });
    }
    queue.close();
    await playbackPromise;
  };

  /** Generate all ungenerated / dirty lines from top to bottom. */
  const generateBatchDirty = async () => {
    commitDrafts();
    const p = projectRef.current;
    if (!p || p.lines.length === 0) return;

    const targets = p.lines.filter(
      (line) => line.text.trim() && isDirty(line, speakers),
    );
    if (targets.length === 0) {
      setStatus("未生成・要再生成の行はありません");
      return;
    }

    const withExisting = targets.filter(
      (line) => normalizeLineVariants(line).length > 0,
    );
    const run = () => {
      void (async () => {
        cancelBatchPlayback({ stopAudio: true });
        const gen = batchPlayGenRef.current;
        playGenRef.current += 1;
        const queue = createPipelinePlaybackQueue();
        const playbackPromise = runPipelinePlaybackLoop(gen, queue, {
          statusPrefix: "一括再生中…",
          total: targets.length,
        });

        let ok = 0;
        let fail = 0;
        const panelOwnerId = selectedIdRef.current;
        const panelSnap = { ...panelSamplingRef.current };
        for (let i = 0; i < targets.length; i++) {
          if (gen !== batchPlayGenRef.current) break;
          const line =
            projectRef.current?.lines.find((l) => l.id === targets[i].id) ??
            targets[i];
          if (!line.text.trim()) continue;
          if (!isDirty(line, speakers)) continue;

          const sampling =
            line.id === panelOwnerId ? panelSnap : line.sampling;
          adoptSamplingForGenerate(line, sampling);
          setStatus(`一括生成中… ${i + 1}/${targets.length}`);
          const individual = multiGenerateModeOf(sampling) === "individual";
          const result = await synthesizeLineAudio(
            line,
            "overwrite",
            individual
              ? {
                  abortGen: gen,
                  onVariant: ({ line: readyLine, variant }) => {
                    if (gen !== batchPlayGenRef.current) return;
                    queue.push({
                      line: readyLine,
                      wavPath: variant.wavPath,
                      variantId: variant.id,
                    });
                  },
                }
              : { abortGen: gen },
          );
          await persistChain.current;
          if (result) {
            ok += 1;
            if (!individual) {
              const primary = result.newVariants[0];
              if (primary) {
                queue.push({
                  line: result.line,
                  wavPath: primary.wavPath,
                  variantId: primary.id,
                });
              }
            }
          } else {
            fail += 1;
          }
        }

        queue.close();
        await playbackPromise;

        if (gen !== batchPlayGenRef.current) return;
        if (fail === 0) {
          setStatus(`一括生成完了: ${ok} 行`);
        } else {
          setStatus(`一括生成完了: 成功 ${ok} / 失敗 ${fail}`);
        }
      })();
    };

    if (withExisting.length > 0) {
      askConfirm(
        `要再生成の ${targets.length} 行を各行の生成数で上書きします。既存音声がある ${withExisting.length} 行は破棄されます。続行しますか？`,
        run,
      );
      return;
    }
    run();
  };

  const playBatch = async () => {
    const player = playerRef.current;
    const p = projectRef.current;
    if (!player || !p || p.lines.length === 0) return;
    const gen = ++batchPlayGenRef.current;
    playGenRef.current += 1;
    player.cancelSilence();
    player.releaseEndedWaiters();
    batchPlayActiveRef.current = true;
    setBatchPlayActive(true);
    const silenceMs = Math.max(0, Number(settings.chunkSilenceMs) || 0);
    setStatus("一括再生中…");
    try {
      let playedAny = false;
      for (const line of p.lines) {
        if (gen !== batchPlayGenRef.current) return;
        if (!line.text.trim()) continue;
        const variants = normalizeLineVariants(line);
        let playLine = line;
        let playWav: string | null = null;
        let playVariantId: string | null = null;
        const primary = variants[0];
        if (
          primary &&
          !isDirty(line, speakers) &&
          wavPathMatchesLine(line, primary.wavPath)
        ) {
          const exists = await invoke<boolean>("file_exists", {
            path: primary.wavPath,
          });
          if (exists) {
            playWav = primary.wavPath;
            playVariantId = primary.id;
          }
        }
        if (!playWav) {
          const result = await synthesizeLineAudio(line, "overwrite");
          const first = result?.newVariants[0];
          if (!result || !first) continue;
          playLine = result.line;
          playWav = first.wavPath;
          playVariantId = first.id;
        }
        if (gen !== batchPlayGenRef.current) return;
        await persistChain.current;
        if (gen !== batchPlayGenRef.current) return;
        if (playedAny && silenceMs > 0) {
          await player.waitSilenceMs(silenceMs);
          if (gen !== batchPlayGenRef.current) return;
        }
        await startPlayback(playLine, playWav, playVariantId);
        if (gen !== batchPlayGenRef.current) return;
        await player.waitUntilInactive();
        if (gen !== batchPlayGenRef.current) return;
        playedAny = true;
      }
      if (gen === batchPlayGenRef.current) {
        setStatus("一括再生完了");
      }
    } finally {
      if (gen === batchPlayGenRef.current) {
        batchPlayActiveRef.current = false;
        setBatchPlayActive(false);
      }
    }
  };

  const ensureLineWav = async (
    line: ProjectLine,
  ): Promise<{ wav: string; line: ProjectLine } | null> => {
    commitDrafts();
    const p = projectRef.current;
    const fresh = p?.lines.find((l) => l.id === line.id) ?? line;
    let wav = fresh.wavPath;
    const pathOk = wavPathMatchesLine(fresh);
    const exists =
      wav && pathOk
        ? await invoke<boolean>("file_exists", { path: wav })
        : false;
    if (!wav || !pathOk || !exists || isDirty(fresh, speakers)) {
      const result = await synthesizeLineAudio(fresh, "overwrite");
      const primary = result?.newVariants[0];
      if (!result || !primary) return null;
      return { wav: primary.wavPath, line: result.line };
    }
    return { wav, line: fresh };
  };

  const collectExistingVariantWavs = async (
    line: ProjectLine,
  ): Promise<string[]> => {
    const wavs: string[] = [];
    for (const variant of normalizeLineVariants(line)) {
      if (!variant.wavPath) continue;
      if (!wavPathMatchesLine(line, variant.wavPath)) continue;
      const exists = await invoke<boolean>("file_exists", {
        path: variant.wavPath,
      });
      if (exists) wavs.push(variant.wavPath);
    }
    return wavs;
  };

  const lineExportName = (
    projectName: string,
    line: ProjectLine,
    idx: number,
    ext: string,
    variantIndex?: number,
    variantCount?: number,
  ) =>
    lineExportFileName({
      projectName,
      idx,
      speakerName: line.speakerName,
      text: line.text,
      utteranceMaxChars: settings.utteranceMaxChars,
      parts: settings.exportFilenameParts,
      ext,
      variantIndex,
      variantCount,
    });

  const exportAdjustedWav = async (
    src: string,
    dest: string,
    line: ProjectLine,
    format: ExportAudioFormat,
  ) => {
    await invoke("export_wav_adjusted", {
      src,
      dest,
      volume: line.volume,
      speed: line.speed,
      audioFx: audioFxOf(line),
      format,
      bitrateKbps: exportBitrateKbps(format, settings),
    });
  };

  const exportVariantWavsToFolder = async (
    folder: string,
    projectName: string,
    line: ProjectLine,
    idx: number,
    wavs: string[],
    format: ExportAudioFormat,
  ) => {
    const variantCount = wavs.length;
    const ext = exportAudioExt(format);
    for (let i = 0; i < wavs.length; i++) {
      const name = lineExportName(
        projectName,
        line,
        idx,
        ext,
        i + 1,
        variantCount,
      );
      await exportAdjustedWav(wavs[i], joinPath(folder, name), line, format);
    }
  };

  const saveLine = async (line: ProjectLine) => {
    const resolved = await ensureLineWav(line);
    if (!resolved) return;
    const wavs = await collectExistingVariantWavs(resolved.line);
    if (wavs.length === 0) {
      setStatus("保存できる音声がありません");
      return;
    }
    const p = projectRef.current;
    const idx = (p?.lines.findIndex((l) => l.id === resolved.line.id) ?? 0) + 1;
    const preferred = exportAudioFormatOf(settings);
    const defaultName = lineExportName(
      p?.name ?? "project",
      resolved.line,
      idx,
      exportAudioExt(preferred),
      1,
      wavs.length,
    );
    const dest = await save({
      defaultPath: defaultName,
      filters: exportDialogFilters(preferred),
    });
    if (!dest) return;
    const format = formatFromDestPath(dest, preferred);
    try {
      if (wavs.length === 1) {
        const outPath = withAudioExt(dest, format);
        await exportAdjustedWav(wavs[0], outPath, resolved.line, format);
        setStatus(`保存: ${outPath}`);
        return;
      }
      const folder = parentDir(dest);
      await exportVariantWavsToFolder(
        folder,
        p?.name ?? "project",
        resolved.line,
        idx,
        wavs,
        format,
      );
      setStatus(`保存: ${wavs.length} ファイル → ${folder}`);
    } catch (e) {
      setStatus(String(e));
    }
  };

  const openBatchSave = () => {
    setBatchFolder(activePaths(settings).outputsRoot || "");
    setBatchMode("individual");
    const secs = Math.max(0, Number(settings.chunkSilenceMs) || 0) / 1000;
    setBatchSilenceSecs(String(secs));
    setBatchSubtitle("none");
    setBatchLabel("none");
    setBatchFormat(exportAudioFormatOf(settings));
    setBatchSaveOpen(true);
  };

  const pickBatchFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: batchFolder || activePaths(settings).outputsRoot || undefined,
    });
    if (typeof selected === "string") setBatchFolder(selected);
  };

  const runBatchSave = async () => {
    const p = projectRef.current;
    if (!p || p.lines.length === 0) return;
    const folder = batchFolder.trim();
    if (!folder) {
      setStatus("保存先フォルダを指定してください");
      return;
    }

    setBatchSaving(true);
    try {
      const resolved: { wavs: string[]; line: ProjectLine; idx: number }[] = [];
      for (let i = 0; i < p.lines.length; i++) {
        const line = p.lines[i];
        if (!line.text.trim()) continue;
        setStatus(`一括保存: 準備中 ${i + 1}/${p.lines.length}`);
        const got = await ensureLineWav(line);
        if (!got) {
          setStatus(`一括保存中断: ${i + 1} 行目の生成に失敗しました`);
          return;
        }
        const wavs = await collectExistingVariantWavs(got.line);
        if (wavs.length === 0) {
          setStatus(`一括保存中断: ${i + 1} 行目の音声がありません`);
          return;
        }
        resolved.push({ wavs, line: got.line, idx: i + 1 });
      }

      if (resolved.length === 0) {
        setStatus("保存できる行がありません");
        return;
      }

      if (batchMode === "individual") {
        let fileCount = 0;
        for (const item of resolved) {
          await exportVariantWavsToFolder(
            folder,
            p.name,
            item.line,
            item.idx,
            item.wavs,
            batchFormat,
          );
          fileCount += item.wavs.length;
        }
        setStatus(`一括保存完了: ${fileCount} ファイル → ${folder}`);
      } else {
        const silenceSecs = Math.max(0, Number(batchSilenceSecs) || 0);
        const dest = joinPath(
          folder,
          `${p.name}_concat.${exportAudioExt(batchFormat)}`,
        );
        await invoke("export_wavs_concatenated", {
          segments: resolved.map((r) => ({
            src: r.wavs[0],
            volume: r.line.volume,
            speed: r.line.speed,
            audioFx: audioFxOf(r.line),
          })),
          silenceSecs,
          dest,
          format: batchFormat,
          bitrateKbps: exportBitrateKbps(batchFormat, settings),
        });

        // Sidecar timings: source duration / speed (+ silence between)
        if (batchSubtitle !== "none" || batchLabel !== "none") {
          const items: {
            durationSec: number;
            text: string;
            speakerName?: string;
          }[] = [];
          for (const r of resolved) {
            const baseDur = await invoke<number>("wav_duration_secs", {
              path: r.wavs[0],
            });
            const speed = Math.max(0.5, Math.min(2, r.line.speed || 1));
            items.push({
              durationSec: baseDur / speed,
              text: r.line.text,
              speakerName: r.line.speakerName || undefined,
            });
          }
          const cues = cuesFromDurations(items, silenceSecs);
          if (batchSubtitle === "srt") {
            await invoke("write_text_file", {
              path: joinPath(folder, `${p.name}_concat.srt`),
              contents: buildSrt(cues),
            });
          } else if (batchSubtitle === "vtt") {
            await invoke("write_text_file", {
              path: joinPath(folder, `${p.name}_concat.vtt`),
              contents: buildVtt(cues),
            });
          }
          if (batchLabel === "audacity" || batchLabel === "reaper") {
            await invoke("write_text_file", {
              path: joinPath(folder, `${p.name}_concat_labels.txt`),
              contents: buildLabelTrack(cues),
            });
          }
        }

        setStatus(`連結保存完了: ${dest}`);
      }
      setBatchSaveOpen(false);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBatchSaving(false);
    }
  };

  if (modelLoading) {
    return (
      <div className="model-loading">
        <div className="model-loading-inner">
          <div className="model-spinner" aria-hidden />
          <p className="model-loading-title">モデルを読み込み中…</p>
          <p className="model-loading-sub">
            {modelLoadingLabel
              ? `「${modelLoadingLabel}」の準備をしています`
              : projectNameDraft.trim()
                ? `「${projectNameDraft.trim()}」の準備をしています`
                : "OPT ワーカーを起動しています"}
          </p>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <>
        <div className="project-start">
          <ProjectGatePanels
            newName={projectNameDraft}
            onNewName={onProjectNameDraft}
            onCreate={startProject}
            existingNames={existingProjects}
            selectedName={loadPickName}
            onSelectName={setLoadPickName}
            onLoad={() => void loadProjectByName(loadPickName)}
            onDelete={(name) => void deleteProjectByName(name)}
            status={status}
            disabled={gateBusy}
            openNames={openProjects.map((p) => p.name)}
          />
        </div>
        {confirm && (
          <ConfirmModal
            message={confirm.message}
            onYes={() => {
              const fn = confirm.onYes;
              setConfirm(null);
              fn();
            }}
            onCancel={() => setConfirm(null)}
          />
        )}
      </>
    );
  }

  return (
    <div className="gen-layout">
      <main className="script-panel panel">
        <header className="panel-header toolbar">
          <div
            ref={projectTabsRef}
            className="project-tabs"
            role="tablist"
            aria-label="開いているプロジェクト"
          >
            {openProjects.map((p) => {
              const active = p.name === project.name;
              const renaming = tabRename === p.name;
              return (
                <div
                  key={p.name}
                  className={`project-tab ${active ? "active" : ""}`}
                  role="tab"
                  aria-selected={active}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (busy || batchSaving || gateBusy) return;
                    setTabContextMenu({
                      name: p.name,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                >
                  {renaming ? (
                    <input
                      className="project-tab-rename"
                      value={nameEdit}
                      autoFocus
                      onChange={(e) => setNameEdit(e.target.value)}
                      onBlur={() => {
                        setTabRename(null);
                        void commitProjectName();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          setTabRename(null);
                          void commitProjectName();
                        } else if (e.key === "Escape") {
                          setNameEdit(p.name);
                          setTabRename(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="プロジェクト名を編集"
                    />
                  ) : (
                    <button
                      type="button"
                      className="project-tab-label"
                      title="クリックで切替・ダブルクリックで名前変更・右クリックでメニュー"
                      onClick={() => {
                        if (!active) void switchToOpenProject(p.name);
                      }}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        setNameEdit(p.name);
                        setTabRename(p.name);
                        if (!active) void switchToOpenProject(p.name);
                      }}
                    >
                      {p.name}
                    </button>
                  )}
                  <button
                    type="button"
                    className="project-tab-close"
                    title="タブを閉じる"
                    aria-label={`${p.name} を閉じる`}
                    disabled={busy || batchSaving || gateBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeProjectTab(p.name);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="project-tab-add"
              title="プロジェクトを追加で開く"
              disabled={busy || batchSaving || gateBusy}
              onClick={openProjectGate}
            >
              +
            </button>
          </div>
          <div className="row project-file-actions">
            <button
              type="button"
              className={emojiOpen ? "active-toggle" : ""}
              disabled={busy || batchSaving || gateBusy}
              onClick={() => setEmojiOpen((v) => !v)}
              title="Emoji Palette"
              aria-expanded={emojiOpen}
            >
              Emoji
            </button>
            <button
              type="button"
              disabled={busy || batchSaving || gateBusy}
              onClick={() => void saveProjectNow()}
              title="プロジェクトをディスクに保存"
            >
              プロジェクト保存
            </button>
          </div>
          <div className="row batch-actions">
            <span className="batch-actions-label">一括操作:</span>
            <button
              type="button"
              disabled={busy || batchSaving || asrBusy}
              onClick={() => setBulkAddOpen(true)}
              title="テキストを分割して複数行追加"
            >
              テキスト追加
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || asrBusy || project.lines.length === 0}
              onClick={() => void generateBatchDirty()}
              title="未生成・要再生成の行を上から順に、各行の生成数で上書き生成"
            >
              生成
            </button>
            <button
              type="button"
              disabled={busy || asrBusy || project.lines.length === 0}
              onClick={() => void playBatch()}
              title="全行を順に再生"
            >
              再生
            </button>
            <button
              type="button"
              disabled={busy || batchSaving || asrBusy || project.lines.length === 0}
              onClick={openBatchSave}
              title="全行をフォルダへ保存"
            >
              保存
            </button>
            <BatchMoreMenu
              disabled={busy || batchSaving || asrBusy}
              canKatakana={project.lines.some((l) => l.text.trim())}
              onKatakana={() => void openAnnotationReviewBatch()}
              onReplace={() => void openReplacePreview()}
              onAsrVerify={() => void runAsrVerifyBatch()}
            />
          </div>
        </header>

        <div className="panel-body script-body">
          <EmojiPalette open={emojiOpen} onInsert={insertEmoji} />
          <div
            className={`line-list-wrap ${lineListDropOver ? "doc-drop-active" : ""}`}
            onDragEnter={(e) => {
              acceptFileDrag(e);
              setLineListDropOver(true);
            }}
            onDragOver={(e) => {
              acceptFileDrag(e);
              setLineListDropOver(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setLineListDropOver(false);
            }}
            onDrop={(e) => {
              acceptFileDrag(e);
              setLineListDropOver(false);
              const file = filesFromDataTransfer(e.dataTransfer).find(isSupportedDocFile);
              if (file) {
                setBulkAddInitialFile(file);
                setBulkAddOpen(true);
              }
            }}
          >
            {lineListDropOver && (
              <div className="line-list-drop-overlay">
                ドロップしてインポート
              </div>
            )}
            <input
              ref={docFileInputRef}
              type="file"
              accept=".txt,.md,.markdown,.docx,.pdf"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = Array.from(e.target.files ?? []).find(isSupportedDocFile);
                e.target.value = "";
                if (file) {
                  setBulkAddInitialFile(file);
                  setBulkAddOpen(true);
                }
              }}
            />
            <div
              className={`line-list ${draggingIds.length ? "is-reordering" : ""}${
                rangeSelecting ? " is-selecting" : ""
              }${generateCompactLinesOf(settings) ? " compact-lines" : ""}`}
              ref={lineListRef}
            >
              {displayLines.map((line, i) => {
                const lineVariants = normalizeLineVariants(line);
                const isPlayingLine = playback?.lineId === line.id;
                const isLinePlayingNow =
                  isPlayingLine && !!playback?.playing;
                const isSelectedLine = selectedId === line.id;
                const hasKeptAudio =
                  lineVariants.length > 0 &&
                  !!line.wavPath &&
                  wavPathMatchesLine(line);
                const lineNeedsRegen = allHeldAudioDirty(line, speakers);
                const dirtyGroups = lineNeedsRegen
                  ? lineDirtyGroups(line, speakers)
                  : [];
                const showLineSeek =
                  hasKeptAudio &&
                  (batchPlayActive
                    ? isPlayingLine && !!playback
                    : isSelectedLine);
                const generating = busyLineId === line.id;
                const keptVariantIds = (variantKeepByLine[line.id] ?? []).filter(
                  (id) => lineVariants.some((v) => v.id === id),
                );
                const canCullOthers =
                  isSelectedLine &&
                  lineVariants.length > 1 &&
                  keptVariantIds.length > 0 &&
                  keptVariantIds.length < lineVariants.length;
                const compactUnselected =
                  generateCompactLinesOf(settings) && !isSelectedLine;
                const asrResult = asrByLine[line.id];
                return (
                  <div
                    key={line.id}
                    data-line-id={line.id}
                    aria-selected={selectedIdSet.has(line.id)}
                    className={`line-item ${selectedIdSet.has(line.id) ? "selected" : ""} ${
                      selectedId === line.id ? "active" : ""
                    } ${generating ? "generating" : ""} ${
                      draggingIds.includes(line.id) ? "dragging" : ""
                    }${compactUnselected ? " compact-unselected" : ""}`}
                    onPointerDown={(e) => onLinePointerDown(e, line.id, i)}
                    onContextMenu={(e) => {
                      if (isInteractiveLineTarget(e.target)) return;
                      const ids = selectedIdsRef.current;
                      if (ids.length < 2 || !ids.includes(line.id)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setLineSelectionContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        count: ids.length,
                      });
                    }}
                      onClick={() => {
                      if (lineGestureConsumedRef.current) {
                        lineGestureConsumedRef.current = false;
                        return;
                      }
                      abortSequentialOnLeaveLine(line.id);
                      onSelectedId(line.id);
                      syncPanelFromLine(line);
                    }}
                  >
                    {generating ? <GenRing /> : null}
                    <div className="line-item-body">
                    <div className="line-meta">
                      <span
                        className="drag-handle"
                        title="ドラッグで並べ替え（複数選択時はまとめて移動）"
                        onPointerDown={(e) => onHandlePointerDown(e, line.id)}
                        onClick={(e) => {
                          e.stopPropagation();
                          lineGestureConsumedRef.current = false;
                        }}
                      >
                        ⋮⋮
                      </span>
                      <span className="line-idx" title="ドラッグで範囲選択">
                        {i + 1}
                      </span>
                      <SpeakerSelect
                        className="speaker-select"
                        speakers={speakers}
                        value={line.speakerEmbedPath}
                        displayLabel={lineSpeakerDisplayLabel(line, speakers)}
                        emptyLabel="話者を選択…"
                        placeholder="話者を選択…"
                        searchable
                        searchPlaceholder="話者を検索…"
                        aria-label={`行 ${i + 1} の話者`}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(v) => {
                          const sp = speakers.find((s) => s.embedPath === v);
                          void updateLine(line.id, {
                            speakerEmbedPath: v,
                            speakerName: sp?.name ?? "",
                          });
                        }}
                      />
                      <div className="line-meta-trail">
                      <SpeakerApplyMenu
                        lineNumber={i + 1}
                        disabled={busy}
                        onApplyAll={() => applySpeakerToAll(line)}
                        onApplyParity={() => applySpeakerToParity(line, i)}
                        onApplyFromHere={() => applySpeakerFromHere(line, i)}
                      />
                      <div className="line-meta-status">
                      {lineNeedsRegen && (
                        <span className="badge dirty asr-badge">
                          要再生成
                          <DirtyDiffTooltip groups={dirtyGroups} />
                        </span>
                      )}
                      {asrResult && asrIsAlert(asrResult) && (
                          <AsrBadge result={asrResult} />
                        )}
                      {lineVariants.length > 0 &&
                        (canCullOthers ? (
                          <button
                            type="button"
                            className="badge variant-count variant-keep-action action-aura danger"
                            title="チェックした音声だけ残し、他を削除"
                            disabled={busy && busyLineId === line.id}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              void keepOnlyVariants(
                                line.id,
                                new Set(keptVariantIds),
                              );
                            }}
                          >
                            他を削除
                          </button>
                        ) : (
                          <span className="badge variant-count">
                            {lineVariants.length}本保持中
                          </span>
                        ))}
                      {asrResult && !asrIsAlert(asrResult) && (
                          <AsrBadge result={asrResult} />
                        )}
                      </div>
                      <div className="line-meta-hover">
                      <div className="line-actions">
                        <button
                          type="button"
                          className={`line-btn line-btn-play${
                            isSelectedLine && !hasKeptAudio && !generating
                              ? " action-aura"
                              : ""
                          }`}
                          disabled={busy && busyLineId !== line.id}
                          title="再生/一時停止（右クリックで上書き生成・追加生成）"
                          onClick={(e) => {
                            e.stopPropagation();
                            void playSingleLine(line.id);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setLinePlayContextMenu({
                              lineId: line.id,
                              x: e.clientX,
                              y: e.clientY,
                            });
                          }}
                        >
                          {generating
                            ? "…"
                            : isLinePlayingNow
                              ? "❚❚"
                              : "▶"}
                        </button>
                        <button
                          type="button"
                          className="line-btn"
                          title="読み提案"
                          disabled={busy || asrBusy || !line.text.trim()}
                          onClick={(e) => {
                            e.stopPropagation();
                            void openAnnotationReview(line);
                          }}
                        >
                          読
                        </button>
                        <button
                          type="button"
                          className="line-btn"
                          title="文字起こし検証"
                          disabled={busy || asrBusy || !line.wavPath}
                          onClick={(e) => {
                            e.stopPropagation();
                            void runAsrVerifyLine(line);
                          }}
                        >
                          文
                        </button>
                        <button
                          type="button"
                          className="line-btn"
                          title="この行の音声を保存（複数本はまとめて出力）"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void saveLine(line);
                          }}
                        >
                          <IconSave />
                        </button>
                        <button
                          type="button"
                          className="line-btn line-btn-delete danger"
                          title="削除"
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteLine(line.id);
                          }}
                        >
                          <IconTrash />
                        </button>
                      </div>
                      </div>
                      </div>
                    </div>
                    <AutoTextarea
                      value={line.text}
                      onChange={(text) => void updateLine(line.id, { text })}
                      onDraftChange={(text) => {
                        lineDraftsRef.current.set(line.id, text);
                        scheduleAnnotationRefresh();
                      }}
                      onFocusLine={() => {
                        abortSequentialOnLeaveLine(line.id);
                        onSelectedId(line.id);
                        syncPanelFromLine(line);
                      }}
                      canMergePrev={i > 0}
                      pendingAnnotations={annotationsByLine[line.id]}
                      appliedReadings={validateReadings(
                        lineDraftsRef.current.get(line.id) ?? line.text,
                        line.readings ?? [],
                      )}
                      onApplyAnnotation={(annotation, reading) =>
                        void applyAnnotationReading(line.id, annotation, reading)
                      }
                      onUndoReading={(readingId) =>
                        void undoReading(line.id, readingId)
                      }
                      autoReplaceEntries={autoReplaceEntries}
                      focusRequest={
                        lineFocusRequest?.lineId === line.id
                          ? lineFocusRequest
                          : null
                      }
                      insertRequest={
                        emojiInsert && emojiInsert.lineId === line.id
                          ? emojiInsert
                          : null
                      }
                      onInsertConsumed={onEmojiInsertConsumed}
                      onSplit={(before, after) =>
                        splitLineAt(line.id, before, after)
                      }
                      onMergePrev={(text) =>
                        mergeLineWithPrevious(line.id, text)
                      }
                    />
                    {showLineSeek ? (
                      <div
                        className="variant-seek-stack"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {lineVariants.map((variant, vi) => {
                          const isActive =
                            isPlayingLine &&
                            playback?.variantId === variant.id;
                          const isPlayingVariant =
                            isActive && !!playback?.playing;
                          const durationKey = variantDurationKey(
                            line.id,
                            variant.id,
                            line.speed,
                          );
                          const duration =
                            isActive && playback && playback.duration > 0
                              ? playback.duration
                              : (variantDurations[durationKey] ?? 0);
                          const currentTime =
                            isActive && playback?.playing
                              ? playback.currentTime
                              : seekDraft?.lineId === line.id &&
                                  seekDraft.variantId === variant.id
                                ? seekDraft.time
                                : isActive && playback
                                  ? playback.currentTime
                                  : 0;
                          const showKeepCheck = lineVariants.length > 1;
                          const isKept =
                            showKeepCheck &&
                            keptVariantIds.includes(variant.id);
                          const variantDiffs = variantDirtyDiffs(
                            line,
                            variant,
                            speakers,
                          );
                          const variantStale = variantDiffs.length > 0;
                          return (
                            <div
                              className={`variant-seek-row${
                                showKeepCheck ? " multi" : ""
                              }${isKept ? " is-kept" : ""}${
                                variantStale ? " is-stale" : ""
                              }`}
                              key={variant.id}
                            >
                              {showKeepCheck ? (
                                <label
                                  className="variant-keep-check"
                                  title="残す音声として選択"
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isKept}
                                    aria-label={`バリアント ${vi + 1} を残す`}
                                    onChange={() =>
                                      toggleVariantKeep(line.id, variant.id)
                                    }
                                  />
                                </label>
                              ) : null}
                              <button
                                type="button"
                                className="line-btn variant-play-btn"
                                title={`バリアント ${vi + 1} を再生`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void playVariant(line.id, variant.id);
                                }}
                              >
                                {isPlayingVariant ? "❚❚" : "▶"}
                              </button>
                              <div
                                className={`variant-seek-track${
                                  variantStale ? " is-stale-track asr-badge" : ""
                                }`}
                              >
                                <input
                                  type="range"
                                  min={0}
                                  max={duration || 0}
                                  step={0.01}
                                  value={Math.min(currentTime, duration || 0)}
                                  disabled={duration <= 0}
                                  onPointerDown={() => {
                                    userSeekingKeyRef.current = `${line.id}:${variant.id}`;
                                  }}
                                  onChange={(e) => {
                                    const time = Number(e.target.value);
                                    setSeekDraft({
                                      lineId: line.id,
                                      variantId: variant.id,
                                      time,
                                    });
                                    if (
                                      userSeekingKeyRef.current !==
                                      `${line.id}:${variant.id}`
                                    ) {
                                      return;
                                    }
                                    void seekVariant(line, variant, time);
                                  }}
                                  onPointerUp={() => {
                                    if (
                                      userSeekingKeyRef.current ===
                                      `${line.id}:${variant.id}`
                                    ) {
                                      userSeekingKeyRef.current = null;
                                    }
                                    window.setTimeout(() => {
                                      setSeekDraft((d) => {
                                        if (
                                          !d ||
                                          d.lineId !== line.id ||
                                          d.variantId !== variant.id
                                        ) {
                                          return d;
                                        }
                                        const p = playerRef.current;
                                        if (
                                          p?.isActiveVariant(
                                            d.lineId,
                                            d.variantId,
                                          ) &&
                                          p.hasBuffer
                                        ) {
                                          return null;
                                        }
                                        return d;
                                      });
                                    }, 0);
                                  }}
                                />
                                <span className="seek-time">
                                  {duration > 0
                                    ? `${currentTime.toFixed(1)} / ${duration.toFixed(1)}s`
                                    : `seed ${variant.seed}`}
                                </span>
                                {variantStale ? (
                                  <DirtyDiffTooltip diffs={variantDiffs} />
                                ) : null}
                              </div>
                              <button
                                type="button"
                                className="line-btn danger variant-delete-btn"
                                title="この音声を削除"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void deleteVariant(line.id, variant.id);
                                }}
                              >
                                <IconTrash />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    </div>
                  </div>
                );
              })}
              <div className="line-list-drop-spacer" />
              <div className="line-list-drop-cue">
                <span>ファイル（.txt .md .docx .pdf）をここにドロップしてインポート</span>
                <button
                  type="button"
                  className="doc-drop-browse"
                  onClick={() => docFileInputRef.current?.click()}
                >
                  ファイルを選択
                </button>
              </div>
            </div>

            <button
              type="button"
              className="fab overlay-fab"
              title="空の行を追加"
              onClick={() => void addEmptyLine()}
            >
              <span className="fab-plus">+</span>
            </button>
          </div>

          <div className="status-bar">
            <span>{status || workerInfo}</span>
          </div>
        </div>
      </main>

      <aside className="params-panel">
        <SamplingPanel
          value={panelSampling}
          onChange={onPanelSampling}
          collapsed={samplingCollapsed}
          onToggle={() => setSamplingCollapsed((v) => !v)}
          onApplyAll={applySamplingToAll}
          onApplySameSpeaker={applySamplingToSameSpeaker}
        />
        <AudioAdjustmentPanel
          volume={selected?.volume ?? 1}
          speed={selected?.speed ?? 1}
          audioFx={selected ? audioFxOf(selected) : undefined}
          disabled={!selected}
          collapsed={audioCollapsed}
          onToggle={() => setAudioCollapsed((v) => !v)}
          onChange={(patch) => {
            if (!selected) return;
            void updateLine(selected.id, patch);
          }}
          onApplyAll={applyAudioToAll}
          onApplySameSpeaker={applyAudioToSameSpeaker}
        />
        {showLineCaption && (
          <CaptionPanel
            value={selected ? lineCaptionOf(selected) : ""}
            cfgScaleCaption={
              selected
                ? lineCfgScaleCaption(selected)
                : DEFAULT_CFG_SCALE_CAPTION
            }
            disabled={!selected}
            collapsed={captionCollapsed}
            onToggle={() => setCaptionCollapsed((v) => !v)}
            onChange={(patch) => {
              if (!selected) return;
              void updateLine(selected.id, patch);
            }}
            onApplyAll={applyCaptionToAll}
            onApplySameSpeaker={applyCaptionToSameSpeaker}
          />
        )}
      </aside>

      {bulkAddOpen && (
        <BulkAddDialog
          speakers={speakers}
          onConfirm={(lines, opts) =>
            void addLinesFromTexts(lines, { replace: opts?.replace })
          }
          onCancel={() => {
            setBulkAddOpen(false);
            setBulkAddInitialFile(undefined);
          }}
          initialFile={bulkAddInitialFile}
        />
      )}

      {replacePreview && (
        <div
          className="modal-backdrop"
          onClick={() => setReplacePreview(null)}
        >
          <div
            className="modal panel replace-preview-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="panel-header">
              <h3>語句置換の確認</h3>
            </header>
            <div className="panel-body form-stack">
              <p>
                {
                  replacePreview.changes.filter(
                    (c) => replacePreview.selected[c.lineId],
                  ).length
                }{" "}
                / {replacePreview.changes.length} 行（選択中{" "}
                {replacePreview.changes
                  .filter((c) => replacePreview.selected[c.lineId])
                  .reduce((s, c) => s + c.count, 0)}{" "}
                箇所）を置換します。
              </p>
              <div className="row">
                <button
                  type="button"
                  onClick={() =>
                    setReplacePreview((prev) => {
                      if (!prev) return prev;
                      const selected: Record<string, boolean> = {};
                      for (const c of prev.changes) selected[c.lineId] = true;
                      return { ...prev, selected };
                    })
                  }
                >
                  すべて選択
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setReplacePreview((prev) => {
                      if (!prev) return prev;
                      const selected: Record<string, boolean> = {};
                      for (const c of prev.changes) selected[c.lineId] = false;
                      return { ...prev, selected };
                    })
                  }
                >
                  すべて解除
                </button>
              </div>
              <ul className="bulk-add-preview replace-preview-list">
                {replacePreview.changes.map((c, i) => {
                  const lineNo =
                    (project?.lines.findIndex((l) => l.id === c.lineId) ?? i) +
                    1;
                  return (
                    <li key={c.lineId} className="replace-preview-item">
                      <label className="replace-preview-check">
                        <input
                          type="checkbox"
                          checked={!!replacePreview.selected[c.lineId]}
                          onChange={(ev) => {
                            const checked = ev.target.checked;
                            setReplacePreview((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    selected: {
                                      ...prev.selected,
                                      [c.lineId]: checked,
                                    },
                                  }
                                : prev,
                            );
                          }}
                        />
                        <span className="hint">
                          {lineNo}行 · {c.count}箇所
                        </span>
                      </label>
                      <div className="replace-snippets">
                        {c.snippets.map((sn, si) => (
                          <div key={si} className="replace-snippet">
                            <span className="replace-snippet-side">
                              {sn.before.slice(0, sn.beforeHi.start)}
                              <strong className="replace-hi">
                                {sn.before.slice(
                                  sn.beforeHi.start,
                                  sn.beforeHi.end,
                                )}
                              </strong>
                              {sn.before.slice(sn.beforeHi.end)}
                            </span>
                            <span className="replace-arrow">→</span>
                            <span className="replace-snippet-side">
                              {sn.after.slice(0, sn.afterHi.start)}
                              <strong className="replace-hi">
                                {sn.after.slice(
                                  sn.afterHi.start,
                                  sn.afterHi.end,
                                )}
                              </strong>
                              {sn.after.slice(sn.afterHi.end)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
            <footer className="panel-footer row">
              <button
                type="button"
                className="primary"
                disabled={
                  !replacePreview.changes.some(
                    (c) => replacePreview.selected[c.lineId],
                  )
                }
                onClick={() => void applyReplacePreview()}
              >
                選択行を適用
              </button>
              <button type="button" onClick={() => setReplacePreview(null)}>
                キャンセル
              </button>
            </footer>
          </div>
        </div>
      )}

      {annotationReview && (
        <AnnotationReviewDialog
          items={annotationReview.items}
          modes={numericModes}
          onModesChange={setNumericModes}
          onCancel={() => setAnnotationReview(null)}
          onApply={(updates) => {
            const reviewItems = annotationReview.items;
            setAnnotationReview(null);
            void (async () => {
              const map = new Map(updates.map((u) => [u.lineId, u.readings]));
              const existingIds = new Set<string>();
              for (const item of reviewItems) {
                for (const r of item.applied) existingIds.add(r.id);
              }
              const novelSpecs: {
                kind: string;
                surface: string;
                reading: string;
                candidateReadings: string[];
              }[] = [];
              for (const u of updates) {
                const item = reviewItems.find((it) => it.lineId === u.lineId);
                for (const r of u.readings) {
                  if (existingIds.has(r.id)) continue;
                  const ann = item?.annotations.find(
                    (a) =>
                      a.start === r.start &&
                      a.end === r.end &&
                      a.surface === r.surface,
                  );
                  novelSpecs.push({
                    kind: r.kind,
                    surface: r.surface,
                    reading: r.reading,
                    candidateReadings: (ann?.candidates ?? []).map(
                      (c) => c.reading,
                    ),
                  });
                }
              }
              await persistNovelReadingDict(novelSpecs);
              await persist((prev) => ({
                ...prev,
                lines: prev.lines.map((l) => {
                  const readings = map.get(l.id);
                  if (readings === undefined) return l;
                  return { ...l, readings };
                }),
              }));
              invalidateAsrMany([...map.keys()]);
              setStatus(
                updates.length > 1
                  ? `読みを ${updates.length} 行に適用しました`
                  : "読みを適用しました",
              );
              void refreshAnnotations();
            })();
          }}
        />
      )}

      {batchSaveOpen && (
        <div
          className="modal-backdrop"
          onClick={() => !batchSaving && setBatchSaveOpen(false)}
        >
          <div
            className="modal panel batch-save-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="panel-header">
              <h3>一括保存</h3>
            </header>
            <div className="panel-body form-stack">
              <label>
                保存先フォルダ
                <div className="row">
                  <input
                    value={batchFolder}
                    onChange={(e) => setBatchFolder(e.target.value)}
                    placeholder="保存先を選択…"
                    disabled={batchSaving}
                  />
                  <button
                    type="button"
                    onClick={() => void pickBatchFolder()}
                    disabled={batchSaving}
                  >
                    参照
                  </button>
                </div>
              </label>
              <label>
                保存タイプ
                <BoundedSelect
                  value={batchMode}
                  options={[
                    { value: "individual", label: "個別保存" },
                    { value: "concat", label: "連結保存" },
                  ]}
                  onChange={(v) => setBatchMode(v as BatchSaveMode)}
                  disabled={batchSaving}
                  aria-label="保存タイプ"
                />
              </label>
              {batchMode === "individual" && (
                <p className="hint">
                  1行に複数の音声があるときは、番号を 001-1, 001-2 のように枝番付きで保存します。行の保存ボタンでも同じ規則です。
                </p>
              )}
              <label>
                出力形式
                <BoundedSelect
                  value={batchFormat}
                  options={EXPORT_AUDIO_FORMATS.map((f) => ({
                    value: f,
                    label: EXPORT_AUDIO_FORMAT_LABELS[f],
                  }))}
                  onChange={(v) => setBatchFormat(v as ExportAudioFormat)}
                  disabled={batchSaving}
                  aria-label="出力形式"
                />
              </label>
              {batchFormat !== "wav" && (
                <p className="hint">
                  {batchFormat === "mp3" ? "MP3" : "Opus"}{" "}
                  {exportBitrateKbps(batchFormat, settings)} kbps（設定の再生・保存で変更）
                </p>
              )}
              {batchMode === "concat" && (
                <>
                  <label>
                    連結時の無音区間（秒）
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={batchSilenceSecs}
                      onChange={(e) => setBatchSilenceSecs(e.target.value)}
                      disabled={batchSaving}
                    />
                  </label>
                  <label>
                    字幕出力
                    <BoundedSelect
                      value={batchSubtitle}
                      options={[
                        { value: "none", label: "なし" },
                        { value: "srt", label: "SRT" },
                        { value: "vtt", label: "VTT" },
                      ]}
                      onChange={(v) =>
                        setBatchSubtitle(v as BatchSubtitleMode)
                      }
                      disabled={batchSaving}
                      aria-label="字幕出力"
                    />
                  </label>
                  <label>
                    ラベル出力
                    <BoundedSelect
                      value={batchLabel}
                      options={[
                        { value: "none", label: "なし" },
                        { value: "audacity", label: "Audacity ラベル" },
                        { value: "reaper", label: "Reaper ラベル" },
                      ]}
                      onChange={(v) => setBatchLabel(v as BatchLabelMode)}
                      disabled={batchSaving}
                      aria-label="ラベル出力"
                    />
                  </label>
                </>
              )}
            </div>
            <footer className="panel-footer row">
              <button
                type="button"
                className="primary"
                disabled={batchSaving || !batchFolder.trim()}
                onClick={() => void runBatchSave()}
              >
                {batchSaving ? "保存中…" : "保存"}
              </button>
              <button
                type="button"
                disabled={batchSaving}
                onClick={() => setBatchSaveOpen(false)}
              >
                キャンセル
              </button>
            </footer>
          </div>
        </div>
      )}

      {projectGateOpen && (
        <div
          className="modal-backdrop"
          onClick={() => !gateBusy && setProjectGateOpen(false)}
        >
          <div
            className="modal panel project-gate-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="panel-header">
              <h3>プロジェクト展開</h3>
              <button
                type="button"
                disabled={gateBusy}
                onClick={() => setProjectGateOpen(false)}
              >
                閉じる
              </button>
            </header>
            <div className="panel-body">
              <p className="project-gate-hint">
                開いているプロジェクトは自動保存されます。新規作成するか、既存プロジェクトを追加のタブで開いてください。
              </p>
              <ProjectGatePanels
                newName={gateNameDraft}
                onNewName={setGateNameDraft}
                onCreate={() => void createProjectByName(gateNameDraft)}
                existingNames={existingProjects}
                selectedName={loadPickName}
                onSelectName={setLoadPickName}
                onLoad={() => void loadProjectByName(loadPickName)}
                onDelete={(name) => void deleteProjectByName(name)}
                status={status}
                disabled={gateBusy}
                openNames={openProjects.map((p) => p.name)}
              />
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmModal
          message={confirm.message}
          onYes={() => {
            const fn = confirm.onYes;
            setConfirm(null);
            fn();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {linePlayContextMenu &&
        createPortal(
          <div
            className="project-tab-context-menu line-play-context-menu"
            role="menu"
            style={{
              left: Math.max(
                8,
                Math.min(linePlayContextMenu.x, window.innerWidth - 260),
              ),
              top: Math.max(
                8,
                Math.min(linePlayContextMenu.y, window.innerHeight - 88),
              ),
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {(() => {
              const ctxLine = project.lines.find(
                (l) => l.id === linePlayContextMenu.lineId,
              );
              const n = ctxLine ? candidateCountForLine(ctxLine) : 1;
              return (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy || batchSaving || gateBusy}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      const line = projectRef.current?.lines.find(
                        (l) => l.id === linePlayContextMenu.lineId,
                      );
                      setLinePlayContextMenu(null);
                      if (line) requestOverwriteGenerate(line);
                    }}
                  >
                    上書き生成（{n}件）
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy || batchSaving || gateBusy}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      const line = projectRef.current?.lines.find(
                        (l) => l.id === linePlayContextMenu.lineId,
                      );
                      setLinePlayContextMenu(null);
                      if (line) requestAppendGenerate(line);
                    }}
                  >
                    追加生成（{n}件）
                  </button>
                </>
              );
            })()}
          </div>,
          document.body,
        )}

      {lineSelectionContextMenu &&
        createPortal(
          <div
            className="project-tab-context-menu line-play-context-menu"
            role="menu"
            style={{
              left: Math.max(
                8,
                Math.min(lineSelectionContextMenu.x, window.innerWidth - 260),
              ),
              top: Math.max(
                8,
                Math.min(lineSelectionContextMenu.y, window.innerHeight - 56),
              ),
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              type="button"
              role="menuitem"
              className="danger"
              disabled={busy || batchSaving || gateBusy}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                setLineSelectionContextMenu(null);
                deleteMultiSelectedLines();
              }}
            >
              選択行を削除（{lineSelectionContextMenu.count} 行）
            </button>
          </div>,
          document.body,
        )}

      {tabContextMenu &&
        createPortal(
          <div
            className="project-tab-context-menu"
            role="menu"
            style={{
              left: Math.max(
                8,
                Math.min(tabContextMenu.x, window.innerWidth - 220),
              ),
              top: Math.max(
                8,
                Math.min(tabContextMenu.y, window.innerHeight - 56),
              ),
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              type="button"
              role="menuitem"
              disabled={busy || batchSaving || gateBusy}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                void duplicateOpenProject(tabContextMenu.name);
              }}
            >
              プロジェクトのコピーを作成
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
