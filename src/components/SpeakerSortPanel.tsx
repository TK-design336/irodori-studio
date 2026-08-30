import { useEffect, useMemo, useRef, useState } from "react";
import {
  collectSpeakerTagCounts,
  KIND_FILTERS,
  SORT_BUTTONS,
} from "../lib/speakerSort";
import { useSpeakerSort } from "./SpeakerSortContext";
import type { SpeakerInfo } from "../types";

type Props = {
  className?: string;
  /** Compact layout for dropdown flyouts */
  compact?: boolean;
  /** Speakers used to list tags and per-tag counts. */
  speakers: SpeakerInfo[];
};

export function SpeakerSortPanel({
  className = "",
  compact = false,
  speakers,
}: Props) {
  const {
    sortKey,
    kindFilter,
    clickSort,
    toggleKindFilter,
    toggleTagFilter,
    selectAllTags,
    isTagSelected,
    areAllTagsSelected,
    sortDirMark,
    tagFilter,
  } = useSpeakerSort();
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const tagWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tagMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (tagWrapRef.current?.contains(t)) return;
      setTagMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [tagMenuOpen]);

  const tagItems = useMemo(
    () => collectSpeakerTagCounts(speakers),
    [speakers],
  );
  const availableTags = useMemo(
    () => tagItems.map((x) => x.tag),
    [tagItems],
  );
  const allSelected = areAllTagsSelected(availableTags);
  const tagActive =
    availableTags.length > 0 &&
    (tagFilter !== null || tagMenuOpen);

  return (
    <div
      className={`speaker-sort-panel${compact ? " compact" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      <div className="speaker-sort-row">
        <span className="hint">表示種:</span>
        {KIND_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={kindFilter[f.key] ? "sort-btn active" : "sort-btn"}
            aria-pressed={kindFilter[f.key]}
            title={
              kindFilter[f.key]
                ? "表示中（クリックで非表示）"
                : "非表示（クリックで表示）"
            }
            onClick={() => toggleKindFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        <div className="speaker-tag-filter-wrap" ref={tagWrapRef}>
          <button
            type="button"
            className={`sort-btn${tagActive && !allSelected ? " active" : ""}${
              tagMenuOpen ? " menu-open" : ""
            }`}
            aria-expanded={tagMenuOpen}
            aria-haspopup="listbox"
            title="タグで絞り込み"
            disabled={availableTags.length === 0}
            onClick={() => setTagMenuOpen((v) => !v)}
          >
            タグ
            {!allSelected && availableTags.length > 0
              ? ` (${tagFilter?.length ?? 0})`
              : ""}
            <span className="speaker-tag-filter-caret" aria-hidden>
              {tagMenuOpen ? "▴" : "▾"}
            </span>
          </button>
          {tagMenuOpen && (
            <div
              className="speaker-tag-filter-menu"
              role="listbox"
              aria-label="表示するタグ"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={`speaker-tag-filter-item${allSelected ? " active" : ""}`}
                onClick={() => selectAllTags()}
              >
                すべて
              </button>
              {availableTags.length === 0 ? (
                <p className="hint speaker-tag-filter-empty">タグなし</p>
              ) : (
                tagItems.map(({ tag, count }) => {
                  const on = isTagSelected(tag, availableTags);
                  return (
                    <button
                      key={tag}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={`speaker-tag-filter-item${on ? " active" : ""}`}
                      onClick={() => toggleTagFilter(tag, availableTags)}
                    >
                      <span className="speaker-tag-filter-check" aria-hidden>
                        {on ? "✓" : ""}
                      </span>
                      <span className="speaker-tag-filter-label">
                        {tag}
                        <span className="speaker-tag-filter-count"> ({count})</span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
      <div className="speaker-sort-row">
        <span className="hint">並び替え:</span>
        {SORT_BUTTONS.map((b) => (
          <button
            key={b.key}
            type="button"
            className={sortKey === b.key ? "sort-btn active" : "sort-btn"}
            title="クリックで昇順・降順を切替"
            onClick={() => clickSort(b.key)}
          >
            {b.label}
            {sortDirMark(b.key)}
          </button>
        ))}
      </div>
    </div>
  );
}
