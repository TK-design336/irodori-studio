import { useEffect, useRef, useState } from "react";
import {
  ANNOTATION_KIND_LABEL,
  readingForApply,
  type DetectedAnnotation,
} from "../lib/annotations";

type Props = {
  annotation: DetectedAnnotation;
  anchorRect: DOMRect;
  onApply: (reading: string) => void;
  onClose: () => void;
  onPinChange?: (pinned: boolean) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

export function AnnotationPopover({
  annotation,
  anchorRect,
  onApply,
  onClose,
  onPinChange,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manual, setManual] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const setManualModeAndPin = (v: boolean) => {
    setManualMode(v);
    onPinChange?.(v);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (manualMode) { setManualModeAndPin(false); }
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, manualMode]);

  // Close on outside click while in manual mode
  useEffect(() => {
    if (!manualMode) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Use setTimeout so the current click that opened manual mode doesn't immediately close
    const id = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [manualMode, onClose]);

  useEffect(() => {
    if (manualMode) inputRef.current?.focus();
  }, [manualMode]);

  const label = ANNOTATION_KIND_LABEL[annotation.kind];
  const top = anchorRect.bottom + 4;
  const left = Math.min(anchorRect.left, window.innerWidth - 240);

  const enterManual = (prefill?: string) => {
    setManual(
      prefill ??
        readingForApply(annotation.kind, annotation.candidates[0]?.reading ?? ""),
    );
    setManualModeAndPin(true);
  };

  return (
    <div
      ref={ref}
      className="annotation-popover"
      style={{ top, left }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={manualMode ? undefined : onMouseLeave}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="annotation-popover-header">
        <span className="annotation-popover-kind">{label}</span>
        <span className="annotation-popover-surface">{annotation.surface}</span>
      </div>
      {manualMode ? (
        <div className="annotation-popover-manual">
          <input
            ref={inputRef}
            value={manual}
            placeholder="読みを入力…"
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && manual.trim()) onApply(manual.trim());
            }}
          />
          <button
            type="button"
            disabled={!manual.trim()}
            onClick={() => onApply(manual.trim())}
          >
            適用
          </button>
        </div>
      ) : (
        <ul className="annotation-popover-list">
          {annotation.candidates.map((c, i) => {
            const reading = readingForApply(annotation.kind, c.reading);
            return (
              <li key={`${reading}-${i}`}>
                <button type="button" onClick={() => onApply(reading)}>
                  {c.label ? (
                    <>
                      <span className="annotation-popover-reading">{reading}</span>
                      <span className="annotation-popover-label">{c.label}</span>
                    </>
                  ) : (
                    reading
                  )}
                </button>
              </li>
            );
          })}
          <li className="annotation-popover-manual-item">
            <button type="button" onClick={() => enterManual()}>
              手動入力…
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
