import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ANNOTATION_KIND_LABEL,
  readingForApply,
  type AnnotationKind,
  type DetectedAnnotation,
  type AppliedReading,
} from "../lib/annotations";

export type AnnotationReviewItem = {
  lineId: string;
  text: string;
  annotations: DetectedAnnotation[];
  applied: AppliedReading[];
  label: string;
};

export type NumericConvertModes = {
  number: "katakana" | "kanji" | "hiragana";
  unit: "katakana" | "hiragana";
};

type ReviewEdit = {
  lineId: string;
  text: string;
  label: string;
  applied: AppliedReading[];
  items: {
    annotation: DetectedAnnotation;
    accepted: boolean;
    selectedReading: string;
    manualMode: boolean;
  }[];
};

type Props = {
  items: AnnotationReviewItem[];
  modes: NumericConvertModes;
  onModesChange: (modes: NumericConvertModes) => void;
  onApply: (
    updates: {
      lineId: string;
      readings: AppliedReading[];
    }[],
  ) => void;
  onCancel: () => void;
};

const KINDS: AnnotationKind[] = ["english", "heteronym", "numeric"];

function pickDefaultReading(a: DetectedAnnotation, modes: NumericConvertModes): string {
  if (a.candidates.length === 0) return "";
  if (a.kind === "heteronym") return readingForApply("heteronym", a.candidates[0].reading);
  if (a.kind !== "numeric") return a.candidates[0].reading;
  const preferred =
    a.candidates.find((c) => {
      const label = c.label ?? "";
      if (modes.number === "kanji" && label.includes("漢")) return true;
      if (modes.number === "katakana" && label.includes("カタカナ")) return true;
      if (modes.number === "hiragana" && (label === "数" || label.includes("ひら"))) return true;
      return false;
    }) ?? a.candidates[0];
  return preferred.reading;
}

function initLines(items: AnnotationReviewItem[], modes: NumericConvertModes): ReviewEdit[] {
  return items.map((it) => ({
    lineId: it.lineId,
    text: it.text,
    label: it.label,
    applied: it.applied,
    items: it.annotations.map((a) => ({
      annotation: a,
      accepted: pickDefaultReading(a, modes).length > 0,
      selectedReading: pickDefaultReading(a, modes),
      manualMode: a.candidates.length === 0,
    })),
  }));
}

const MANUAL_SENTINEL = "__manual__";

type PreviewSpan = {
  start: number;
  end: number;
  kind: AnnotationKind;
  reading: string;
};

function dropOverlappingSpans(spans: PreviewSpan[]): PreviewSpan[] {
  const sorted = [...spans]
    .filter((s) => s.start < s.end && s.reading.trim().length > 0)
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: PreviewSpan[] = [];
  for (const s of sorted) {
    if (kept.some((k) => k.start < s.end && s.start < k.end)) continue;
    kept.push(s);
  }
  return kept;
}

