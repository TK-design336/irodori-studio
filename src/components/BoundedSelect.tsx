import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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
  className?: string;
  disabled?: boolean;
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

function computePos(trigger: DOMRect, itemCount: number): MenuPos {
  const estH = Math.min(MENU_MAX, Math.max(36, itemCount * 26 + 6));
  const spaceBelow = window.innerHeight - trigger.bottom - MARGIN;
  const spaceAbove = trigger.top - MARGIN;
  const openUp = spaceBelow < estH && spaceAbove > spaceBelow;
  const maxHeight = Math.max(80, Math.min(MENU_MAX, openUp ? spaceAbove : spaceBelow));
  const width = Math.max(trigger.width, 120);
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

export function BoundedSelect({
  value,
  options,
  onChange,
  placeholder = "選択…",
  className = "",
  disabled = false,
  "aria-label": ariaLabel,
  onClick,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? (value ? value : placeholder);

  const updatePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    setPos(computePos(el.getBoundingClientRect(), options.length));
  }, [options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePos();
    const idx = options.findIndex((o) => o.value === value);
    setHighlight(idx >= 0 ? idx : 0);
  }, [open, updatePos, options, value]);

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
    const item = menuRef.current?.children[highlight] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(options.length - 1, h + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (highlight >= 0 && highlight < options.length) {
        pick(options[highlight].value);
      }
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setHighlight(options.length - 1);
    }
  };

  const menu =
    open &&
    pos &&
    createPortal(
      <ul
        ref={menuRef}
        id={listId}
        role="listbox"
        className={`bounded-select-menu${className ? ` ${className}` : ""}`}
        style={{
          top: pos.openUp ? undefined : pos.top,
          bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
          left: pos.left,
          width: pos.width,
          maxHeight: pos.maxHeight,
        }}
      >
        {options.map((opt, i) => {
          const active = opt.value === value;
          return (
            <li key={opt.value === "" ? `__empty-${i}` : opt.value} role="presentation">
              <button
                type="button"
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
        })}
      </ul>,
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
        onKeyDown={onKeyDown}
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
