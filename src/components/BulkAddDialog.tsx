import { useMemo, useRef, useState } from "react";
import { SplitChipPicker } from "./SplitChipPicker";
import { BoundedSelect } from "./BoundedSelect";
import { PRESET_PUNCTUATION, type SplitMode } from "../lib/splitText";
import { importScriptLines, packImportedLines, type ImportedLine } from "../lib/scriptImport";
import { splitText } from "../lib/splitText";
import type { SpeakerInfo } from "../types";
import { speakerOptionLabel } from "../types";
import { parseDocFile, isSupportedDocFile, filesFromDataTransfer, acceptFileDrag, type ParsedDoc } from "../lib/docImport/index";
import { DocumentImportPreviewDialog, type ImportMode } from "./DocumentImportPreviewDialog";

type Props = {
  speakers: SpeakerInfo[];
  onConfirm: (lines: ImportedLine[]) => void;
  onCancel: () => void;
  initialFile?: File;
};

export function BulkAddDialog({ speakers, onConfirm, onCancel, initialFile }: Props) {
  const [raw, setRaw] = useState("");
  const [delimiters, setDelimiters] = useState<string[]>([...PRESET_PUNCTUATION]);
  const [mode, setMode] = useState<SplitMode>("strict");
  const [packLimit, setPackLimit] = useState("80");
  const [speakerDetect, setSpeakerDetect] = useState(true);
  const [importDoc, setImportDoc] = useState<ParsedDoc | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initialFileParsed = useRef(false);
  if (initialFile && !initialFileParsed.current) {
    initialFileParsed.current = true;
    setImportFile(initialFile);
    void parseDocFile(initialFile).then(setImportDoc).catch((e: unknown) => {
      setImportError(String(e instanceof Error ? e.message : e));
    });
  }

  const handleDocFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    const supported = arr.filter(isSupportedDocFile);
    if (supported.length === 0) {
      setImportError("対応していないファイル形式です（.txt .md .docx .pdf）");
      return;
    }
    setImportError(null);
    try {
      const target = supported[0];
      const parsed = await parseDocFile(target);
      setImportFile(target);
      setImportDoc(parsed);
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    acceptFileDrag(e);
    setDropOver(false);
    void handleDocFiles(filesFromDataTransfer(e.dataTransfer));
  };
  const handleDragOver = (e: React.DragEvent) => {
    acceptFileDrag(e);
    setDropOver(true);
  };
  const handleDragEnter = (e: React.DragEvent) => {
    acceptFileDrag(e);
    setDropOver(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropOver(false);
  };
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) void handleDocFiles(e.target.files);
  };

  const handleImportConfirm = (text: string, importMode: ImportMode) => {
    setRaw(importMode === "replace" ? text : (raw.trim() ? raw.trim() + "\n\n" + text : text));
    setImportDoc(null);
  };

  const preview = useMemo(() => {
    const limit = Math.max(1, Number(packLimit) || 80);
    if (speakerDetect) {
      return importScriptLines(raw, delimiters, mode, limit);
    }
    // 話者識別オフ: splitText のみ適用して speakerName は常に null
    const rows = raw.replace(/^\uFEFF/, "").split(/\r?\n/).filter((r) => r.trim());
    const segments: ImportedLine[] = rows.flatMap((row) =>
      splitText(row, delimiters, "strict").map((t) => ({ text: t, speakerName: null })),
    );
    if (mode === "pack") return packImportedLines(segments, limit);
    return segments;
  }, [raw, delimiters, mode, packLimit, speakerDetect]);

  const unmatched = useMemo(() => {
    const names = new Set(speakers.map((s) => s.name));
    const miss = new Set<string>();
    for (const line of preview) {
      if (line.speakerName && !names.has(line.speakerName)) miss.add(line.speakerName);
    }
    return [...miss];
  }, [preview, speakers]);

  return (
    <>
      <div className="modal-backdrop" onClick={onCancel}>
        <div
          className="modal panel bulk-add-modal"
          onClick={(e) => e.stopPropagation()}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <header className="panel-header">
            <h3>テキスト追加</h3>
          </header>

          <div className="panel-body form-stack">
            <div className={`doc-drop-zone ${dropOver ? "drag-over" : ""}`}>
              <span>ファイルをドロップ、または</span>
              <button
                type="button"
                className="doc-drop-browse"
                onClick={() => fileInputRef.current?.click()}
              >
                ファイルを選択
              </button>
              <span className="doc-drop-hint">（.txt .md .docx .pdf）</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.markdown,.docx,.pdf"
                style={{ display: "none" }}
                onChange={handleFileInput}
              />
            </div>
            {importError && <p className="hint warn-hint">{importError}</p>}

            <label>
              スクリプト
              <textarea
                className="bulk-add-textarea"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                placeholder={"ここにテキストを貼り付け…\n話者名: セリフ（半角/全角コロン可）"}
                rows={8}
                autoFocus
              />
            </label>

            <div>
              <span className="field-label">区切り文字</span>
              <SplitChipPicker selected={delimiters} onChange={setDelimiters} />
            </div>

            <div className="blend-row bulk-add-split-row">
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
              <label className="bulk-add-speaker-toggle">
                <input
                  type="checkbox"
                  checked={speakerDetect}
                  onChange={(e) => setSpeakerDetect(e.target.checked)}
                />
                話者識別
              </label>
            </div>

            {unmatched.length > 0 && (
              <p className="hint warn-hint">
                未登録の話者名: {unmatched.join(", ")}（直前話者を継承）
              </p>
            )}

            <div>
              <span className="field-label">プレビュー（{preview.length} 行）</span>
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
                            ? sp ? speakerOptionLabel(sp) : `${line.speakerName}?`
                            : "（継承）"}
                        </span>{" "}
                        {line.text}
                      </li>
                    );
                  })
                )}
              </ol>
            </div>
          </div>

          <footer className="panel-footer row">
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
          </footer>
        </div>
      </div>

      {importDoc && importFile && (
        <DocumentImportPreviewDialog
          doc={importDoc}
          file={importFile}
          onConfirm={handleImportConfirm}
          onCancel={() => { setImportDoc(null); setImportFile(null); }}
        />
      )}
    </>
  );
}