function highlightOriginal(text: string, spans: PreviewSpan[]): ReactNode {
  const chars = [...text];
  const kept = dropOverlappingSpans(spans);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  kept.forEach((s, i) => {
    const start = Math.max(0, Math.min(s.start, chars.length));
    const end = Math.max(start, Math.min(s.end, chars.length));
    if (start > cursor) {
      nodes.push(
        <span key={`t-${cursor}`}>{chars.slice(cursor, start).join("")}</span>,
      );
    }
    nodes.push(
      <mark
        key={`h-${start}-${i}`}
        className={`annotation-mark annotation-mark--${s.kind} annotation-mark--static`}
        title={`${ANNOTATION_KIND_LABEL[s.kind]} → ${s.reading}`}
      >
        {chars.slice(start, end).join("")}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < chars.length) {
    nodes.push(
      <span key={`t-${cursor}`}>{chars.slice(cursor).join("")}</span>,
    );
  }
  return nodes.length > 0 ? nodes : text;
}

function highlightSynth(text: string, spans: PreviewSpan[]): ReactNode {
  const chars = [...text];
  const kept = dropOverlappingSpans(spans);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  kept.forEach((s, i) => {
    const start = Math.max(0, Math.min(s.start, chars.length));
    const end = Math.max(start, Math.min(s.end, chars.length));
    if (start > cursor) {
      nodes.push(
        <span key={`t-${cursor}`}>{chars.slice(cursor, start).join("")}</span>,
      );
    }
    nodes.push(
      <mark
        key={`h-${start}-${i}`}
        className={`annotation-mark annotation-mark--${s.kind} annotation-mark--static`}
        title={`${ANNOTATION_KIND_LABEL[s.kind]}: ${s.reading}`}
      >
        {s.reading}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < chars.length) {
    nodes.push(
      <span key={`t-${cursor}`}>{chars.slice(cursor).join("")}</span>,
    );
  }
  return nodes.length > 0 ? nodes : text;
}

function ReviewRow({
  entry: e,
  lineLabel,
  onChange,
}: {
  entry: ReviewEdit["items"][number];
  lineLabel?: string;
  onChange: (patch: Partial<ReviewEdit["items"][number]>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const selectValue = e.manualMode
    ? MANUAL_SENTINEL
    : e.annotation.candidates.some(
        (c) => readingForApply(e.annotation.kind, c.reading) === e.selectedReading,
      )
      ? e.selectedReading
      : MANUAL_SENTINEL;

  const handleSelect = (val: string) => {
    if (val === MANUAL_SENTINEL) {
      onChange({ manualMode: true });
      return;
    }
    const reading =
      e.annotation.kind === "heteronym" ? readingForApply("heteronym", val) : val;
    onChange({ selectedReading: reading, accepted: true, manualMode: false });
  };

  useEffect(() => {
    if (e.manualMode) inputRef.current?.focus();
  }, [e.manualMode]);

  return (
    <div className="review-row">
      {lineLabel && <span className="review-row-line">{lineLabel}</span>}
      <span className="review-row-surface">{e.annotation.surface}</span>
      <label className="review-row-check">
        <input
          type="checkbox"
          checked={e.accepted}
          onChange={(ev) => onChange({ accepted: ev.target.checked })}
        />
      </label>
      {e.manualMode ? (
        <input
          ref={inputRef}
          className="review-row-input"
          value={e.selectedReading}
          placeholder="読みを入力…"
          onChange={(ev) => {
            const v = ev.target.value;
            onChange({
              selectedReading: v,
              accepted: v.trim().length > 0 ? true : e.accepted,
            });
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Escape") onChange({ manualMode: false });
          }}
        />
      ) : (
        <select
          className="review-row-select"
          value={selectValue}
          onChange={(ev) => handleSelect(ev.target.value)}
        >
          {e.annotation.candidates.map((c) => {
            const reading = readingForApply(e.annotation.kind, c.reading);
            return (
              <option key={`${reading}-${c.label ?? ""}`} value={reading}>
                {c.label ? `${reading} (${c.label})` : reading}
              </option>
            );
          })}
          <option value={MANUAL_SENTINEL}>手動編集…</option>
        </select>
      )}
    </div>
  );
}

export function AnnotationReviewDialog({
  items,
  modes,
  onModesChange,
  onApply,
  onCancel,
}: Props) {
  const [lines, setLines] = useState<ReviewEdit[]>(() => initLines(items, modes));

  const multi = lines.length > 1;
  const totalItems = lines.reduce((s, l) => s + l.items.length, 0);

  const previews = useMemo(
    () =>
      lines.map((l) => {
        const newReadings: AppliedReading[] = l.items
          .filter((e) => e.accepted && e.selectedReading.trim())
          .map((e) => ({
            id: crypto.randomUUID(),
            kind: e.annotation.kind,
            start: e.annotation.start,
            end: e.annotation.end,
            surface: e.annotation.surface,
            reading: readingForApply(e.annotation.kind, e.selectedReading),
          }));
        const spans: PreviewSpan[] = [...l.applied, ...newReadings].map((r) => ({
          start: r.start,
          end: r.end,
          kind: r.kind,
          reading: r.reading,
        }));
        return {
          lineId: l.lineId,
          label: l.label,
          original: l.text,
          spans,
        };
      }),
    [lines],
  );

  const setAt = (
    lineIdx: number,
    itemIdx: number,
    patch: Partial<ReviewEdit["items"][number]>,
  ) => {
    setLines((prev) =>
      prev.map((l, li) =>
        li !== lineIdx
          ? l
          : {
              ...l,
              items: l.items.map((e, ei) =>
                ei !== itemIdx ? e : { ...e, ...patch },
              ),
            },
      ),
    );
  };

  const acceptKind = (kind: AnnotationKind) => {
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        items: l.items.map((e) =>
          e.annotation.kind !== kind
            ? e
            : {
                ...e,
                accepted: e.selectedReading.trim().length > 0,
              },
        ),
      })),
    );
  };

  const rejectKind = (kind: AnnotationKind) => {
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        items: l.items.map((e) =>
          e.annotation.kind !== kind ? e : { ...e, accepted: false },
        ),
      })),
    );
  };

  const acceptAll = () => {
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        items: l.items.map((e) => ({
          ...e,
          accepted: e.selectedReading.trim().length > 0,
        })),
      })),
    );
  };

  const rejectAll = () => {
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        items: l.items.map((e) => ({ ...e, accepted: false })),
      })),
    );
  };

  const applyModes = (next: NumericConvertModes) => {
    onModesChange(next);
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        items: l.items.map((e) => {
          if (e.annotation.kind !== "numeric") return e;
          const reading = pickDefaultReading(e.annotation, next);
          return {
            ...e,
            selectedReading: reading,
            accepted: reading.length > 0 ? e.accepted : false,
          };
        }),
      })),
    );
  };

  const title = multi
    ? `読み提案 — ${lines.length} 行`
    : `読み提案${lines[0] ? ` — ${lines[0].label}` : ""}`;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal panel katakana-modal annotation-review-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-header">
          <h3>{title}</h3>
        </header>
        <div className="panel-body form-stack">
          {totalItems === 0 ? (
            <p className="hint">読み提案対象が見つかりませんでした</p>
          ) : (
            <>
              <div className="row">
                <button type="button" onClick={acceptAll}>
                  一括承認
                </button>
                <button type="button" onClick={rejectAll}>
                  すべて却下
                </button>
              </div>

              {KINDS.map((kind) => {
                const count = lines.reduce(
                  (s, l) =>
                    s + l.items.filter((e) => e.annotation.kind === kind).length,
                  0,
                );
                if (count === 0) return null;
                return (
                  <section key={kind} className="annotation-review-section">
                    <div className="annotation-review-section-header">
                      <h4>{ANNOTATION_KIND_LABEL[kind]}</h4>
                      <div className="row">
                        <button type="button" onClick={() => acceptKind(kind)}>
                          この種別を一括承認
                        </button>
                        <button type="button" onClick={() => rejectKind(kind)}>
                          この種別を一括却下
                        </button>
                      </div>
                    </div>
                    {kind === "numeric" ? (
                      <div className="annotation-review-modes">
                        <label>
                          数字:
                          <select
                            value={modes.number}
                            onChange={(e) =>
                              applyModes({
                                ...modes,
                                number: e.target.value as NumericConvertModes["number"],
                              })
                            }
                          >
                            <option value="hiragana">ひらがな</option>
                            <option value="katakana">カタカナ</option>
                            <option value="kanji">漢数字</option>
                          </select>
                        </label>
                        <label>
                          単位:
                          <select
                            value={modes.unit}
                            onChange={(e) =>
                              applyModes({
                                ...modes,
                                unit: e.target.value as NumericConvertModes["unit"],
                              })
                            }
                          >
                            <option value="hiragana">ひらがな</option>
                            <option value="katakana">カタカナ</option>
                          </select>
                        </label>
                      </div>
                    ) : null}
                    {lines.map((l, li) =>
                      l.items
                        .map((e, ii) => ({ e, ii }))
                        .filter(({ e }) => e.annotation.kind === kind)
                        .map(({ e, ii }) => (
                          <ReviewRow
                            key={`${l.lineId}-${e.annotation.start}-${ii}`}
                            entry={e}
                            lineLabel={multi ? l.label : undefined}
                            onChange={(patch) => setAt(li, ii, patch)}
                          />
                        )),
                    )}
                  </section>
                );
              })}

              <div className="annotation-review-diff">
                <span className="field-label">プレビュー（差分）</span>
                {previews.map((p) => (
                  <div key={p.lineId}>
                    {multi && <div className="katakana-line-label">{p.label}</div>}
                    <div className="annotation-review-diff-row">
                      <span className="annotation-review-diff-label">原文</span>
                      <span className="annotation-review-diff-text" spellCheck={false}>
                        {highlightOriginal(p.original, p.spans)}
                      </span>
                    </div>
                    <div className="annotation-review-diff-row">
                      <span className="annotation-review-diff-label">推論</span>
                      <span className="annotation-review-diff-text" spellCheck={false}>
                        {highlightSynth(p.original, p.spans)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <footer className="panel-footer row">
          <button
            type="button"
            className="primary"
            disabled={totalItems === 0}
            onClick={() => {
              const updates = lines.map((l) => {
                const added: AppliedReading[] = l.items
                  .filter((e) => e.accepted && e.selectedReading.trim())
                  .map((e) => ({
                    id: crypto.randomUUID(),
                    kind: e.annotation.kind,
                    start: e.annotation.start,
                    end: e.annotation.end,
                    surface: e.annotation.surface,
                    reading: readingForApply(e.annotation.kind, e.selectedReading),
                  }));
                return {
                  lineId: l.lineId,
                  readings: [...(l.applied ?? []), ...added],
                };
              });
              onApply(updates);
            }}
          >
            適用
          </button>
          <button type="button" onClick={onCancel}>
            キャンセル
          </button>
        </footer>
      </div>
    </div>
  );
}
