import { useEffect, useMemo, useState } from "react";
import type { DocImportOptions, ParsedDoc } from "../lib/docImport/index";
import { parseDocFile, sectionText } from "../lib/docImport/index";

export type ImportMode = "append" | "replace";

type Props = {
  doc: ParsedDoc;
  file: File;
  onConfirm: (text: string, mode: ImportMode) => void;
  onCancel: () => void;
};

export function DocumentImportPreviewDialog({ doc, file, onConfirm, onCancel }: Props) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(doc.sections.map((_, i) => i)),
  );
  const [mode, setMode] = useState<ImportMode>("append");
  const [includeTables, setIncludeTables] = useState(false);
  const [skipReferences, setSkipReferences] = useState(true);
  const [includeCaptions, setIncludeCaptions] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const [reparsedDoc, setReparsedDoc] = useState<ParsedDoc>(doc);
  const [reparsing, setReparsing] = useState(false);

  useEffect(() => {
    setSelected(new Set(doc.sections.map((_, i) => i)));
    setReparsedDoc(doc);
  }, [doc]);

  const reparse = async (opts: DocImportOptions) => {
    setReparsing(true);
    try {
      const newDoc = await parseDocFile(file, opts);
      setReparsedDoc(newDoc);
      setSelected(new Set(newDoc.sections.map((_, i) => i)));
    } catch {
      // ignore
    } finally {
      setReparsing(false);
    }
  };

  const handleIncludeTablesChange = (val: boolean) => {
    setIncludeTables(val);
    if (doc.format === "md") void reparse({ includeTables: val });
  };
  const handleSkipReferencesChange = (val: boolean) => {
    setSkipReferences(val);
    if (doc.format === "pdf") void reparse({ skipReferences: val, includeCaptions });
  };
  const handleIncludeCaptionsChange = (val: boolean) => {
    setIncludeCaptions(val);
    if (doc.format === "pdf") void reparse({ skipReferences, includeCaptions: val });
  };

  const displayDoc = reparsedDoc;

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(displayDoc.sections.map((_, i) => i)) : new Set());
  };

  const toggleSection = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const totals = useMemo(() => {
    let lines = 0; let chars = 0;
    for (const [i, s] of displayDoc.sections.entries()) {
      if (selected.has(i)) { lines += s.lineCount; chars += s.charCount; }
    }
    return { lines, chars };
  }, [displayDoc, selected]);

  const handleConfirm = () => {
    if (mode === "replace" && !confirmReplace) { setConfirmReplace(true); return; }
    onConfirm(sectionText(displayDoc.sections, selected), mode);
  };

  const allChecked = displayDoc.sections.length > 0 && displayDoc.sections.every((_, i) => selected.has(i));
  const someChecked = selected.size > 0 && !allChecked;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal panel doc-import-modal" onClick={(e) => e.stopPropagation()}>
        <header className="panel-header">
          <h3>インポートプレビュー: {doc.fileName}</h3>
        </header>

        <div className="panel-body doc-import-body">
          {doc.warnings.length > 0 && (
            <div className="doc-import-warnings">
              {doc.warnings.map((w, i) => (
                <p key={i} className="hint warn-hint">{w}</p>
              ))}
            </div>
          )}

          <div className="doc-import-toolbar">
            <label className="doc-import-check-all">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => { if (el) el.indeterminate = someChecked; }}
                onChange={(e) => toggleAll(e.target.checked)}
              />
              すべて選択
            </label>
            {doc.format === "md" && (
              <label className="doc-import-check-all">
                <input type="checkbox" checked={includeTables} disabled={reparsing}
                  onChange={(e) => handleIncludeTablesChange(e.target.checked)} />
                テーブルを含める
              </label>
            )}
            {doc.format === "pdf" && (
              <>
                <label className="doc-import-check-all">
                  <input type="checkbox" checked={!skipReferences} disabled={reparsing}
                    onChange={(e) => handleSkipReferencesChange(!e.target.checked)} />
                  参考文献を含める
                </label>
                <label className="doc-import-check-all">
                  <input type="checkbox" checked={includeCaptions} disabled={reparsing}
                    onChange={(e) => handleIncludeCaptionsChange(e.target.checked)} />
                  図表キャプション
                </label>
              </>
            )}
          </div>

          <ol className="doc-import-section-list">
            {displayDoc.sections.map((s, i) => (
              <li key={i} className={`doc-import-section-item ${selected.has(i) ? "selected" : ""}`}>
                <label className="doc-import-section-header">
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggleSection(i)} />
                  <span className="doc-import-section-heading">{s.heading ?? "（無題）"}</span>
                  <span className="doc-import-section-stats">{s.lineCount} 行 / {s.charCount.toLocaleString()} 字</span>
                </label>
                <div className="doc-import-section-body">{s.text.trim()}</div>
              </li>
            ))}
          </ol>
        </div>

        <footer className="panel-footer doc-import-footer">
          <div className="doc-import-footer-row">
            <span className="field-label" style={{ margin: 0, whiteSpace: "nowrap" }}>取り込みモード</span>
            <label className="doc-import-radio-label">
              <input type="radio" name="import-mode" value="append"
                checked={mode === "append"}
                onChange={() => { setMode("append"); setConfirmReplace(false); }} />
              追記
            </label>
            <label className="doc-import-radio-label">
              <input type="radio" name="import-mode" value="replace"
                checked={mode === "replace"} onChange={() => setMode("replace")} />
              全置換
            </label>
            <span className="doc-import-totals hint">
              {totals.lines} 行 / {totals.chars.toLocaleString()} 字
            </span>
            <div style={{ flex: 1 }} />
            <button type="button" className="primary" disabled={selected.size === 0} onClick={handleConfirm}>
              {confirmReplace ? "置換して取り込む" : "取り込む"}
            </button>
            <button type="button" onClick={() => { setConfirmReplace(false); onCancel(); }}>
              キャンセル
            </button>
          </div>
          {confirmReplace && (
            <p className="hint warn-hint" style={{ margin: "0.3rem 0 0" }}>
              既存のスクリプトをすべて置き換えます。よろしいですか？
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}
