import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SplitChipPicker } from "./SplitChipPicker";
import { BoundedSelect } from "./BoundedSelect";
import { PRESET_PUNCTUATION, type SplitMode } from "../lib/splitText";
import { importScriptLines, packImportedLines, type ImportedLine } from "../lib/scriptImport";
import { splitText } from "../lib/splitText";
import type { SpeakerInfo } from "../types";
import { speakerOptionLabel } from "../types";
import {
  parseDocFile,
  isSupportedDocFile,
  isSupportedAudioFile,
  isSupportedImportFile,
  isSupportedAudioName,
  isSupportedDocName,
  IMPORT_DIALOG_FILTERS,
  IMPORT_HINT,
  type ParsedDoc,
} from "../lib/docImport/index";
import { useTauriFileDrop } from "../lib/tauriFileDrop";
import { DocumentImportPreviewDialog, type ImportMode } from "./DocumentImportPreviewDialog";
import { IconMic } from "./icons";
import { useTextDictation } from "../lib/useTextDictation";
import {
  transcribeImportAudio,
  transcribeImportAudioPath,
} from "../lib/transcribeImportAudio";

type Props = {
  speakers: SpeakerInfo[];
  onConfirm: (
    lines: ImportedLine[],
    opts?: { replace?: boolean },
  ) => void;
  onCancel: () => void;
  initialFile?: File;
  initialPath?: string;
};

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function appendScript(current: string, incoming: string): string {
  const next = incoming.trim();
  if (!next) return current;
  const prev = current.trim();
  return prev ? `${prev}\n\n${next}` : next;
}

