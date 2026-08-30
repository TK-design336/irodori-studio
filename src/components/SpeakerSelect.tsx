import { useEffect, useMemo, useState } from "react";
import { BoundedSelect } from "./BoundedSelect";
import { SpeakerSortPanel } from "./SpeakerSortPanel";
import { SpeakerSortProvider, useSpeakerSort } from "./SpeakerSortContext";
import type { SpeakerInfo } from "../types";
import { speakerOptionLabel } from "../types";
import { sortAndFilterSpeakers, speakerSortMeta } from "../lib/speakerSort";

type Props = {
  speakers: SpeakerInfo[];
  value: string;
  onChange: (value: string) => void;
  /** When set, prepends an empty-value option with this label. */
  emptyLabel?: string;
  placeholder?: string;
  displayLabel?: string;
  className?: string;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  "aria-label"?: string;
  onClick?: (e: React.MouseEvent) => void;
};

export function SpeakerSelect(props: Props) {
  return (
    <SpeakerSortProvider persist={false}>
      <SpeakerSelectInner {...props} />
    </SpeakerSortProvider>
  );
}

function SpeakerSelectInner({
  speakers,
  value,
  onChange,
  emptyLabel,
  placeholder,
  displayLabel,
  className = "",
  disabled = false,
  searchable = false,
  searchPlaceholder = "話者を検索…",
  "aria-label": ariaLabel,
  onClick,
}: Props) {
  const sort = useSpeakerSort();
  const [sortFlyoutOpen, setSortFlyoutOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (menuOpen) return;
    setSortFlyoutOpen(false);
    sort.resetSort();
  }, [menuOpen, sort.resetSort]);

  const options = useMemo(() => {
    const sorted = sortAndFilterSpeakers(
      speakers,
      {
        sortKey: sort.sortKey,
        sortDir: sort.sortDir,
        kindFilter: sort.kindFilter,
        tagFilter: sort.tagFilter,
      },
      { keepEmbedPath: value },
    );
    const opts = sorted.map((s) => {
      const meta = speakerSortMeta(s, sort.sortKey);
      return {
        value: s.embedPath,
        label: speakerOptionLabel(s),
        ...(meta
          ? { meta: meta.text, metaTone: meta.tone }
          : {}),
      };
    });
    if (emptyLabel != null) {
      return [{ value: "", label: emptyLabel }, ...opts];
    }
    return opts;
  }, [
    speakers,
    sort.sortKey,
    sort.sortDir,
    sort.kindFilter,
    sort.tagFilter,
    value,
    emptyLabel,
  ]);

  const menuToolbar = (
    <button
      type="button"
      className={`speaker-select-sort-btn${sortFlyoutOpen ? " active" : ""}`}
      aria-expanded={sortFlyoutOpen}
      aria-label="表示種・並び替えパネルを開く"
      title="表示種・並び替え"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setSortFlyoutOpen((v) => !v);
      }}
    >
      並び替え
      <span aria-hidden>{sortFlyoutOpen ? "◂" : "▸"}</span>
    </button>
  );

  const menuAside = sortFlyoutOpen ? (
    <div className="speaker-select-sort-flyout panel">
      <div className="speaker-select-sort-flyout-head">
        <span className="hint">表示種・並び替え</span>
        <button
          type="button"
          className="speaker-sort-aside-close"
          aria-label="並び替えパネルを閉じる"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSortFlyoutOpen(false);
          }}
        >
          ✕
        </button>
      </div>
      <SpeakerSortPanel compact speakers={speakers} />
    </div>
  ) : null;

  return (
    <BoundedSelect
      value={value}
      options={options}
      onChange={onChange}
      onOpenChange={setMenuOpen}
      placeholder={placeholder ?? emptyLabel ?? "選択…"}
      displayLabel={displayLabel}
      className={className}
      disabled={disabled}
      searchable={searchable}
      searchPlaceholder={searchPlaceholder}
      menuToolbar={menuToolbar}
      menuAside={menuAside}
      menuAsideSide="right"
      aria-label={ariaLabel}
      onClick={onClick}
    />
  );
}
