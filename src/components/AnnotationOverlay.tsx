import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ANNOTATION_KIND_LABEL,
  type AnnotationKind,
  type AppliedReading,
  type DetectedAnnotation,
} from "../lib/annotations";
import { AnnotationPopover } from "./AnnotationPopover";

type OverlaySegment =
  | { type: "text"; content: string; key: string }
  | {
      type: "pending";
      key: string;
      annotation: DetectedAnnotation;
    }
  | {
      type: "applied";
      key: string;
      reading: AppliedReading;
    };

function buildSegments(
  text: string,
  pending: DetectedAnnotation[],
  applied: AppliedReading[],
): OverlaySegment[] {
  const marks: Array<
    | { start: number; end: number; kind: "pending"; annotation: DetectedAnnotation }
    | { start: number; end: number; kind: "applied"; reading: AppliedReading }
  > = [];

  for (const a of pending) {
    marks.push({ start: a.start, end: a.end, kind: "pending", annotation: a });
  }
  for (const r of applied) {
    marks.push({ start: r.start, end: r.end, kind: "applied", reading: r });
  }

  marks.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenA !== lenB) return lenB - lenA;
    // applied beats pending at same position and same length
    if (a.kind === "applied" && b.kind !== "applied") return -1;
    if (b.kind === "applied" && a.kind !== "applied") return 1;
    return 0;
  });

  const kept: typeof marks = [];
  for (const m of marks) {
    if (kept.some((k) => k.start < m.end && m.start < k.end)) continue;
    kept.push(m);
  }
  kept.sort((a, b) => a.start - b.start);

  const chars = [...text];
  const segments: OverlaySegment[] = [];
  let cursor = 0;
  for (const m of kept) {
    const start = Math.max(0, Math.min(m.start, chars.length));
    const end = Math.max(start, Math.min(m.end, chars.length));
    if (start > cursor) {
      segments.push({
        type: "text",
        key: `t-${cursor}`,
        content: chars.slice(cursor, start).join(""),
      });
    }
    if (m.kind === "pending") {
      segments.push({ type: "pending", key: `p-${start}`, annotation: m.annotation });
    } else {
      segments.push({ type: "applied", key: `a-${start}`, reading: m.reading });
    }
    cursor = end;
  }
  if (cursor < chars.length) {
    segments.push({
      type: "text",
      key: `t-${cursor}`,
      content: chars.slice(cursor).join(""),
    });
  }
  return segments.length > 0 ? segments : [{ type: "text", key: "all", content: text }];
}

type Props = {
  text: string;
  pending: DetectedAnnotation[];
  applied: AppliedReading[];
  onApply: (annotation: DetectedAnnotation, reading: string) => void;
  onUndo: (readingId: string) => void;
  onFocusEdit: () => void;
};

export function AnnotationOverlay({
  text,
  pending,
  applied,
  onApply,
  onUndo,
  onFocusEdit,
}: Props) {
  const [active, setActive] = useState<DetectedAnnotation | null>(null);
  const activeRef = useRef<DetectedAnnotation | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const hideTimer = useRef<number | null>(null);
  const pinnedRef = useRef(false);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    if (pinnedRef.current) return;
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => {
      activeRef.current = null;
      setActive(null);
      setAnchorRect(null);
    }, 200);
  }, [clearHideTimer]);

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  const segments = buildSegments(text, pending, applied);

  const openPopover = (annotation: DetectedAnnotation, el: HTMLElement) => {
    if (pinnedRef.current) return;
    clearHideTimer();
    activeRef.current = annotation;
    setActive(annotation);
    setAnchorRect(el.getBoundingClientRect());
  };

  const parts: ReactNode[] = segments.map((seg) => {
    if (seg.type === "text") {
      return <span key={seg.key}>{seg.content}</span>;
    }
    if (seg.type === "applied") {
      const r = seg.reading;
      const label = ANNOTATION_KIND_LABEL[r.kind];
      const surface = [...text].slice(r.start, r.end).join("");
      return (
        <mark
          key={seg.key}
          className={`annotation-mark annotation-mark--applied annotation-mark--${r.kind}`}
          title={`${label} — 読み: ${r.reading}（クリックで取消）`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            e.stopPropagation();
            onUndo(r.id);
          }}
        >
          <ruby>{surface}<rp>(</rp><rt className="annotation-rt">{r.reading}</rt><rp>)</rp></ruby>
        </mark>
      );
    }
    const a = seg.annotation;
    const kind = a.kind as AnnotationKind;
    const label = ANNOTATION_KIND_LABEL[kind];
    return (
      <mark
        key={seg.key}
        className={`annotation-mark annotation-mark--${kind}`}
        title={`${label} — クリックで候補`}
        onMouseEnter={(e) => openPopover(a, e.currentTarget)}
        onMouseLeave={scheduleHide}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.stopPropagation();
          openPopover(a, e.currentTarget);
        }}
      >
        {[...text].slice(a.start, a.end).join("")}
      </mark>
    );
  });

  return (
    <>
      <div
        className="line-text line-text-display"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if (e.ctrlKey || e.metaKey || e.shiftKey) e.preventDefault();
        }}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.stopPropagation();
          onFocusEdit();
        }}
        title="クリックで編集"
      >
        {parts}
      </div>
      {active && anchorRect
        ? createPortal(
            <AnnotationPopover
              annotation={active}
              anchorRect={anchorRect}
              onPinChange={(pinned) => {
                pinnedRef.current = pinned;
                if (pinned) clearHideTimer();
              }}
              onApply={(reading) => {
                onApply(active, reading);
                pinnedRef.current = false;
                activeRef.current = null;
                setActive(null);
                setAnchorRect(null);
              }}
              onClose={() => {
                pinnedRef.current = false;
                activeRef.current = null;
                setActive(null);
                setAnchorRect(null);
              }}
              onMouseEnter={clearHideTimer}
              onMouseLeave={scheduleHide}
            />,
            document.body,
          )
        : null}
    </>
  );
}