export function BulkAddDialog({
  speakers,
  onConfirm,
  onCancel,
  initialFile,
  initialPath,
}: Props) {
  const [raw, setRaw] = useState("");
  const [delimiters, setDelimiters] = useState<string[]>([...PRESET_PUNCTUATION]);
  const [mode, setMode] = useState<SplitMode>("strict");
  const [packLimit, setPackLimit] = useState("80");
  const [speakerDetect, setSpeakerDetect] = useState(true);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [importDoc, setImportDoc] = useState<ParsedDoc | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [scriptFocused, setScriptFocused] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const caretRef = useRef({ start: 0, end: 0 });
  const dictationRangeRef = useRef({ start: 0, liveEnd: 0 });
  const initialHandled = useRef(false);

  const rememberCaret = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    caretRef.current = {
      start: el.selectionStart ?? rawRef.current.length,
      end: el.selectionEnd ?? rawRef.current.length,
    };
  }, []);

  const restoreCaret = useCallback((caret: number) => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const c = Math.max(0, Math.min(caret, el.value.length));
      el.setSelectionRange(c, c);
      caretRef.current = { start: c, end: c };
    });
  }, []);

  const applyDictationText = useCallback(
    (insert: string, commit: boolean) => {
      const text = rawRef.current;
      const range = dictationRangeRef.current;
      const start = Math.max(0, Math.min(range.start, text.length));
      const liveEnd = Math.max(start, Math.min(range.liveEnd, text.length));
      const next = text.slice(0, start) + insert + text.slice(liveEnd);
      const caret = start + insert.length;
      if (commit) {
        dictationRangeRef.current = { start: caret, liveEnd: caret };
      } else {
        dictationRangeRef.current = { start, liveEnd: caret };
      }
      rawRef.current = next;
      setRaw(next);
      restoreCaret(caret);
    },
    [restoreCaret],
  );

  const {
    dictating,
    dictatingRef,
    dictationLevel,
    dictationHint,
    dictationError,
    toggleDictation,
    stopDictation,
  } = useTextDictation(applyDictationText);

  const handleToggleDictation = useCallback(() => {
    if (!dictatingRef.current) {
      rememberCaret();
      const { start, end } = caretRef.current;
      dictationRangeRef.current = { start, liveEnd: end };
    }
    void toggleDictation();
  }, [dictatingRef, rememberCaret, toggleDictation]);

  const ingestFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    const supported = arr.filter(isSupportedImportFile);
    if (supported.length === 0) {
      setImportError("対応していないファイル形式です（.txt .md .docx .pdf .mp3 .wav）");
      return;
    }
    const target = supported[0];
    setImportError(null);
    setImportStatus(null);
    if (isSupportedAudioFile(target)) {
      setTranscribing(true);
      setImportStatus("音声を文字起こししています…");
      try {
        await stopDictation();
        const text = await transcribeImportAudio(target);
        setRaw((prev) => appendScript(prev, text));
        setImportStatus(null);
      } catch (e: unknown) {
        setImportError(e instanceof Error ? e.message : String(e));
        setImportStatus(null);
      } finally {
        setTranscribing(false);
      }
      return;
    }
    if (!isSupportedDocFile(target)) {
      setImportError("対応していないファイル形式です（.txt .md .docx .pdf .mp3 .wav）");
      return;
    }
    try {
      const parsed = await parseDocFile(target);
      setImportFile(target);
      setImportDoc(parsed);
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  }, [stopDictation]);

  const ingestPath = useCallback(async (path: string) => {
    const name = fileNameFromPath(path);
    setImportError(null);
    setImportStatus(null);
    if (isSupportedAudioName(name)) {
      setTranscribing(true);
      setImportStatus("音声を文字起こししています…");
      try {
        await stopDictation();
        const text = await transcribeImportAudioPath(path);
        setRaw((prev) => appendScript(prev, text));
        setImportStatus(null);
      } catch (e: unknown) {
        setImportError(e instanceof Error ? e.message : String(e));
        setImportStatus(null);
      } finally {
        setTranscribing(false);
      }
      return;
    }
    if (!isSupportedDocName(name)) {
      setImportError("対応していないファイル形式です（.txt .md .docx .pdf .mp3 .wav）");
      return;
    }
    try {
      const bytes = await invoke<number[]>("read_file_bytes", { path });
      const file = new File([new Uint8Array(bytes)], name);
      const parsed = await parseDocFile(file);
      setImportFile(file);
      setImportDoc(parsed);
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  }, [stopDictation]);

  const pickImportFile = useCallback(async () => {
    if (transcribing) return;
    const selected = await open({
      multiple: false,
      filters: IMPORT_DIALOG_FILTERS,
    });
    if (typeof selected === "string") void ingestPath(selected);
  }, [ingestPath, transcribing]);

  useEffect(() => {
    if (initialHandled.current) return;
    if (initialPath) {
      initialHandled.current = true;
      void ingestPath(initialPath);
      return;
    }
    if (initialFile) {
      initialHandled.current = true;
      void ingestFiles([initialFile]);
    }
  }, [initialFile, initialPath, ingestFiles, ingestPath]);

  const handlePathsDrop = useCallback(
    (paths: string[]) => {
      if (transcribing) return;
      const path = paths[0];
      if (!path) return;
      const name = fileNameFromPath(path);
      if (!isSupportedDocName(name) && !isSupportedAudioName(name)) {
        setImportError("対応していないファイル形式です（.txt .md .docx .pdf .mp3 .wav）");
        return;
      }
      void ingestPath(path);
    },
    [ingestPath, transcribing],
  );

  useTauriFileDrop(modalRef, {
    enabled: !transcribing,
    onHover: setDropOver,
    onDrop: handlePathsDrop,
  });

  const handleImportConfirm = (text: string, importMode: ImportMode) => {
    setRaw(importMode === "replace" ? text : appendScript(raw, text));
    setImportDoc(null);
    setImportFile(null);
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

  const showMic = scriptFocused || dictating;

  return (
    <>
      <div className="modal-backdrop" onClick={onCancel}>
        <div
          ref={modalRef}
          className="modal panel bulk-add-modal"
          onClick={(e) => e.stopPropagation()}
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
                disabled={transcribing}
                onClick={() => void pickImportFile()}
              >
                ファイルを選択
              </button>
              <span className="doc-drop-hint">{IMPORT_HINT}</span>
            </div>
            {importStatus && <p className="hint">{importStatus}</p>}
            {importError && <p className="hint warn-hint">{importError}</p>}

            <label>
              スクリプト
              <div
                className={`line-text-wrap bulk-add-script-wrap${
                  scriptFocused ? " is-editing" : ""
                }${dictating ? " is-dictating" : ""}`}
              >
                <textarea
                  ref={textareaRef}
                  className="bulk-add-textarea"
                  value={raw}
                  onChange={(e) => {
                    const next = e.target.value;
                    rawRef.current = next;
                    setRaw(next);
                    rememberCaret();
                    if (dictatingRef.current) {
                      const caret = e.target.selectionStart ?? next.length;
                      dictationRangeRef.current = { start: caret, liveEnd: caret };
                    }
                  }}
                  onSelect={() => {
                    rememberCaret();
                    if (!dictatingRef.current) return;
                    const c = caretRef.current;
                    const range = dictationRangeRef.current;
                    if (c.start >= range.start && c.end <= range.liveEnd) return;
                    dictationRangeRef.current = { start: c.start, liveEnd: c.end };
                  }}
                  onKeyUp={rememberCaret}
                  onClick={rememberCaret}
                  onFocus={() => {
                    setScriptFocused(true);
                    rememberCaret();
                  }}
                  onBlur={(e) => {
                    const next = e.relatedTarget;
                    if (next instanceof Element && next.closest(".line-dictation-btn")) {
                      return;
                    }
                    rememberCaret();
                    setScriptFocused(false);
                  }}
                  placeholder={"ここにテキストを貼り付け…\n話者名: セリフ（半角/全角コロン可）"}
                  rows={8}
                  autoFocus
                />
                {showMic && dictationHint ? (
                  <span
                    className={`line-dictation-hint${dictationError ? " is-error" : ""}`}
                  >
                    {dictationHint}
                  </span>
                ) : null}
                {showMic ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className={`line-dictation-btn${
                      dictating ? " is-active action-aura" : ""
                    }`}
                    aria-pressed={dictating}
                    aria-label={dictating ? "音声入力を停止" : "音声入力を開始"}
                    title={dictating ? "音声入力を停止" : "音声入力"}
                    disabled={transcribing}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleToggleDictation();
                    }}
                  >
                    <span
                      className="line-dictation-level"
                      aria-hidden
                      style={{
                        transform: `translate(-50%, -50%) scale(${0.4 + dictationLevel * 0.85})`,
                        opacity: dictating ? 0.35 + dictationLevel * 0.5 : 0,
                      }}
                    />
                    <IconMic size={14} />
                  </button>
                ) : null}
              </div>
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
              <label className="bulk-add-speaker-toggle">
                <input
                  type="checkbox"
                  checked={replaceExisting}
                  onChange={(e) => setReplaceExisting(e.target.checked)}
                />
                既存行を置き換える
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
              disabled={preview.length === 0 || transcribing}
              onClick={() => onConfirm(preview, { replace: replaceExisting })}
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
