import { useEffect, useRef, useState } from "react";

type Props = {
  /** 1-based line number (odd → 奇数行適用, even → 偶数行適用) */
  lineNumber: number;
  disabled?: boolean;
  /** この行で直前に選んでいた話者名。未変更なら null */
  formerSpeakerLabel: string | null;
  onApplyAll: () => void;
  onApplyParity: () => void;
  onApplyFromHere: () => void;
  onApplyFormerSpeaker: () => void;
};

export function SpeakerApplyMenu({
  lineNumber,
  disabled,
  formerSpeakerLabel,
  onApplyAll,
  onApplyParity,
  onApplyFromHere,
  onApplyFormerSpeaker,
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
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onApplyFromHere();
            }}
          >
            以降の行に適用
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={formerSpeakerLabel == null}
            title={
              formerSpeakerLabel == null
                ? "この行の話者を変更すると使えます"
                : `変更前の話者「${formerSpeakerLabel}」の行に、今の話者を適用`
            }
            onClick={(e) => {
              e.stopPropagation();
              if (formerSpeakerLabel == null) return;
              setOpen(false);
              onApplyFormerSpeaker();
            }}
          >
            {formerSpeakerLabel == null
              ? "変更前の話者と同一の行に適用"
              : `変更前「${formerSpeakerLabel}」と同一の行に適用`}
          </button>
        </div>
      )}
    </div>
  );
}
