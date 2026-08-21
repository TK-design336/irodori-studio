import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type SelectOption = {
  value: string;
  label: string;
};

type Props = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Shown when `value` is not in `options` (e.g. stale embed path after outputs-root move). */
  displayLabel?: string;
  className?: string;
  disabled?: boolean;
  /** Show a text field and filter options as the user types. */
  searchable?: boolean;
  searchPlaceholder?: string;
  "aria-label"?: string;
  onClick?: (e: React.MouseEvent) => void;
};

type MenuPos = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  openUp: boolean;
};

const MENU_MAX = 280;
const MARGIN = 8;
const SEARCH_H = 36;

function foldQuery(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s_\-・．.]/g, "");
}

function computePos(
  trigger: DOMRect,
  itemCount: number,
  searchable: boolean,
): MenuPos {
  const extra = searchable ? SEARCH_H : 0;
  const estH = Math.min(MENU_MAX, Math.max(36, itemCount * 26 + 6 + extra));
  const spaceBelow = window.innerHeight - trigger.bottom - MARGIN;
  const spaceAbove = trigger.top - MARGIN;
  const openUp = spaceBelow < estH && spaceAbove > spaceBelow;
  const maxHeight = Math.max(80, Math.min(MENU_MAX, openUp ? spaceAbove : spaceBelow));
  const width = Math.max(trigger.width, searchable ? 180 : 120);
  let left = trigger.left;
  if (left + width > window.innerWidth - MARGIN) {
    left = Math.max(MARGIN, window.innerWidth - MARGIN - width);
  }
  if (left < MARGIN) left = MARGIN;

  if (openUp) {
    return {
      top: trigger.top - MARGIN,
      left,
      width,
      maxHeight,
      openUp: true,
    };
  }
  return {
    top: trigger.bottom + 4,
    left,
    width,
    maxHeight,
    openUp: false,
  };
}

function isComposingKey(e: React.KeyboardEvent) {
  return e.nativeEvent.isComposing || e.key === "Process" || e.keyCode === 229;
}

export function BoundedSelect({
  value,
  options,
  onChange,
  placeholder = "選択…",
  displayLabel,
  className = "",
  disabled = false,
  searchable = false,
  searchPlaceholder = "検索…",
  "aria-label": ariaLabel,
  onClick,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const label =
    selected?.label ?? displayLabel ?? (value ? value : placeholder);

  const filtered = useMemo(() => {
    if (!searchable) return options;
    const q = foldQuery(query);
    if (!q) return options;
    return options.filter((o) => foldQuery(o.label).includes(q));
  }, [options, query, searchable]);

  const updatePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    setPos(computePos(el.getBoundingClientRect(), options.length, searchable));
  }, [options.length, searchable]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePos();
  }, [open, updatePos]);

  useLayoutEffect(() => {
    if (!open) return;
    const idx = filtered.findIndex((o) => o.value === value);
    setHighlight(idx >= 0 ? idx : filtered.length > 0 ? 0 : -1);
  }, [open, filtered, value]);

  useLayoutEffect(() => {
    if (!open || !searchable) return;
    searchRef.current?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setHighlight(-1);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => updatePos();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || highlight < 0) return;
    const item = listRef.current?.children[highlight] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const pickHighlight = () => {
    if (highlight >= 0 && highlight < filtered.length) {
      pick(filtered[highlight].value);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (isComposingKey(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlight((h) =>
        h < 0 ? 0 : Math.min(filtered.length - 1, h + 1),
      );
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlight((h) => (h < 0 ? 0 : Math.max(0, h - 1)));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      pickHighlight();
      return;
    }
    if (e.key === " " && !searchable) {
      e.preventDefault();
      pickHighlight();
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      if (filtered.length > 0) setHighlight(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      if (filtered.length > 0) setHighlight(filtered.length - 1);
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (
        searchable &&
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        setQuery(e.key);
        setOpen(true);
      }
      return;
    }
    onMenuKeyDown(e);
  };

  const activeDesc =
    highlight >= 0 && highlight < filtered.length
      ? `${listId}-opt-${highlight}`
      : undefined;

  const menu =
    open &&
    pos &&
    createPortal(
      <div
        ref={menuRef}
        className={`bounded-select-menu${className ? ` ${className}` : ""}`}
        style={{
          top: pos.openUp ? undefined : pos.top,
          bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
          left: pos.left,
          width: pos.width,
          maxHeight: pos.maxHeight,
        }}
      >
        {searchable && (
          <div className="bounded-select-search">
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder={searchPlaceholder}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label={searchPlaceholder}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={activeDesc}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onMenuKeyDown}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
        <ul ref={listRef} id={listId} role="listbox" className="bounded-select-list">
          {filtered.length === 0 ? (
            <li className="bounded-select-empty" role="presentation">
              該当なし
            </li>
          ) : (
            filtered.map((opt, i) => {
              const active = opt.value === value;
              return (
                <li
                  key={opt.value === "" ? `__empty-${i}` : opt.value}
                  role="presentation"
                >
                  <button
                    type="button"
                    id={`${listId}-opt-${i}`}
                    role="option"
                    aria-selected={active}
                    className={`bounded-select-option${active ? " selected" : ""}${
                      i === highlight ? " highlight" : ""
                    }`}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => pick(opt.value)}
                  >
                    {opt.label}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>,
      document.body,
    );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`bounded-select-trigger${className ? ` ${className}` : ""}${
          !selected && !value ? " placeholder" : ""
        }`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={(e) => {
          onClick?.(e);
          if (!disabled) setOpen((o) => !o);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="bounded-select-label">{label}</span>
        <span className="bounded-select-caret" aria-hidden>
          ▾
        </span>
      </button>
      {menu}
    </>
  );
}
