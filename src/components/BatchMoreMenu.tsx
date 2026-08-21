import { useEffect, useRef, useState } from "react";

type Props = {
  disabled?: boolean;
  canKatakana?: boolean;
  onKatakana: () => void;
  onReplace: () => void;
  onAsrVerify: () => void;
};

export function BatchMoreMenu({
  disabled,
  canKatakana,
  onKatakana,
  onReplace,
  onAsrVerify,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
    <div className="batch-more" ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="その他の一括操作"
      >
        その他 ▾
      </button>
      {open && (
        <div className="batch-more-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={!canKatakana}
            onClick={() => {
              setOpen(false);
              onKatakana();
            }}
          >
            読み提案
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onReplace();
            }}
          >
            語句置換
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAsrVerify();
            }}
          >
            文字起こし検証
          </button>
        </div>
      )}
    </div>
  );
}
