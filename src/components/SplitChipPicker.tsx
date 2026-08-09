import {
  ALL_SPLIT_CANDIDATES,
  PRESET_NEWLINE,
  PRESET_PUNCTUATION,
  displayDelimiter,
} from "../lib/splitText";

type Props = {
  selected: string[];
  onChange: (next: string[]) => void;
};

export function SplitChipPicker({ selected, onChange }: Props) {
  const selectedSet = new Set(selected);

  const toggle = (d: string) => {
    if (selectedSet.has(d)) {
      onChange(selected.filter((x) => x !== d));
    } else {
      onChange([...selected, d]);
    }
  };

  return (
    <div className="split-chip-picker">
      <div className="row split-presets">
        <button
          type="button"
          onClick={() => onChange([...PRESET_PUNCTUATION])}
          title="句読点で分割"
        >
          標準句読点
        </button>
        <button
          type="button"
          onClick={() => onChange([...PRESET_NEWLINE])}
          title="改行のみで分割"
        >
          改行のみ
        </button>
      </div>

      <div className="split-candidates" aria-label="区切り候補">
        {ALL_SPLIT_CANDIDATES.map((d) => {
          const on = selectedSet.has(d);
          return (
            <button
              key={`cand-${JSON.stringify(d)}`}
              type="button"
              className={`chip ${on ? "chip-on" : ""}`}
              aria-pressed={on}
              onClick={() => toggle(d)}
            >
              {displayDelimiter(d)}
            </button>
          );
        })}
      </div>
      {selected.length === 0 && (
        <span className="hint">区切り未選択（全文が 1 行）</span>
      )}
    </div>
  );
}
