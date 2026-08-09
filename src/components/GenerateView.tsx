import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  AppSettings,
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
  samplingEqual,
} from "../types";
import { SamplingPanel } from "./SamplingPanel";
import { AudioAdjustmentPanel } from "./AudioAdjustmentPanel";
import { CaptionPanel } from "./CaptionPanel";
import { BulkAddDialog } from "./BulkAddDialog";
import { KatakanaReviewDialog } from "./KatakanaReviewDialog";
import { BoundedSelect } from "./BoundedSelect";
import { EmojiPalette } from "./EmojiPalette";
import { BatchMoreMenu } from "./BatchMoreMenu";
import { lineExportFileName } from "../lib/exportFileName";
import { SpeakerApplyMenu } from "./SpeakerApplyMenu";
import { IconSave, IconTrash } from "./icons";
import { LineAudioPlayer, type PlaybackSnapshot } from "../lib/audioPlayer";
import type { KatakanaHit } from "../lib/katakanaApply";
import type { ImportedLine } from "../lib/scriptImport";
import {
  applyAutoReplacements,
  previewReplacements,
  type ReplaceEntry,
  type ReplaceSnippet,
} from "../lib/replaceApply";
import type { Dictionaries } from "../lib/dictionaries";
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

/** Style caption UI / synth only for v4 参照音源 speakers. */
function usesStyleCaption(speaker: SpeakerInfo | null | undefined): boolean {
  return speaker?.kind === "ref";
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

function isDirty(line: ProjectLine, speakers: SpeakerInfo[]): boolean {
  if (!line.wavPath) return true;
  if ((line.generatedText ?? "") !== line.text) return true;
  const key = speakerConditionKey(speakers, line.speakerEmbedPath);
  if ((line.generatedSpeakerEmbedPath ?? "") !== key) return true;
  const caption = effectiveLineCaption(line, speakers);
  if ((line.generatedCaption ?? "") !== caption) return true;
  if (caption || (line.generatedCaption ?? "")) {
    const genCfg =
      line.generatedCfgScaleCaption ?? DEFAULT_CFG_SCALE_CAPTION;
    if (genCfg !== effectiveCfgScaleCaption(line, speakers)) return true;
  }
  if (
    line.generatedSampling != null &&
    !samplingEqual(line.sampling, line.generatedSampling)
  ) {
    return true;
  }
  return false;
}

/** Legacy projects: assume current sampling matches the existing wav. */
function backfillGeneratedSampling(p: Project): Project {
  let changed = false;
  const lines = p.lines.map((l) => {
    if (l.wavPath && l.generatedSampling == null) {
      changed = true;
      return { ...l, generatedSampling: { ...l.sampling } };
    }
    return l;
  });
  return changed ? { ...p, lines } : p;
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
function wavPathMatchesLine(line: ProjectLine): boolean {
  if (!line.wavPath) return false;
  const norm = line.wavPath.replace(/\//g, "\\").toLowerCase();
  const id = line.id.toLowerCase();
  return norm.endsWith(`\\${id}.wav`) || norm.endsWith(`/${id}.wav`);
}

function lineContentKey(
  text: string,
  speakerKey: string,
  caption = "",
  cfgScaleCaption = DEFAULT_CFG_SCALE_CAPTION,
  sampling: SamplingParams | null | undefined = null,
) {
  const samp = sampling ? JSON.stringify(sampling) : "";
  return `${speakerKey}\0${text}\0${caption}\0${cfgScaleCaption}\0${samp}`;
}

function joinPath(dir: string, name: string) {
  const sep = /\\/.test(dir) && !/\//.test(dir) ? "\\" : "/";
  return `${dir.replace(/[/\\]+$/, "")}${sep}${name}`;
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

export type HomographHitUi = {
  surface: string;
  start: number;
  end: number;
  note?: string | null;
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
  highlightHits,
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
  highlightHits?: HomographHitUi[];
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
    el.style.height = "0px";
    // scrollHeight includes padding, not border — add border for border-box
    const needed = el.scrollHeight + borderY;
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

  return (
    <div className="line-text-wrap">
      {!focused && highlightHits && highlightHits.length > 0 ? (
        <div
          className="line-text line-text-display"
          onClick={(e) => {
            e.stopPropagation();
            ref.current?.focus();
          }}
          title="クリックで編集"
        >
          {renderHighlighted(draft, highlightHits)}
        </div>
      ) : null}
      <textarea
      ref={ref}
      className={`line-text ${
        !focused && highlightHits && highlightHits.length > 0
          ? "line-text-editing-hidden"
          : ""
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
      onClick={(e) => {
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

function renderHighlighted(text: string, hits: HomographHitUi[]) {
  const sorted = [...hits].sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((h, i) => {
    const start = Math.max(0, Math.min(h.start, text.length));
    const end = Math.max(start, Math.min(h.end, text.length));
    if (start < cursor) return;
    if (start > cursor) {
      parts.push(<span key={`t-${i}-${cursor}`}>{text.slice(cursor, start)}</span>);
    }
    const tip = h.note?.trim()
      ? `同形異音警告 — ${h.note}`
      : "同形異音警告";
    parts.push(
      <mark key={`h-${i}-${start}`} className="homograph-mark" title={tip}>
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) {
    parts.push(<span key="tail">{text.slice(cursor)}</span>);
  }
  return parts.length > 0 ? parts : text;
}

function elCaretAtStart(el: HTMLTextAreaElement) {
  return el.selectionStart === 0 && el.selectionEnd === 0;
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
                  <li key={name}>
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
                      <span>{name}</span>
                      {isOpen && (
                        <span className="project-pick-badge">開いています</span>
                      )}
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
  const [batchSaving, setBatchSaving] = useState(false);
  const [bulkAddOpen, setBulkAddOpen] = useState(false);
  const [katakanaReview, setKatakanaReview] = useState<{
    items: {
      lineId: string;
      text: string;
      hits: KatakanaHit[];
      label: string;
    }[];
  } | null>(null);
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
  const [homoByLine, setHomoByLine] = useState<
    Record<string, HomographHitUi[]>
  >({});
  const [asrByLine, setAsrByLine] = useState<Record<string, AsrLineResult>>(
    {},
  );
  const [asrBusy, setAsrBusy] = useState(false);
  const [autoReplaceEntries, setAutoReplaceEntries] = useState<ReplaceEntry[]>(
    [],
  );

  const reloadAutoReplaceDict = useCallback(async () => {
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
    void reloadAutoReplaceDict();
  }, [reloadAutoReplaceDict]);

  useEffect(() => {
    const onFocus = () => void reloadAutoReplaceDict();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadAutoReplaceDict]);

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
  const [samplingByProject, setSamplingByProject] = useState<
    Record<string, SamplingParams>
  >({});
  const [tabRename, setTabRename] = useState<string | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiInsert, setEmojiInsert] = useState<{
    nonce: number;
    emoji: string;
    lineId: string;
  } | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const projectRef = useRef(project);
  const selectedIdRef = useRef<string | null>(null);
  const lineListRef = useRef<HTMLDivElement>(null);
  const speakersRef = useRef(speakers);
  speakersRef.current = speakers;

  const selectedId = project
    ? (selectedByProject[project.name] ?? null)
    : null;
  const panelSampling = project
    ? (samplingByProject[project.name] ?? project.defaultSampling)
    : defaultSampling();
  selectedIdRef.current = selectedId;

  const speakerOptions = useMemo(
    () => [
      { value: "", label: "話者を選択…" },
      ...speakers.map((s) => ({
        value: s.embedPath,
        label: speakerOptionLabel(s),
      })),
    ],
    [speakers],
  );

  const displayLines = useMemo(() => {
    if (!project) return [];
    if (!dragOrder) return project.lines;
    const map = new Map(project.lines.map((l) => [l.id, l]));
    return dragOrder
      .map((id) => map.get(id))
      .filter((l): l is ProjectLine => !!l);
  }, [project, dragOrder]);

  const onSelectedId = useCallback((id: string | null) => {
    const name = projectRef.current?.name;
    if (!name) return;
    setSelectedByProject((prev) => ({ ...prev, [name]: id }));
  }, []);

  const onPanelSampling = useCallback((s: SamplingParams) => {
    const name = projectRef.current?.name;
    if (!name) return;
    setSamplingByProject((prev) => ({ ...prev, [name]: s }));
  }, []);

  const playerRef = useRef<LineAudioPlayer | null>(null);
  const persistChain = useRef(Promise.resolve());
  const skipSamplingAutoApply = useRef(false);
  const speedTimer = useRef<number | null>(null);
  const lineDraftsRef = useRef<Map<string, string>>(new Map());
  const synthInflight = useRef(
    new Map<string, Promise<{ wav: string; line: ProjectLine } | null>>(),
  );
  /** Survives flaky project state — prevents repeat synth for same content. */
  const readyCacheRef = useRef(
    new Map<string, { key: string; wavPath: string }>(),
  );
  const playGenRef = useRef(0);
  /** Bumped to abort an in-flight `playBatch` loop. */
  const batchPlayGenRef = useRef(0);
  const batchPlayActiveRef = useRef(false);
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    fromIndex: number;
    currentIndex: number;
    order: string[];
  } | null>(null);
  const dragListenersRef = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
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
            line.text,
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
      onChange: setPlayback,
    });
    return () => {
      batchPlayGenRef.current += 1;
      batchPlayActiveRef.current = false;
      playerRef.current?.stop(true);
      if (speedTimer.current) window.clearTimeout(speedTimer.current);
    };
  }, []);

  /** Abort sequential batch playback so single-line / edit ops take over. */
  const cancelBatchPlayback = (opts?: { stopAudio?: boolean }) => {
    batchPlayGenRef.current += 1;
    playGenRef.current += 1;
    if (opts?.stopAudio) {
      playerRef.current?.stop(true);
    } else {
      playerRef.current?.cancelSilence();
      playerRef.current?.releaseEndedWaiters();
    }
    if (batchPlayActiveRef.current) {
      batchPlayActiveRef.current = false;
      setStatus("一括再生を停止");
    }
  };

  const selected = useMemo(
    () => project?.lines.find((l) => l.id === selectedId) ?? null,
    [project, selectedId],
  );

  const selectedSpeaker = useMemo(
    () =>
      speakers.find((s) => s.embedPath === selected?.speakerEmbedPath) ?? null,
    [speakers, selected?.speakerEmbedPath],
  );

  /** v4 only: per-line style caption for 参照音源 speakers. */
  const showLineCaption =
    isIrodoriV4(settings) && usesStyleCaption(selectedSpeaker);

  const captionOpen = showLineCaption && !captionCollapsed;
  const paramsPanelClass = [
    "params-panel",
    captionOpen && !samplingCollapsed ? "equalize-sc" : "",
  ]
    .filter(Boolean)
    .join(" ");

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
    if (!project.lines.some((l) => l.wavPath && l.generatedSampling == null))
      return;
    void persist((prev) => backfillGeneratedSampling(prev), false);
  }, [project, persist]);

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

  // Live volume while playing
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !selected || player.activeLineId !== selected.id) return;
    player.setVolume(selected.volume);
  }, [selected?.volume, selected?.id]);

  // Speed: debounce during playback only (ffmpeg atempo). Do not run on wavPath changes.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !selected || player.activeLineId !== selected.id) return;
    if (!player.isPlaying && !player.hasBuffer) return;
    if (!selected.wavPath || !wavPathMatchesLine(selected)) return;

    if (speedTimer.current) window.clearTimeout(speedTimer.current);
    const wavPath = selected.wavPath;
    const speed = selected.speed;
    const lineId = selected.id;
    const gen = playGenRef.current;
    speedTimer.current = window.setTimeout(() => {
      void (async () => {
        try {
          if (gen !== playGenRef.current) return;
          const playPath = await invoke<string>("prepare_playback_wav", {
            src: wavPath,
            speed,
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
          setStatus(`速度反映失敗: ${e}`);
        }
      })();
    }, 280);

    return () => {
      if (speedTimer.current) window.clearTimeout(speedTimer.current);
    };
  }, [selected?.speed, selected?.id]);

  // Auto-apply sampling to selected line (serialized, skip when syncing from line→panel)
  useEffect(() => {
    if (skipSamplingAutoApply.current) {
      skipSamplingAutoApply.current = false;
      return;
    }
    const id = selectedIdRef.current;
    if (!id) return;
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
    skipSamplingAutoApply.current = true;
    onPanelSampling(line.sampling);
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

  const openProjectsRef = useRef(openProjects);
  openProjectsRef.current = openProjects;

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

      const migrated = backfillGeneratedSampling(p);
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
        let wavPath: string | null = null;
        if (line.wavPath && wavPathMatchesLine(line)) {
          try {
            const ok = await invoke<boolean>("file_exists", {
              path: line.wavPath,
            });
            if (ok) {
              const dest = await invoke<string>("line_cache_wav_path", {
                projectName: newName,
                lineId: newId,
              });
              await invoke("copy_file", { src: line.wavPath, dest });
              wavPath = dest;
            }
          } catch {
            wavPath = null;
          }
        }
        lines.push({
          ...line,
          id: newId,
          wavPath,
          sampling: { ...line.sampling },
          generatedSampling: line.generatedSampling
            ? { ...line.generatedSampling }
            : line.generatedSampling,
        });
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
    };
    await persist((prevProj) => ({
      ...prevProj,
      lines: [...prevProj.lines, line],
    }));
    onSelectedId(line.id);
  };

  const addLinesFromTexts = async (imported: ImportedLine[]) => {
    if (!projectRef.current || imported.length === 0) return;
    const lines = projectRef.current.lines;
    const prev = lines.length > 0 ? lines[lines.length - 1] : null;
    const fallback = speakers[0];
    const vol = selected?.volume ?? 1;
    const spd = selected?.speed ?? 1;
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
      };
    });
    await persist((prevProj) => ({
      ...prevProj,
      lines: [...prevProj.lines, ...created],
    }));
    onSelectedId(created[0].id);
    const uniq = [...new Set(unmatched)];
    setStatus(
      uniq.length > 0
        ? `${created.length} 行を追加しました（未マッチ話者: ${uniq.join(", ")}）`
        : `${created.length} 行を追加しました`,
    );
    setBulkAddOpen(false);
  };

  const refreshHomographs = useCallback(async () => {
    const p = projectRef.current;
    if (!p) {
      setHomoByLine({});
      return;
    }
    const next: Record<string, HomographHitUi[]> = {};
    for (const line of p.lines) {
      const text = lineDraftsRef.current.get(line.id) ?? line.text;
      if (!text.trim()) {
        next[line.id] = [];
        continue;
      }
      try {
        const hits = await invoke<HomographHitUi[]>("detect_homographs_cmd", {
          text,
        });
        next[line.id] = hits;
      } catch {
        next[line.id] = [];
      }
    }
    setHomoByLine(next);
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
        line.text === asr.expectedText
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

  useEffect(() => {
    if (!project) return;
    const t = window.setTimeout(() => {
      void refreshHomographs();
    }, 450);
    return () => window.clearTimeout(t);
  }, [project?.lines, refreshHomographs]);

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
      void reloadAutoReplaceDict();
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
    void refreshHomographs();
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
    const text = lineDraftsRef.current.get(fresh.id) ?? fresh.text;
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
        const text = lineDraftsRef.current.get(line.id) ?? line.text;
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

  const openKatakanaReview = async (line: ProjectLine) => {
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
      setStatus("カタカナ提案を取得中…");
      const hits = await invoke<KatakanaHit[]>("suggest_katakana", { text });
      if (hits.length === 0) {
        setStatus("英単語が見つかりませんでした");
        return;
      }
      const idx = (p?.lines.findIndex((l) => l.id === fresh.id) ?? 0) + 1;
      setKatakanaReview({
        items: [
          {
            lineId: fresh.id,
            text,
            hits,
            label: `${idx} 行目`,
          },
        ],
      });
      setStatus("");
    } catch (e) {
      setStatus(String(e));
    }
  };

  const openKatakanaReviewBatch = async () => {
    commitDrafts();
    const p = projectRef.current;
    if (!p || p.lines.length === 0) {
      setStatus("カタカナ提案する行がありません");
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
      setStatus("カタカナ提案を取得中…");
      const items: {
        lineId: string;
        text: string;
        hits: KatakanaHit[];
        label: string;
      }[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        setStatus(`カタカナ提案を取得中… ${i + 1}/${candidates.length}`);
        const hits = await invoke<KatakanaHit[]>("suggest_katakana", {
          text: c.text,
        });
        if (hits.length > 0) {
          items.push({
            lineId: c.line.id,
            text: c.text,
            hits,
            label: c.label,
          });
        }
      }
      if (items.length === 0) {
        setStatus("英単語が見つかりませんでした");
        return;
      }
      setKatakanaReview({ items });
      setStatus("");
    } catch (e) {
      setStatus(String(e));
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
      if (nextLine === cur) return prev;
      // Skip no-op text/field writes (e.g. blur after split already persisted).
      const keys = Object.keys(patch) as (keyof ProjectLine)[];
      const same = keys.every((k) => {
        if (k === "sampling") {
          return (
            JSON.stringify(nextLine.sampling) === JSON.stringify(cur.sampling)
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

  const reorderIds = (ids: string[], from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) {
      return ids;
    }
    const next = [...ids];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  };

  const indexFromClientY = (clientY: number) => {
    const list = lineListRef.current;
    if (!list) return 0;
    const items = Array.from(
      list.querySelectorAll<HTMLElement>(".line-item[data-line-id]"),
    );
    if (items.length === 0) return 0;
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return items.length - 1;
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

  const endDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) {
        detachDragListeners();
        setDraggingId(null);
        setDragOrder(null);
        return;
      }
      const order = drag.order;
      const changed = commit && drag.fromIndex !== drag.currentIndex;
      dragRef.current = null;
      detachDragListeners();
      setDraggingId(null);
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

  // Safety: clear stuck drag only on unmount
  useEffect(() => () => endDragRef.current(false), []);

  const onHandlePointerDown = (
    e: ReactPointerEvent,
    lineId: string,
    index: number,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = projectRef.current;
    if (!p) return;

    // End any previous stuck session first
    if (dragRef.current) endDrag(false);

    const ids = p.lines.map((l) => l.id);
    const pointerId = e.pointerId;
    dragRef.current = {
      id: lineId,
      pointerId,
      fromIndex: index,
      currentIndex: index,
      order: ids,
    };
    setDraggingId(lineId);
    setDragOrder(ids);

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      ev.preventDefault();
      const toIndex = indexFromClientY(ev.clientY);
      if (toIndex === drag.currentIndex) return;
      const from = drag.order.indexOf(drag.id);
      if (from < 0) return;
      const next = reorderIds(drag.order, from, toIndex);
      drag.order = next;
      drag.currentIndex = next.indexOf(drag.id);
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

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(pointerId);
    } catch {
      /* capture optional — window listeners are the source of truth */
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
    askConfirm(
      `Volume ${volume.toFixed(2)} / Speed ${speed.toFixed(2)} を全行に適用します。よろしいですか？`,
      () => {
        void persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) => ({ ...l, volume, speed })),
        }));
        setStatus("全行に Audio Adjustment を一括適用");
      },
    );
  };

  const applyAudioToSameSpeaker = () => {
    if (!selected) return;
    const { volume, speed, speakerEmbedPath, speakerName } = selected;
    askConfirm(
      `Volume / Speed を話者「${speakerName || "未選択"}」の全行に適用します。よろしいですか？`,
      () => {
        void persist((prev) => ({
          ...prev,
          lines: prev.lines.map((l) =>
            l.speakerEmbedPath === speakerEmbedPath
              ? { ...l, volume, speed }
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

  const synthesizeLine = async (
    line: ProjectLine,
    opts: { force?: boolean } = {},
  ): Promise<{ wav: string; line: ProjectLine } | null> => {
    const force = opts.force === true;
    const inflight = synthInflight.current.get(line.id);
    if (inflight) return inflight;

    let settle!: (v: { wav: string; line: ProjectLine } | null) => void;
    const gate = new Promise<{ wav: string; line: ProjectLine } | null>(
      (r) => {
        settle = r;
      },
    );
    // Register BEFORE any await so concurrent callers join this run
    synthInflight.current.set(line.id, gate);

    const finish = (v: { wav: string; line: ProjectLine } | null) => {
      synthInflight.current.delete(line.id);
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
      const s =
        fresh.id === selectedIdRef.current ? panelSampling : fresh.sampling;
      const contentKey = lineContentKey(
        fresh.text,
        speakerKey,
        captionUsed,
        cfgCaptionUsed,
        s,
      );
      const outPath = await invoke<string>("line_cache_wav_path", {
        projectName: p.name,
        lineId: fresh.id,
      });

      // Skip worker if this exact content is already ready (unless force)
      if (!force) {
        const mem = readyCacheRef.current.get(fresh.id);
        if (mem && mem.key === contentKey) {
          const ok = await invoke<boolean>("file_exists", {
            path: mem.wavPath,
          });
          if (ok) {
            const readyLine: ProjectLine = {
              ...fresh,
              wavPath: mem.wavPath,
              generatedText: fresh.text,
              generatedSpeakerEmbedPath: speakerKey,
              generatedCaption: captionUsed,
              generatedCfgScaleCaption: cfgCaptionUsed,
              generatedSampling: { ...s },
            };
            await persist((prev) => ({
              ...prev,
              lines: prev.lines.map((l) =>
                l.id === fresh.id
                  ? {
                      ...l,
                      wavPath: mem.wavPath,
                      generatedText: fresh.text,
                      generatedSpeakerEmbedPath: speakerKey,
                      generatedCaption: captionUsed,
                      generatedCfgScaleCaption: cfgCaptionUsed,
                      generatedSampling: { ...s },
                    }
                  : l,
              ),
            }));
            return finish({ wav: mem.wavPath, line: readyLine });
          }
        }
        if (
          !isDirty(fresh, speakersRef.current) &&
          wavPathMatchesLine(fresh) &&
          fresh.wavPath
        ) {
          const ok = await invoke<boolean>("file_exists", {
            path: fresh.wavPath,
          });
          if (ok) {
            readyCacheRef.current.set(fresh.id, {
              key: contentKey,
              wavPath: fresh.wavPath,
            });
            return finish({ wav: fresh.wavPath, line: fresh });
          }
        }
      }

      // Paint .generating before blocking IPC (otherwise busy on/off can collapse into one frame)
      flushSync(() => {
        setBusy(true);
        setBusyLineId(fresh.id);
        setStatus(`生成中…「${fresh.text.slice(0, 20)}」`);
      });

      const sp = speakersRef.current.find(
        (x) => x.embedPath === fresh.speakerEmbedPath,
      );
      const synthArgs: Record<string, unknown> = {
        text: fresh.text,
        outputWav: outPath,
        numSteps: s.numSteps,
        numCandidates: s.numCandidates,
        seed: s.seed,
        seconds: s.seconds,
        durationScale: s.durationScale,
        tScheduleMode: s.tScheduleMode,
        swayCoeff: s.swayCoeff,
        cfgGuidanceMode: s.cfgGuidanceMode,
        cfgScaleText: s.cfgScaleText,
        cfgScaleSpeaker: s.cfgScaleSpeaker,
      };
      if (sp?.kind === "ref") {
        if (!sp.refWav) {
          setStatus("参照音源が未設定の話者です");
          return finish(null);
        }
        synthArgs.refWav = sp.refWav;
      } else if (sp?.kind === "caption") {
        if (!sp.caption?.trim()) {
          setStatus("キャプションが未設定の話者です");
          return finish(null);
        }
        synthArgs.caption = sp.caption;
        synthArgs.noRef = true;
        synthArgs.cfgScaleCaption = 3.0;
      } else {
        synthArgs.refEmbed = fresh.speakerEmbedPath;
      }
      // v4: style caption alongside 参照音源 only
      if (
        isIrodoriV4(settings) &&
        sp?.kind === "ref" &&
        captionUsed.trim()
      ) {
        synthArgs.caption = captionUsed.trim();
        synthArgs.cfgScaleCaption = cfgCaptionUsed;
      }

      await invoke("synthesize_line", { args: synthArgs });

      const exists = await invoke<boolean>("file_exists", { path: outPath });
      if (!exists) {
        setStatus(`生成失敗: 出力ファイルがありません (${outPath})`);
        return finish(null);
      }

      const textUsed = fresh.text;
      const speakerUsed = speakerKey;
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
      lineDraftsRef.current.set(fresh.id, textUsed);

      const updated: ProjectLine = {
        ...(projectRef.current?.lines.find((l) => l.id === fresh.id) ??
          fresh),
        text: textUsed,
        wavPath: outPath,
        sampling: { ...s },
        generatedText: textUsed,
        generatedSpeakerEmbedPath: speakerUsed,
        generatedCaption: captionUsed,
        generatedCfgScaleCaption: cfgCaptionUsed,
        generatedSampling: { ...s },
      };
      await persist((prev) => ({
        ...prev,
        lines: prev.lines.map((l) =>
          l.id === fresh.id
            ? {
                ...l,
                text: textUsed,
                wavPath: outPath,
                sampling: { ...s },
                generatedText: textUsed,
                generatedSpeakerEmbedPath: speakerUsed,
                generatedCaption: captionUsed,
                generatedCfgScaleCaption: cfgCaptionUsed,
                generatedSampling: { ...s },
              }
            : l,
        ),
      }));
      // New WAV → previous ASR no longer applies (don't keep for restore)
      clearAsr(fresh.id);
      setStatus("生成完了（キャッシュ）");
      return finish({ wav: outPath, line: updated });
    } catch (e) {
      setStatus(String(e));
      return finish(null);
    } finally {
      setBusy(false);
      setBusyLineId(null);
    }
  };

  const resolveWavForPlay = async (
    line: ProjectLine,
  ): Promise<{ wav: string; line: ProjectLine } | null> => {
    commitDrafts();
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
    const contentKey = lineContentKey(
      fresh.text,
      speakerKey,
      captionUsed,
      cfgCaptionUsed,
      fresh.sampling,
    );
    const mem = readyCacheRef.current.get(fresh.id);
    if (mem && mem.key === contentKey) {
      const ok = await invoke<boolean>("file_exists", { path: mem.wavPath });
      if (ok) {
        return {
          wav: mem.wavPath,
          line: {
            ...fresh,
            wavPath: mem.wavPath,
            generatedText: fresh.text,
            generatedSpeakerEmbedPath: speakerKey,
            generatedCaption: captionUsed,
            generatedCfgScaleCaption: cfgCaptionUsed,
            generatedSampling: { ...fresh.sampling },
          },
        };
      }
    }

    if (
      !isDirty(fresh, speakersRef.current) &&
      wavPathMatchesLine(fresh) &&
      fresh.wavPath
    ) {
      const ok = await invoke<boolean>("file_exists", {
        path: fresh.wavPath,
      });
      if (ok) {
        readyCacheRef.current.set(fresh.id, {
          key: contentKey,
          wavPath: fresh.wavPath,
        });
        return { wav: fresh.wavPath, line: fresh };
      }
    }

    // Not ready → synthesize once (joins inflight if already running)
    return synthesizeLine(fresh, { force: false });
  };

  const startPlayback = async (line: ProjectLine, wavPath: string) => {
    const player = playerRef.current;
    if (!player) return;
    const gen = ++playGenRef.current;
    player.stop(true);
    try {
      const playPath = await invoke<string>("prepare_playback_wav", {
        src: wavPath,
        speed: line.speed,
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
      await player.playFromBytes(line.id, new Uint8Array(bytes), line.volume);
      onSelectedId(line.id);
    } catch (e) {
      if (gen === playGenRef.current) setStatus(`再生失敗: ${e}`);
    }
  };

  /** Single-line play/pause (same behavior for toolbar legacy / line button). */
  const playSingleLine = async (lineId: string) => {
    const player = playerRef.current;
    if (!player) return;
    // Ignore extra clicks while this (or another) line is synthesizing
    if (busy || synthInflight.current.has(lineId)) return;

    // Hand control to single-line play; keep current audio if same line
    cancelBatchPlayback();

    commitDrafts();
    const p = projectRef.current;
    if (!p) return;
    const line = p.lines.find((l) => l.id === lineId);
    if (!line) return;

    onSelectedId(line.id);
    syncPanelFromLine(line);

    // Pause/resume only when this line already has a loaded buffer
    if (player.activeLineId === line.id && player.hasBuffer) {
      player.togglePause();
      return;
    }

    const resolved = await resolveWavForPlay(line);
    if (!resolved) return;
    const latest =
      projectRef.current?.lines.find((l) => l.id === lineId) ?? resolved.line;
    await startPlayback(
      {
        ...latest,
        wavPath: resolved.wav,
        generatedText: latest.generatedText ?? resolved.line.generatedText,
        generatedSpeakerEmbedPath:
          latest.generatedSpeakerEmbedPath ??
          resolved.line.generatedSpeakerEmbedPath,
      },
      resolved.wav,
    );
  };

  /** Generate all ungenerated / dirty lines from top to bottom. */
  const generateBatchDirty = async () => {
    cancelBatchPlayback({ stopAudio: true });
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

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const line =
        projectRef.current?.lines.find((l) => l.id === targets[i].id) ??
        targets[i];
      if (!line.text.trim()) continue;
      if (!isDirty(line, speakers)) continue;

      onSelectedId(line.id);
      syncPanelFromLine(line);
      setStatus(`一括生成中… ${i + 1}/${targets.length}`);
      const result = await synthesizeLine(line, { force: false });
      await persistChain.current;
      if (result) ok += 1;
      else fail += 1;
    }

    if (fail === 0) {
      setStatus(`一括生成完了: ${ok} 行`);
    } else {
      setStatus(`一括生成完了: 成功 ${ok} / 失敗 ${fail}`);
    }
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
    const silenceMs = Math.max(0, Number(settings.chunkSilenceMs) || 0);
    setStatus("一括再生中…");
    try {
      let playedAny = false;
      for (const line of p.lines) {
        if (gen !== batchPlayGenRef.current) return;
        if (!line.text.trim()) continue;
        const resolved = await resolveWavForPlay(line);
        if (gen !== batchPlayGenRef.current) return;
        if (!resolved) continue;
        await persistChain.current;
        if (gen !== batchPlayGenRef.current) return;
        if (playedAny && silenceMs > 0) {
          await player.waitSilenceMs(silenceMs);
          if (gen !== batchPlayGenRef.current) return;
        }
        await startPlayback(resolved.line, resolved.wav);
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
      }
    }
  };

  const requestRegenerate = (line: ProjectLine) => {
    askConfirm("この行を再生成しますか？", () => {
      void (async () => {
        cancelBatchPlayback({ stopAudio: true });
        onSelectedId(line.id);
        syncPanelFromLine(line);
        const result = await synthesizeLine(line, { force: true });
        if (!result) return;
        await persistChain.current;
        await startPlayback(result.line, result.wav);
      })();
    });
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
      return synthesizeLine(fresh);
    }
    return { wav, line: fresh };
  };

  const saveLine = async (line: ProjectLine) => {
    const resolved = await ensureLineWav(line);
    if (!resolved) return;
    const p = projectRef.current;
    const idx = (p?.lines.findIndex((l) => l.id === resolved.line.id) ?? 0) + 1;
    const defaultName = lineExportFileName({
      projectName: p?.name ?? "project",
      idx,
      speakerName: resolved.line.speakerName,
      text: resolved.line.text,
      utteranceMaxChars: settings.utteranceMaxChars,
      parts: settings.exportFilenameParts,
    });
    const dest = await save({
      defaultPath: defaultName,
      filters: [{ name: "WAV", extensions: ["wav"] }],
    });
    if (!dest) return;
    try {
      await invoke("export_wav_adjusted", {
        src: resolved.wav,
        dest,
        volume: resolved.line.volume,
        speed: resolved.line.speed,
      });
      setStatus(`保存: ${dest}`);
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
      const resolved: { wav: string; line: ProjectLine; idx: number }[] = [];
      for (let i = 0; i < p.lines.length; i++) {
        const line = p.lines[i];
        if (!line.text.trim()) continue;
        setStatus(`一括保存: 準備中 ${i + 1}/${p.lines.length}`);
        const got = await ensureLineWav(line);
        if (!got) {
          setStatus(`一括保存中断: ${i + 1} 行目の生成に失敗しました`);
          return;
        }
        resolved.push({ wav: got.wav, line: got.line, idx: i + 1 });
      }

      if (resolved.length === 0) {
        setStatus("保存できる行がありません");
        return;
      }

      if (batchMode === "individual") {
        for (const item of resolved) {
          const name = lineExportFileName({
            projectName: p.name,
            idx: item.idx,
            speakerName: item.line.speakerName,
            text: item.line.text,
            utteranceMaxChars: settings.utteranceMaxChars,
            parts: settings.exportFilenameParts,
          });
          const dest = joinPath(folder, name);
          await invoke("export_wav_adjusted", {
            src: item.wav,
            dest,
            volume: item.line.volume,
            speed: item.line.speed,
          });
        }
        setStatus(`一括保存完了: ${resolved.length} ファイル → ${folder}`);
      } else {
        const silenceSecs = Math.max(0, Number(batchSilenceSecs) || 0);
        const dest = joinPath(folder, `${p.name}_concat.wav`);
        await invoke("export_wavs_concatenated", {
          segments: resolved.map((r) => ({
            src: r.wav,
            volume: r.line.volume,
            speed: r.line.speed,
          })),
          silenceSecs,
          dest,
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
              path: r.wav,
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
      <div className="project-start">
        <ProjectGatePanels
          newName={projectNameDraft}
          onNewName={onProjectNameDraft}
          onCreate={startProject}
          existingNames={existingProjects}
          selectedName={loadPickName}
          onSelectName={setLoadPickName}
          onLoad={() => void loadProjectByName(loadPickName)}
          status={status}
          disabled={gateBusy}
          openNames={openProjects.map((p) => p.name)}
        />
      </div>
    );
  }

  return (
    <div className="gen-layout">
      <main className="script-panel panel">
        <header className="panel-header toolbar">
          <div className="project-tabs" role="tablist" aria-label="開いているプロジェクト">
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
              title="未生成・要再生成の行を上から順に生成"
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
              onKatakana={() => void openKatakanaReviewBatch()}
              onReplace={() => void openReplacePreview()}
              onAsrVerify={() => void runAsrVerifyBatch()}
            />
          </div>
        </header>

        <div className="panel-body script-body">
          <EmojiPalette open={emojiOpen} onInsert={insertEmoji} />
          <div className="line-list-wrap">
            <div
              className={`line-list ${draggingId ? "is-reordering" : ""}`}
              ref={lineListRef}
            >
              {displayLines.length === 0 && (
                <p className="hint empty-hint">
                  右下の + または「テキスト追加」から行を追加してください
                </p>
              )}
              {displayLines.map((line, i) => {
                const isPlayingLine = playback?.lineId === line.id;
                const generating = busyLineId === line.id;
                return (
                  <div
                    key={line.id}
                    data-line-id={line.id}
                    className={`line-item ${selectedId === line.id ? "active" : ""} ${
                      generating ? "generating" : ""
                    } ${draggingId === line.id ? "dragging" : ""}`}
                    onClick={() => {
                      onSelectedId(line.id);
                      syncPanelFromLine(line);
                    }}
                  >
                    {generating ? <GenRing /> : null}
                    <div className="line-meta">
                      <span
                        className="drag-handle"
                        title="ドラッグで並べ替え"
                        onPointerDown={(e) => onHandlePointerDown(e, line.id, i)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        ⋮⋮
                      </span>
                      <span className="line-idx">{i + 1}</span>
                      <BoundedSelect
                        className="speaker-select"
                        value={line.speakerEmbedPath}
                        options={speakerOptions}
                        placeholder="話者を選択…"
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
                      <SpeakerApplyMenu
                        lineNumber={i + 1}
                        disabled={busy}
                        onApplyAll={() => applySpeakerToAll(line)}
                        onApplyParity={() => applySpeakerToParity(line, i)}
                      />
                      {line.wavPath &&
                        wavPathMatchesLine(line) &&
                        !isDirty(line, speakers) && (
                        <span className="badge">WAV</span>
                      )}
                      {line.wavPath &&
                        (!wavPathMatchesLine(line) || isDirty(line, speakers)) && (
                        <span className="badge dirty">要再生成</span>
                      )}
                      {asrByLine[line.id] && (
                        <AsrBadge result={asrByLine[line.id]} />
                      )}
                      <div className="line-actions">
                        <button
                          type="button"
                          className="line-btn"
                          disabled={busy && busyLineId !== line.id}
                          title="再生/一時停止（右クリックで再生成確認）"
                          onClick={(e) => {
                            e.stopPropagation();
                            void playSingleLine(line.id);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            requestRegenerate(line);
                          }}
                        >
                          {generating
                            ? "…"
                            : isPlayingLine && playback?.playing
                              ? "❚❚"
                              : "▶"}
                        </button>
                        <button
                          type="button"
                          className="line-btn"
                          title="カタカナ提案"
                          disabled={busy || asrBusy || !line.text.trim()}
                          onClick={(e) => {
                            e.stopPropagation();
                            void openKatakanaReview(line);
                          }}
                        >
                          ア
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
                          title="ファイルに保存"
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
                          className="line-btn danger"
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
                    <AutoTextarea
                      value={line.text}
                      onChange={(text) => void updateLine(line.id, { text })}
                      onDraftChange={(text) => {
                        lineDraftsRef.current.set(line.id, text);
                      }}
                      onFocusLine={() => {
                        onSelectedId(line.id);
                        syncPanelFromLine(line);
                      }}
                      canMergePrev={i > 0}
                      highlightHits={homoByLine[line.id]}
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
                    {isPlayingLine && playback && (
                      <div
                        className="seek-bar"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="range"
                          min={0}
                          max={playback.duration || 0}
                          step={0.01}
                          value={playback.currentTime}
                          onChange={(e) =>
                            playerRef.current?.seek(Number(e.target.value))
                          }
                        />
                        <span className="seek-time">
                          {playback.currentTime.toFixed(1)} /{" "}
                          {playback.duration.toFixed(1)}s
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
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

      <aside className={paramsPanelClass}>
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
          onConfirm={(lines) => void addLinesFromTexts(lines)}
          onCancel={() => setBulkAddOpen(false)}
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
              <div className="row">
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
              </div>
            </div>
          </div>
        </div>
      )}

      {katakanaReview && (
        <KatakanaReviewDialog
          items={katakanaReview.items}
          onCancel={() => setKatakanaReview(null)}
          onApply={(updates) => {
            setKatakanaReview(null);
            void (async () => {
              const map = new Map(updates.map((u) => [u.lineId, u.text]));
              await persist((prev) => ({
                ...prev,
                lines: prev.lines.map((l) => {
                  const text = map.get(l.id);
                  if (text === undefined) return l;
                  lineDraftsRef.current.set(l.id, text);
                  return { ...l, text };
                }),
              }));
              invalidateAsrMany([...map.keys()]);
              setStatus(
                updates.length > 1
                  ? `カタカナを ${updates.length} 行に適用しました`
                  : "カタカナを適用しました",
              );
              void refreshHomographs();
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
              <div className="row">
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
              </div>
            </div>
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
                status={status}
                disabled={gateBusy}
                openNames={openProjects.map((p) => p.name)}
              />
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="modal panel" onClick={(e) => e.stopPropagation()}>
            <header className="panel-header">
              <h3>確認</h3>
            </header>
            <div className="panel-body form-stack">
              <p>{confirm.message}</p>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    const fn = confirm.onYes;
                    setConfirm(null);
                    fn();
                  }}
                >
                  OK
                </button>
                <button type="button" onClick={() => setConfirm(null)}>
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        </div>
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
