import { useEffect, useRef, useState } from "react";

type Props = {
  /** 1-based line number (odd → 奇数行適用, even → 偶数行適用) */
  lineNumber: number;
  disabled?: boolean;
  onApplyAll: () => void;
  onApplyParity: () => void;
};

export function SpeakerApplyMenu({
  lineNumber,
  disabled,
  onApplyAll,
  onApplyParity,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isOdd = lineNumber % 2 === 1;
  const parityLabel = isOdd ? "奇数行に適用" : "偶数行に適用";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="speaker-apply" ref={rootRef}>
      <button
        type="button"
        className="line-btn speaker-apply-btn"
        disabled={disabled}
        aria-expanded={open}
        aria-label="話者の一括適用"
        title="話者の一括適用"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ▾
      </button>
      {open && (
        <div className="speaker-apply-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onApplyAll();
            }}
          >
            全行に適用
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onApplyParity();
            }}
          >
            {parityLabel}
          </button>
        </div>
      )}
    </div>
  );
}
