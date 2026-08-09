import { useMemo, useState } from "react";
import { SplitChipPicker } from "./SplitChipPicker";
import { BoundedSelect } from "./BoundedSelect";
import { PRESET_PUNCTUATION, type SplitMode } from "../lib/splitText";
import { importScriptLines, type ImportedLine } from "../lib/scriptImport";
import type { SpeakerInfo } from "../types";
import { speakerOptionLabel } from "../types";

type Props = {
  speakers: SpeakerInfo[];
  onConfirm: (lines: ImportedLine[]) => void;
  onCancel: () => void;
};

export function BulkAddDialog({ speakers, onConfirm, onCancel }: Props) {
  const [raw, setRaw] = useState("");
  const [delimiters, setDelimiters] = useState<string[]>([
    ...PRESET_PUNCTUATION,
  ]);
  const [mode, setMode] = useState<SplitMode>("strict");
  const [packLimit, setPackLimit] = useState("80");

  const preview = useMemo(() => {
    const limit = Math.max(1, Number(packLimit) || 80);
    return importScriptLines(raw, delimiters, mode, limit);
  }, [raw, delimiters, mode, packLimit]);

  const unmatched = useMemo(() => {
    const names = new Set(speakers.map((s) => s.name));
    const miss = new Set<string>();
    for (const line of preview) {
      if (line.speakerName && !names.has(line.speakerName)) {
        miss.add(line.speakerName);
      }
    }
    return [...miss];
  }, [preview, speakers]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal panel bulk-add-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-header">
          <h3>テキスト追加</h3>
        </header>
        <div className="panel-body form-stack">
          <label>
            スクリプト
            <textarea
              className="bulk-add-textarea"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={
                "ここにテキストを貼り付け…\n話者名: セリフ（半角/全角コロン可）"
              }
              rows={8}
              autoFocus
            />
          </label>

          <div>
            <span className="field-label">区切り文字</span>
            <SplitChipPicker selected={delimiters} onChange={setDelimiters} />
          </div>

          <div className="blend-row">
            <label>
              分割モード
              <BoundedSelect
                value={mode}
                options={[
                  { value: "strict", label: "strict（区切りごと）" },
                  { value: "pack", label: "pack（文字数で結合）" },
                ]}
                onChange={(v) => setMode(v as SplitMode)}
                aria-label="分割モード"
              />
            </label>
            {mode === "pack" && (
              <label>
                pack 上限文字数
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={packLimit}
                  onChange={(e) => setPackLimit(e.target.value)}
                />
              </label>
            )}
          </div>

          {unmatched.length > 0 && (
            <p className="hint warn-hint">
              未登録の話者名: {unmatched.join(", ")}（直前話者を継承）
            </p>
          )}

          <div>
            <span className="field-label">
              プレビュー（{preview.length} 行）
            </span>
            <ol className="bulk-add-preview">
              {preview.length === 0 ? (
                <li className="hint">（空）</li>
              ) : (
                preview.map((line, i) => {
                  const sp = line.speakerName
                    ? speakers.find((s) => s.name === line.speakerName)
                    : null;
                  return (
                    <li key={`${i}-${line.text.slice(0, 12)}`}>
                      <span className="bulk-speaker-tag">
                        {line.speakerName
                          ? sp
                            ? speakerOptionLabel(sp)
                            : `${line.speakerName}?`
                          : "（継承）"}
                      </span>{" "}
                      {line.text}
                    </li>
                  );
                })
              )}
            </ol>
          </div>

          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={preview.length === 0}
              onClick={() => onConfirm(preview)}
            >
              確定（{preview.length} 行追加）
            </button>
            <button type="button" onClick={onCancel}>
              キャンセル
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
