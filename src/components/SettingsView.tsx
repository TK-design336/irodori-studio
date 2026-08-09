import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BoundedSelect } from "./BoundedSelect";
import type {
  AppSettings,
  ExportFilenamePart,
  IrodoriVersion,
  PathValidation,
  VersionPathSettings,
} from "../types";
import { activePaths } from "../types";
import {
  DEFAULT_EXPORT_FILENAME_PARTS,
  EXPORT_FILENAME_PART_LABELS,
  EXPORT_FILENAME_PARTS,
  normalizeExportFilenameParts,
  previewExportFileName,
} from "../lib/exportFileName";

type Props = {
  settings: AppSettings;
  validation: PathValidation | null;
  onSaved: (s: AppSettings) => void;
  onValidate: () => void;
};

type PathKey = keyof VersionPathSettings;

const PATH_FIELDS: Array<[PathKey, string, boolean]> = [
  ["irodoriRoot", "Irodori ルート", true],
  ["outputsRoot", "Outputs ルート", true],
  ["checkpointPath", "Checkpoint", false],
  ["pythonExe", "Python 実行ファイル", false],
];

function normalizeVersion(v: string | undefined): IrodoriVersion {
  return v === "v4" ? "v4" : "v3";
}

function movePart(
  parts: ExportFilenamePart[],
  index: number,
  dir: -1 | 1,
): ExportFilenamePart[] {
  const next = [...parts];
  const j = index + dir;
  if (j < 0 || j >= next.length) return parts;
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

export function SettingsView({
  settings,
  validation,
  onSaved,
  onValidate,
}: Props) {
  const [draft, setDraft] = useState(settings);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolvedPython, setResolvedPython] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    invoke<string | null>("resolve_python_path")
      .then(setResolvedPython)
      .catch(() => setResolvedPython(null));
  }, [settings, validation, draft.irodoriVersion]);

  const version = normalizeVersion(draft.irodoriVersion);
  const editingPaths = version === "v4" ? draft.pathsV4 : draft.pathsV3;
  const pathsDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );

  const filenameParts = useMemo(
    () =>
      normalizeExportFilenameParts(
        draft.exportFilenameParts ?? DEFAULT_EXPORT_FILENAME_PARTS,
      ),
    [draft.exportFilenameParts],
  );
  const unusedParts = useMemo(
    () => EXPORT_FILENAME_PARTS.filter((p) => !filenameParts.includes(p)),
    [filenameParts],
  );
  const filenamePreview = useMemo(
    () => previewExportFileName(filenameParts, draft.utteranceMaxChars),
    [filenameParts, draft.utteranceMaxChars],
  );

  const setShared = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const setFilenameParts = (parts: ExportFilenamePart[]) => {
    setShared(
      "exportFilenameParts",
      normalizeExportFilenameParts(parts),
    );
  };

  const persist = async (next: AppSettings, okMsg: string) => {
    setBusy(true);
    try {
      const saved = await invoke<AppSettings>("set_settings", {
        settings: {
          ...next,
          exportFilenameParts: normalizeExportFilenameParts(
            next.exportFilenameParts,
          ),
        },
      });
      setDraft(saved);
      onSaved(saved);
      setMsg(okMsg);
      onValidate();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Version switch applies immediately — learning/generation use saved settings. */
  const setVersion = (next: IrodoriVersion) => {
    if (normalizeVersion(draft.irodoriVersion) === next) return;
    const merged: AppSettings = { ...draft, irodoriVersion: next };
    setDraft(merged);
    void persist(merged, `エンジンを ${next.toUpperCase()} に切り替えました`);
  };

  const setPath = (key: PathKey, value: string) => {
    setDraft((d) => {
      const ver = normalizeVersion(d.irodoriVersion);
      if (ver === "v4") {
        return { ...d, pathsV4: { ...d.pathsV4, [key]: value } };
      }
      return { ...d, pathsV3: { ...d.pathsV3, [key]: value } };
    });
  };

  const pickDir = async (key: PathKey) => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setPath(key, selected);
  };

  const pickFile = async (key: PathKey) => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Model", extensions: ["safetensors", "pt", "exe"] }],
    });
    if (typeof selected === "string") setPath(key, selected);
  };

  const pickProjectsDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setShared("projectsRoot", selected);
  };

  const pickFfmpeg = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: "ffmpeg", extensions: ["exe"] },
        { name: "All", extensions: ["*"] },
      ],
    });
    if (typeof selected === "string") setShared("ffmpegPath", selected);
  };

  const save = async () => {
    await persist(draft, "設定を保存しました");
  };

  const Flag = ({ ok, label }: { ok: boolean; label: string }) => (
    <li className={ok ? "ok" : "bad"}>
      {ok ? "✓" : "✗"} {label}
    </li>
  );

  return (
    <div className="settings-layout">
      <section className="panel">
        <header className="panel-header">
          <h3>エンジン版</h3>
        </header>
        <div className="panel-body form-stack">
          <div className="profile-kind-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={version === "v3" ? "active" : ""}
              aria-selected={version === "v3"}
              disabled={busy}
              onClick={() => setVersion("v3")}
            >
              Irodori TTS v3
            </button>
            <button
              type="button"
              role="tab"
              className={version === "v4" ? "active" : ""}
              aria-selected={version === "v4"}
              disabled={busy}
              onClick={() => setVersion("v4")}
            >
              Irodori TTS v4
            </button>
          </div>
          <p className="hint">
            版タブを押した時点でエンジン切替は保存されます（学習・生成は保存済み版を使用）。
            v3 / v4 はパス・Embedding が非互換です。下のパス項目を変えたあとは「保存」が必要です。
          </p>
          <p className="hint">
            学習 YAML:{" "}
            {version === "v4"
              ? "configs/train_v4_small_speaker_inversion.yaml"
              : "configs/train_500m_v3_speaker_inversion.yaml"}
          </p>
          {pathsDirty && (
            <p className="hint warn-text">
              パス等に未保存の変更があります。学習前に「保存」してください。
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h3>パス設定（{version.toUpperCase()}）</h3>
        </header>
        <div className="panel-body form-stack">
          {PATH_FIELDS.map(([key, label, isDir]) => (
            <label key={`${version}-${key}`}>
              {label}
              <div className="row">
                <input
                  value={editingPaths[key]}
                  onChange={(e) => setPath(key, e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => (isDir ? pickDir(key) : pickFile(key))}
                >
                  参照
                </button>
              </div>
            </label>
          ))}

          <label>
            プロジェクト保存先（共通）
            <div className="row">
              <input
                value={draft.projectsRoot}
                onChange={(e) => setShared("projectsRoot", e.target.value)}
              />
              <button type="button" onClick={() => void pickProjectsDir()}>
                参照
              </button>
            </div>
          </label>

          <label>
            ffmpeg（共通・任意）
            <div className="row">
              <input
                value={draft.ffmpegPath ?? ""}
                placeholder="空欄なら PATH の ffmpeg"
                onChange={(e) => setShared("ffmpegPath", e.target.value)}
              />
              <button type="button" onClick={() => void pickFfmpeg()}>
                参照
              </button>
            </div>
          </label>

          <div className="blend-row">
            <label>
              Model precision
              <BoundedSelect
                value={draft.modelPrecision}
                options={[
                  { value: "fp32", label: "fp32" },
                  { value: "bf16", label: "bf16" },
                  { value: "fp16", label: "fp16" },
                ]}
                onChange={(v) => setShared("modelPrecision", v)}
                aria-label="Model precision"
              />
            </label>
            <label>
              Codec precision
              <BoundedSelect
                value={draft.codecPrecision}
                options={[
                  { value: "fp32", label: "fp32" },
                  { value: "bf16", label: "bf16" },
                  { value: "fp16", label: "fp16" },
                ]}
                onChange={(v) => setShared("codecPrecision", v)}
                aria-label="Codec precision"
              />
            </label>
          </div>

          <div className="blend-row">
            <label>
              Model device
              <BoundedSelect
                value={draft.modelDevice || "cuda"}
                options={[
                  { value: "cuda", label: "cuda" },
                  { value: "cpu", label: "cpu" },
                ]}
                onChange={(v) => setShared("modelDevice", v)}
                aria-label="Model device"
              />
            </label>
            <label>
              Codec device
              <BoundedSelect
                value={draft.codecDevice || "cuda"}
                options={[
                  { value: "cuda", label: "cuda" },
                  { value: "cpu", label: "cpu" },
                ]}
                onChange={(v) => setShared("codecDevice", v)}
                aria-label="Codec device"
              />
            </label>
          </div>

          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || !pathsDirty}
              onClick={() => void save()}
            >
              保存
            </button>
            <button type="button" disabled={busy} onClick={onValidate}>
              検証
            </button>
            <span className="status-text">{msg}</span>
          </div>

          {validation && (
            <ul className="validation-list">
              <Flag
                ok={validation.irodoriRootOk}
                label={`Irodori ルート (${validation.irodoriVersion ?? version})`}
              />
              <Flag ok={validation.pythonOk} label="Python exe" />
              <Flag ok={validation.checkpointOk} label="Checkpoint" />
              <Flag ok={validation.outputsOk} label="Outputs" />
              <Flag
                ok={validation.trainConfigOk !== false}
                label="Speaker Inversion YAML"
              />
              <Flag
                ok={validation.ffmpegOk}
                label={`ffmpeg${validation.ffmpegPath ? ` (${validation.ffmpegPath})` : ""}`}
              />
              <Flag
                ok={validation.studioScriptsOk !== false}
                label={`Studio 同梱スクリプト${
                  validation.studioPythonDir
                    ? ` (${validation.studioPythonDir})`
                    : ""
                }`}
              />
            </ul>
          )}
          <p className="hint">
            Python は設定パス → `.venv` / `venv` → PATH の python/py
            の順で解決します。
            {resolvedPython ? ` 現在: ${resolvedPython}` : ""}
          </p>
          <p className="hint">
            ffmpeg は設定パス（exe またはフォルダ）→ PATH の順です。学習前処理にも反映されます。
          </p>
          <p className="hint">
            アクティブ: {activePaths(draft).irodoriRoot}
          </p>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h3>再生・保存</h3>
        </header>
        <div className="panel-body form-stack">
          <label>
            チャンク間無音（ms）
            <input
              type="number"
              min={0}
              step={50}
              value={draft.chunkSilenceMs}
              onChange={(e) =>
                setShared(
                  "chunkSilenceMs",
                  Math.max(0, Number(e.target.value) || 0),
                )
              }
            />
          </label>
          <p className="hint">
            一括再生の行間無音、および一括保存（連結）モーダルの初期値に使います。
          </p>
          <label>
            セリフ文字数上限（ファイル名）
            <input
              type="number"
              min={1}
              step={1}
              value={draft.utteranceMaxChars}
              onChange={(e) =>
                setShared(
                  "utteranceMaxChars",
                  Math.max(1, Math.floor(Number(e.target.value) || 1)),
                )
              }
            />
          </label>
          <p className="hint">
            個別エクスポート時のファイル名に含めるセリフ文字数の上限です。
          </p>

          <div className="filename-parts-field">
            <span className="filename-parts-label">自動ファイル名の並び</span>
            <ul className="filename-parts-list">
              {filenameParts.map((part, i) => (
                <li key={part} className="filename-parts-item">
                  <span className="filename-parts-name">
                    {EXPORT_FILENAME_PART_LABELS[part]}
                    {part === "index" ? (
                      <span className="filename-parts-required">必須</span>
                    ) : null}
                  </span>
                  <div className="filename-parts-actions">
                    <button
                      type="button"
                      className="filename-parts-btn"
                      disabled={i === 0}
                      aria-label="上へ"
                      onClick={() =>
                        setFilenameParts(movePart(filenameParts, i, -1))
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="filename-parts-btn"
                      disabled={i === filenameParts.length - 1}
                      aria-label="下へ"
                      onClick={() =>
                        setFilenameParts(movePart(filenameParts, i, 1))
                      }
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="filename-parts-btn"
                      disabled={part === "index"}
                      aria-label="外す"
                      title={
                        part === "index"
                          ? "番号は名前衝突防止のため必須です"
                          : "ファイル名から外す"
                      }
                      onClick={() =>
                        setFilenameParts(
                          filenameParts.filter((p) => p !== part),
                        )
                      }
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {unusedParts.length > 0 ? (
              <div className="filename-parts-unused row">
                <span className="hint" style={{ margin: 0 }}>
                  追加:
                </span>
                {unusedParts.map((part) => (
                  <button
                    key={part}
                    type="button"
                    className="chip"
                    onClick={() =>
                      setFilenameParts([...filenameParts, part])
                    }
                  >
                    + {EXPORT_FILENAME_PART_LABELS[part]}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="hint filename-parts-preview">
              例: <code>{filenamePreview}</code>
            </p>
            <p className="hint">
              要素の順番を並べ替えできます。使わない要素は外して構いませんが、番号だけは必須です。
            </p>
          </div>

          <label>
            文字起こし検証の CER 警告閾値（0–1）
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={draft.asrCerWarnThreshold ?? 0.15}
              onChange={(e) =>
                setShared(
                  "asrCerWarnThreshold",
                  Math.min(1, Math.max(0, Number(e.target.value) || 0)),
                )
              }
            />
          </label>
          <p className="hint">
            この値以上の CER で「ずれあり」警告を表示します（既定 0.15）。
          </p>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || !pathsDirty}
              onClick={() => void save()}
            >
              保存
            </button>
            <span className="status-text">{msg}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
