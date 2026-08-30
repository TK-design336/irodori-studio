import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BoundedSelect } from "./BoundedSelect";
import type {
  AppSettings,
  ExportFilenamePart,
  HttpServerStatus,
  InferredPaths,
  IrodoriVersion,
  PathValidation,
  SliceReviewAspectId,
  SliceReviewSettings,
  VersionPathSettings,
  VocalSeparatorModelInfo,
} from "../types";
import {
  activePaths,
  DEFAULT_SLICE_REVIEW,
  DEFAULT_SLICE_AUTO_FIX,
  DEFAULT_VOCAL_SEPARATOR_MODEL,
  sliceReviewSettings,
  generateCompactLinesOf,
} from "../types";
import {
  DEFAULT_EXPORT_FILENAME_PARTS,
  EXPORT_FILENAME_PART_LABELS,
  EXPORT_FILENAME_PARTS,
  normalizeExportFilenameParts,
  previewExportFileName,
} from "../lib/exportFileName";
import {
  DEFAULT_MP3_BITRATE_KBPS,
  DEFAULT_OPUS_BITRATE_KBPS,
  EXPORT_AUDIO_FORMAT_LABELS,
  EXPORT_AUDIO_FORMATS,
  MP3_BITRATE_OPTIONS,
  OPUS_BITRATE_OPTIONS,
  exportAudioExt,
  normalizeExportAudioFormat,
  normalizeMp3BitrateKbps,
  normalizeOpusBitrateKbps,
} from "../lib/exportAudio";
import {
  DARK_ACCENTS,
  DEFAULT_ACCENT_DARK,
  DEFAULT_ACCENT_LIGHT,
  LIGHT_ACCENTS,
  applyAppearance,
  darkAccentOf,
  lightAccentOf,
  normalizeAccentDark,
  normalizeAccentLight,
  type AccentPalette,
} from "../lib/accent";

type Props = {
  settings: AppSettings;
  validation: PathValidation | null;
  onSaved: (s: AppSettings) => void;
  onValidate: () => void;
  firstSetup?: boolean;
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

function AccentSwatchRow({
  palettes,
  selectedId,
  defaultId,
  groupLabel,
  disabled,
  onSelect,
}: {
  palettes: AccentPalette[];
  selectedId: string;
  defaultId: string;
  groupLabel: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="accent-swatches" role="radiogroup" aria-label={groupLabel}>
      {palettes.map((p) => {
        const selected = selectedId === p.id;
        const name = p.id === defaultId ? `${p.label}（既定）` : p.label;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={name}
            className={`accent-swatch${selected ? " is-selected" : ""}`}
            style={{ "--swatch": p.accent } as CSSProperties}
            title={name}
            disabled={disabled}
            onClick={() => onSelect(p.id)}
          />
        );
      })}
    </div>
  );
}

export function SettingsView({
  settings,
  validation,
  onSaved,
  onValidate,
  firstSetup = false,
}: Props) {
  const [draft, setDraft] = useState(settings);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolvedPython, setResolvedPython] = useState<string | null>(null);
  const [engineCollapsed, setEngineCollapsed] = useState(false);
  const [pathsCollapsed, setPathsCollapsed] = useState(false);
  const [playbackCollapsed, setPlaybackCollapsed] = useState(false);
  const [uiCollapsed, setUiCollapsed] = useState(false);
  const [httpCollapsed, setHttpCollapsed] = useState(false);
  const [vocalModels, setVocalModels] = useState<VocalSeparatorModelInfo[]>([]);
  const [httpStatus, setHttpStatus] = useState<HttpServerStatus | null>(null);
  const [corsDraft, setCorsDraft] = useState("");
  const [tokenCopied, setTokenCopied] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void invoke<HttpServerStatus>("http_server_status")
        .then((s) => {
          if (!cancelled) setHttpStatus(s);
        })
        .catch(() => {
          if (!cancelled) setHttpStatus(null);
        });
    };
    refresh();
    const id = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [settings.httpServerEnabled, settings.httpBindAddress, settings.httpPort]);

  useEffect(() => {
    let cancelled = false;
    void invoke<VocalSeparatorModelInfo[]>("list_vocal_separator_models")
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length > 0) {
          setVocalModels(list);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVocalModels([
            {
              arch: "MDXC",
              name: "BS-Roformer（推奨・既定）",
              filename: DEFAULT_VOCAL_SEPARATOR_MODEL,
            },
          ]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    invoke<string | null>("resolve_python_path")
      .then(setResolvedPython)
      .catch(() => setResolvedPython(null));
  }, [settings, validation, draft.irodoriVersion]);

  useEffect(() => {
    applyAppearance(draft.theme, draft.accentLight, draft.accentDark);
    return () => {
      applyAppearance(settings.theme, settings.accentLight, settings.accentDark);
    };
  }, [
    draft.theme,
    draft.accentLight,
    draft.accentDark,
    settings.theme,
    settings.accentLight,
    settings.accentDark,
  ]);

  useEffect(() => {
    if (!firstSetup) return;
    const ver = normalizeVersion(settings.irodoriVersion);
    const root = (
      ver === "v4" ? settings.pathsV4 : settings.pathsV3
    ).irodoriRoot.trim();
    if (!root) return;
    let cancelled = false;
    void invoke<InferredPaths>("infer_engine_paths", { root, version: ver })
      .then((inferred) => {
        if (cancelled) return;
        setDraft((d) => {
          const next: VersionPathSettings = {
            irodoriRoot: inferred.irodoriRoot,
            outputsRoot: inferred.outputsRoot,
            pythonExe: inferred.pythonExe,
            checkpointPath: inferred.checkpointPath,
          };
          return ver === "v4" ? { ...d, pathsV4: next } : { ...d, pathsV3: next };
        });
      })
      .catch((e) => {
        if (!cancelled) setMsg(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [firstSetup]);

  const version = normalizeVersion(draft.irodoriVersion);
  const editingPaths = version === "v4" ? draft.pathsV4 : draft.pathsV3;
  const settingsDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );
  const engineDirty = useMemo(
    () =>
      JSON.stringify({
        irodoriVersion: draft.irodoriVersion,
        pathsV3: draft.pathsV3,
        pathsV4: draft.pathsV4,
        modelPrecision: draft.modelPrecision,
        codecPrecision: draft.codecPrecision,
        modelDevice: draft.modelDevice,
        codecDevice: draft.codecDevice,
        projectsRoot: draft.projectsRoot,
      }) !==
      JSON.stringify({
        irodoriVersion: settings.irodoriVersion,
        pathsV3: settings.pathsV3,
        pathsV4: settings.pathsV4,
        modelPrecision: settings.modelPrecision,
        codecPrecision: settings.codecPrecision,
        modelDevice: settings.modelDevice,
        codecDevice: settings.codecDevice,
        projectsRoot: settings.projectsRoot,
      }),
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
    () =>
      previewExportFileName(
        filenameParts,
        draft.utteranceMaxChars,
        exportAudioExt(normalizeExportAudioFormat(draft.exportAudioFormat)),
      ),
    [filenameParts, draft.utteranceMaxChars, draft.exportAudioFormat],
  );
  const filenamePreviewMulti = useMemo(
    () =>
      previewExportFileName(
        filenameParts,
        draft.utteranceMaxChars,
        exportAudioExt(normalizeExportAudioFormat(draft.exportAudioFormat)),
        { variantIndex: 1, variantCount: 2 },
      ),
    [filenameParts, draft.utteranceMaxChars, draft.exportAudioFormat],
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
          exportAudioFormat: normalizeExportAudioFormat(next.exportAudioFormat),
          exportMp3BitrateKbps: normalizeMp3BitrateKbps(next.exportMp3BitrateKbps),
          exportOpusBitrateKbps: normalizeOpusBitrateKbps(
            next.exportOpusBitrateKbps,
          ),
          accentLight: normalizeAccentLight(next.accentLight),
          accentDark: normalizeAccentDark(next.accentDark),
          generateCompactLines: generateCompactLinesOf(next),
        },
      });
      // Keep the flag even if an older backend omits it from the round-trip.
      const merged: AppSettings = {
        ...saved,
        generateCompactLines: generateCompactLinesOf(next),
      };
      setDraft(merged);
      onSaved(merged);
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
    if (firstSetup) {
      const root = (
        next === "v4" ? merged.pathsV4 : merged.pathsV3
      ).irodoriRoot.trim();
      if (root) void inferFromRoot(root, next);
      return;
    }
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

  const applyInferred = (
    inferred: InferredPaths,
    ver: IrodoriVersion = version,
  ) => {
    setDraft((d) => {
      const next: VersionPathSettings = {
        irodoriRoot: inferred.irodoriRoot,
        outputsRoot: inferred.outputsRoot,
        pythonExe: inferred.pythonExe,
        checkpointPath: inferred.checkpointPath,
      };
      if (ver === "v4") {
        return { ...d, pathsV4: next };
      }
      return { ...d, pathsV3: next };
    });
    const notes: string[] = [];
    if (!inferred.pythonFound) notes.push("Python が見つかりませんでした（手修正可）");
    if (!inferred.checkpointFound) notes.push("Checkpoint が見つかりませんでした（手修正可）");
    setMsg(notes.length ? notes.join(" / ") : "ルートからパスを推定しました");
  };

  const inferFromRoot = async (
    root: string,
    ver: IrodoriVersion = version,
  ) => {
    const trimmed = root.trim();
    if (!trimmed) return;
    try {
      const inferred = await invoke<InferredPaths>("infer_engine_paths", {
        root: trimmed,
        version: ver,
      });
      applyInferred(inferred, ver);
    } catch (e) {
      setPath("irodoriRoot", trimmed);
      setMsg(String(e));
    }
  };

  const pickDir = async (key: PathKey) => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    if (key === "irodoriRoot") {
      await inferFromRoot(selected);
      return;
    }
    setPath(key, selected);
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
      <section className={`panel${engineCollapsed ? " collapsed" : ""}`}>
        <header
          className="panel-header"
          onClick={() => setEngineCollapsed((v) => !v)}
        >
          <h3>エンジン版</h3>
          <span className="chevron">{engineCollapsed ? "▸" : "▾"}</span>
        </header>
        {!engineCollapsed && (
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
          <label>
            ボーカル分離モデル（学習前処理）
            <span className="hint">
              学習向けに絞った Vocals 用 Roformer（torch）のみ。ONNX / Instrumental
              専用 / Karaoke・Denoise などは出していません（環境依存や用途が違うため）。
              既定は BS-Roformer。
            </span>
            <BoundedSelect
              value={
                draft.vocalSeparatorModel || DEFAULT_VOCAL_SEPARATOR_MODEL
              }
              options={(vocalModels.length > 0
                ? vocalModels
                : [
                    {
                      arch: "MDXC",
                      name: "BS-Roformer（推奨・既定）",
                      filename: DEFAULT_VOCAL_SEPARATOR_MODEL,
                    },
                  ]
              ).map((m) => ({
                value: m.filename,
                label: m.name || m.filename,
              }))}
              disabled={busy}
              onChange={(v) => setShared("vocalSeparatorModel", v)}
            />
          </label>
          {engineDirty && (
            <p className="hint warn-text">
              パス等に未保存の変更があります。学習前に「保存」してください。
            </p>
          )}
        </div>
        )}
      </section>

      <section className={`panel${pathsCollapsed ? " collapsed" : ""}`}>
        <header
          className="panel-header"
          onClick={() => setPathsCollapsed((v) => !v)}
        >
          <h3>パス設定（{version.toUpperCase()}）</h3>
          <span className="chevron">{pathsCollapsed ? "▸" : "▾"}</span>
        </header>
        {!pathsCollapsed && (
        <div className="panel-body form-stack">
          {firstSetup && (
            <p className="hint warn-text">
              まず Irodori-TTS のインストールフォルダを指定してください。Outputs・Python・Checkpoint はそこから自動で探します。
            </p>
          )}
          {PATH_FIELDS.map(([key, label, isDir]) => (
            <label key={`${version}-${key}`}>
              {label}
              {key === "irodoriRoot" ? (
                <span className="hint">
                  Irodori-TTS 本体のフォルダです。選ぶと他のパスを自動推定します。
                </span>
              ) : null}
              {key === "checkpointPath" ? (
                <span className="hint">
                  Hugging Face キャッシュ（.cache/huggingface/hub/models--Aratako--…/snapshots/リビジョン/model.safetensors）を優先します。v4 は v4.1 を先に探します。
                </span>
              ) : null}
              <div className="row">
                <input
                  value={editingPaths[key]}
                  onChange={(e) => setPath(key, e.target.value)}
                  onBlur={(e) => {
                    if (key === "irodoriRoot") void inferFromRoot(e.currentTarget.value);
                  }}
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
              disabled={busy || !settingsDirty}
              onClick={() => void save()}
            >
              保存
            </button>
            <button
              type="button"
              disabled={busy || !editingPaths.irodoriRoot.trim()}
              onClick={() => void inferFromRoot(editingPaths.irodoriRoot)}
            >
              ルートから再推定
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
                label={`ffmpeg（同梱${validation.ffmpegPath ? ` ${validation.ffmpegPath}` : ""}）`}
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
            ffmpeg はアプリに同梱しています。外部インストールは不要です。
          </p>
          <p className="hint">
            アクティブ: {activePaths(draft).irodoriRoot}
          </p>
        </div>
        )}
      </section>

      <section className={`panel${uiCollapsed ? " collapsed" : ""}`}>
        <header
          className="panel-header"
          onClick={() => setUiCollapsed((v) => !v)}
        >
          <h3>UI</h3>
          <span className="chevron">{uiCollapsed ? "▸" : "▾"}</span>
        </header>
        {!uiCollapsed && (
        <div className="panel-body form-stack">
          <p className="hint">
            ライト／ダークそれぞれの差し色です。いまのモードに選んだ色はすぐ画面に反映されます。保存で確定します。
          </p>
          <div className="accent-field">
            <div className="accent-field-head">
              <span className="accent-field-label">ライトモードの差し色</span>
              {draft.theme !== "dark" ? (
                <span className="pill">表示中</span>
              ) : null}
            </div>
            <AccentSwatchRow
              palettes={LIGHT_ACCENTS}
              selectedId={normalizeAccentLight(draft.accentLight)}
              defaultId={DEFAULT_ACCENT_LIGHT}
              groupLabel="ライトモードの差し色"
              disabled={busy}
              onSelect={(id) => setShared("accentLight", id)}
            />
            <p className="hint">
              選択中: {lightAccentOf(draft.accentLight).label}
              {normalizeAccentLight(draft.accentLight) === DEFAULT_ACCENT_LIGHT
                ? "（既定）"
                : ""}
            </p>
          </div>
          <div className="accent-field">
            <div className="accent-field-head">
              <span className="accent-field-label">ダークモードの差し色</span>
              {draft.theme === "dark" ? (
                <span className="pill">表示中</span>
              ) : null}
            </div>
            <AccentSwatchRow
              palettes={DARK_ACCENTS}
              selectedId={normalizeAccentDark(draft.accentDark)}
              defaultId={DEFAULT_ACCENT_DARK}
              groupLabel="ダークモードの差し色"
              disabled={busy}
              onSelect={(id) => setShared("accentDark", id)}
            />
            <p className="hint">
              選択中: {darkAccentOf(draft.accentDark).label}
              {normalizeAccentDark(draft.accentDark) === DEFAULT_ACCENT_DARK
                ? "（既定）"
                : ""}
            </p>
          </div>
          <label>
            <input
              type="checkbox"
              checked={generateCompactLinesOf(draft)}
              disabled={busy}
              onChange={(e) => {
                const checked = e.target.checked;
                const next = { ...draft, generateCompactLines: checked };
                setDraft(next);
                void persist(
                  next,
                  checked
                    ? "コンパクト表示をオンにしました"
                    : "コンパクト表示をオフにしました",
                );
              }}
            />
            生成のコンパクト表示
          </label>
          <p className="hint">
            切り替えた時点で保存されます（既定はオン）。非選択の行を番号・本文・話者の1行にまとめます。選択中の行は従来どおりで、ホバーすると
            保持件数や操作ボタンなどが話者の右から現れます。
          </p>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || !settingsDirty}
              onClick={() => void save()}
            >
              保存
            </button>
            <span className="status-text">{msg}</span>
          </div>
        </div>
        )}
      </section>

      <section className={`panel${playbackCollapsed ? " collapsed" : ""}`}>
        <header
          className="panel-header"
          onClick={() => setPlaybackCollapsed((v) => !v)}
        >
          <h3>再生・保存</h3>
          <span className="chevron">{playbackCollapsed ? "▸" : "▾"}</span>
        </header>
        {!playbackCollapsed && (
        <div className="panel-body form-stack">
          <label>
            チャンク間無音（ms）
            <span className="hint">
              一括再生の行間無音、および一括保存（連結）モーダルの初期値に使います。
            </span>
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
          <label>
            出力形式（既定）
            <span className="hint">
              行の個別保存と一括保存の初期形式です。保存時にも WAV / MP3 / Opus を選べます。
            </span>
            <BoundedSelect
              value={normalizeExportAudioFormat(draft.exportAudioFormat)}
              options={EXPORT_AUDIO_FORMATS.map((f) => ({
                value: f,
                label: EXPORT_AUDIO_FORMAT_LABELS[f],
              }))}
              onChange={(v) =>
                setShared(
                  "exportAudioFormat",
                  normalizeExportAudioFormat(v),
                )
              }
              aria-label="出力形式"
            />
          </label>
          <div className="blend-row">
            <label>
              MP3 ビットレート
              <span className="hint">
                MP3 で保存するときのビットレートです。WAV は非圧縮のため対象外です。
              </span>
              <BoundedSelect
                value={String(
                  normalizeMp3BitrateKbps(draft.exportMp3BitrateKbps),
                )}
                options={MP3_BITRATE_OPTIONS.map((b) => ({
                  value: String(b),
                  label: `${b} kbps`,
                }))}
                onChange={(v) =>
                  setShared("exportMp3BitrateKbps", Number(v) || DEFAULT_MP3_BITRATE_KBPS)
                }
                aria-label="MP3 ビットレート"
              />
            </label>
            <label>
              Opus ビットレート
              <span className="hint">
                Opus で保存するときのビットレートです。WAV は非圧縮のため対象外です。
              </span>
              <BoundedSelect
                value={String(
                  normalizeOpusBitrateKbps(draft.exportOpusBitrateKbps),
                )}
                options={OPUS_BITRATE_OPTIONS.map((b) => ({
                  value: String(b),
                  label: `${b} kbps`,
                }))}
                onChange={(v) =>
                  setShared(
                    "exportOpusBitrateKbps",
                    Number(v) || DEFAULT_OPUS_BITRATE_KBPS,
                  )
                }
                aria-label="Opus ビットレート"
              />
            </label>
          </div>
          <label>
            セリフ文字数上限（ファイル名）
            <span className="hint">
              個別エクスポート時のファイル名に含めるセリフ文字数の上限です。
            </span>
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

          <div className="filename-parts-field">
            <span className="filename-parts-label">自動ファイル名の並び</span>
            <p className="hint">
              要素の順番を並べ替えできます。使わない要素は外して構いませんが、番号だけは必須です。1行に複数の音声があるときは 001-1, 001-2 のように枝番が付きます。
            </p>
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
              <br />
              複数本の行: <code>{filenamePreviewMulti}</code>
            </p>
          </div>

          <label>
            文字起こし検証の CER 警告閾値（0–1）
            <span className="hint">
              この値以上の CER で「ずれあり」警告を表示します（既定 0.15）。
            </span>
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

          <SliceReviewSettingsEditor
            value={sliceReviewSettings(draft)}
            onChange={(next) =>
              setDraft((d) => ({ ...d, sliceReview: next }))
            }
          />

          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || !settingsDirty}
              onClick={() => void save()}
            >
              保存
            </button>
            <span className="status-text">{msg}</span>
          </div>
        </div>
        )}
      </section>

      <section className={`panel${httpCollapsed ? " collapsed" : ""}`}>
        <header
          className="panel-header"
          onClick={() => setHttpCollapsed((v) => !v)}
        >
          <h3>ローカル HTTP サーバー</h3>
          <span className="chevron">{httpCollapsed ? "▸" : "▾"}</span>
        </header>
        {!httpCollapsed && (
          <div className="panel-body form-stack">
            <p className="hint">
              Chrome 拡張や外部ツールから音声合成を呼び出す API です。既定では
              127.0.0.1 のみで待ち受けます。すべてのリクエストにトークンが必要です。
            </p>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.httpServerEnabled !== false}
                onChange={(e) =>
                  setShared("httpServerEnabled", e.target.checked)
                }
              />
              HTTP サーバーを有効にする
            </label>
            <div className="blend-row">
              <label>
                バインドアドレス
                <span className="hint">
                  将来のリモート対応のため設定項目です。今は 127.0.0.1 のまま推奨します。
                </span>
                <input
                  type="text"
                  value={draft.httpBindAddress ?? "127.0.0.1"}
                  onChange={(e) => setShared("httpBindAddress", e.target.value)}
                  placeholder="127.0.0.1"
                />
              </label>
              <label>
                ポート（希望）
                <span className="hint">
                  使用中なら次の空きポートを試します（最大 20）。
                </span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.httpPort ?? 18790}
                  onChange={(e) =>
                    setShared(
                      "httpPort",
                      Math.min(
                        65535,
                        Math.max(1, Math.floor(Number(e.target.value) || 18790)),
                      ),
                    )
                  }
                />
              </label>
            </div>
            <div className="http-status-box">
              <strong>状態: </strong>
              {httpStatus?.running
                ? `起動中 — http://${httpStatus.bindAddress}:${httpStatus.port}`
                : "停止中"}
              {httpStatus?.running &&
                httpStatus.port != null &&
                httpStatus.port !== httpStatus.preferredPort && (
                  <span className="hint">
                    （希望ポート {httpStatus.preferredPort} は使用中だったため{" "}
                    {httpStatus.port} で起動）
                  </span>
                )}
            </div>
            <label>
              API トークン
              <span className="hint">
                Authorization: Bearer … として送信します。拡張の設定にコピーしてください。
              </span>
              <div className="row http-token-row">
                <input
                  type="text"
                  readOnly
                  value={draft.httpToken ?? ""}
                  className="http-token-input"
                />
                <button
                  type="button"
                  className="chip"
                  disabled={!draft.httpToken}
                  onClick={() => {
                    const t = draft.httpToken ?? "";
                    if (!t) return;
                    void navigator.clipboard.writeText(t).then(() => {
                      setTokenCopied(true);
                      window.setTimeout(() => setTokenCopied(false), 1500);
                    });
                  }}
                >
                  {tokenCopied ? "コピー済み" : "コピー"}
                </button>
                <button
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      setBusy(true);
                      try {
                        const saved = await invoke<AppSettings>(
                          "regenerate_http_token",
                        );
                        setDraft(saved);
                        onSaved(saved);
                        setMsg("トークンを再生成しました");
                      } catch (e) {
                        setMsg(String(e));
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}
                >
                  再生成
                </button>
              </div>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.httpAllowChromeExtensions !== false}
                onChange={(e) =>
                  setShared("httpAllowChromeExtensions", e.target.checked)
                }
              />
              Chrome 拡張（chrome-extension://）からの CORS を許可
            </label>
            <div className="filename-parts-field">
              <span className="filename-parts-label">追加の CORS オリジン</span>
              <p className="hint">
                完全一致で許可するオリジンを追加できます（例: http://localhost:3000）。
              </p>
              <ul className="filename-parts-list">
                {(draft.httpCorsOrigins ?? []).map((origin) => (
                  <li key={origin} className="filename-parts-item">
                    <code>{origin}</code>
                    <button
                      type="button"
                      className="chip"
                      onClick={() =>
                        setShared(
                          "httpCorsOrigins",
                          (draft.httpCorsOrigins ?? []).filter(
                            (o) => o !== origin,
                          ),
                        )
                      }
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
              <div className="row">
                <input
                  type="text"
                  value={corsDraft}
                  placeholder="https://example.com"
                  onChange={(e) => setCorsDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    const o = corsDraft.trim();
                    if (!o) return;
                    const cur = draft.httpCorsOrigins ?? [];
                    if (cur.includes(o)) {
                      setCorsDraft("");
                      return;
                    }
                    setShared("httpCorsOrigins", [...cur, o]);
                    setCorsDraft("");
                  }}
                >
                  追加
                </button>
              </div>
            </div>
            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={busy || !settingsDirty}
                onClick={() => void save()}
              >
                保存
              </button>
              <span className="status-text">{msg}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

const ASPECT_META: Array<[SliceReviewAspectId, string]> = [
  ["A", "長さ"],
  ["B", "発話速度（台本があるとき）"],
  ["C", "無音比率"],
  ["D", "音量"],
  ["F", "話者一貫（MFCC）"],
  ["G", "スペクトル"],
  ["H", "非音声"],
  ["I", "こもり / 響き"],
];

function SliceReviewSettingsEditor({
  value,
  onChange,
}: {
  value: SliceReviewSettings;
  onChange: (v: SliceReviewSettings) => void;
}) {
  const th = value.thresholds;
  const setTh = (key: keyof typeof th, n: number) => {
    onChange({
      ...value,
      thresholds: { ...th, [key]: n },
    });
  };
  return (
    <div className="form-stack" style={{ marginTop: "0.75rem" }}>
      <h4 style={{ margin: 0 }}>スライスレビュー</h4>
      <p className="hint">
        学習の slice 後・dataset 前の品質チェック。波形の統計だけで判定し、
        Whisper / ONNX は使いません。各観点はバッチ内の z スコアと IQR
        外れ値でフラグします。I はこもり（高域不足）に加え、妙に響く・残る音
        （共鳴・残響）も同じ観点で検知します。auto は観点ヒットに加え、
        総合スコア上位から指定％を切り、残件数上限まで落とします（0 は無効、上限 90%）。
        Auto Fix はレビューの前に、体育館・トンネルのような残響やこもりを
        非生成の信号処理（WPE / 後期残響抑制 / tilt EQ / 軽い NR）で整えます。
      </p>
      <div
        className={`train-review-block${value.mode === "auto" ? " is-review-auto" : ""}`}
      >
        <label>
          既定モード{value.mode === "auto" ? " · 自動除外" : ""}
          <select
            value={value.mode}
            onChange={(e) => {
              const m = e.target.value;
              onChange({
                ...value,
                mode:
                  m === "skip" || m === "auto" || m === "manual" ? m : "manual",
              });
            }}
          >
            <option value="manual">manual（人手確認・既定）</option>
            <option value="auto">auto（総合スコア＋観点で自動除外）</option>
            <option value="skip">skip（スキップ）</option>
          </select>
        </label>
        {value.mode === "auto" && (
          <span className="param-altered-hint">
            確認画面なしで外れ値スライスを自動除外して学習に進みます。
          </span>
        )}
        <div className="slice-review-settings-grid">
          <label>
            auto 除去率（総合スコア上位 %）
            <input
              type="number"
              min={0}
              max={90}
              step={1}
              value={value.autoRemovePercent ?? 0}
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange({
                  ...value,
                  autoRemovePercent: Number.isFinite(n)
                    ? Math.min(90, Math.max(0, Math.round(n)))
                    : 0,
                });
              }}
            />
          </label>
          <label>
            auto 残件数上限（0=無制限）
            <input
              type="number"
              min={0}
              step={1}
              value={value.autoKeepMax ?? 0}
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange({
                  ...value,
                  autoKeepMax: Number.isFinite(n)
                    ? Math.max(0, Math.floor(n))
                    : 0,
                });
              }}
            />
          </label>
        </div>
      </div>
      <div
        className={`train-vocal-block${
          value.autoFix?.enabled !== false ? " is-vocal-altered" : ""
        }`}
      >
        <label className="train-announce-check">
          <input
            type="checkbox"
            checked={value.autoFix?.enabled !== false}
            onChange={(e) =>
              onChange({
                ...value,
                autoFix: {
                  enabled: e.target.checked,
                  reverb: value.autoFix?.reverb !== false,
                  muffle: value.autoFix?.muffle !== false,
                  enhance: value.autoFix?.enhance !== false,
                },
              })
            }
          />
          スライス後 Auto Fix（残響・こもり・低音質）
          {value.autoFix?.enabled !== false ? " · 有効" : ""}
        </label>
        {value.autoFix?.enabled !== false && (
          <>
            <div className="slice-review-aspect-toggles">
              {(
                [
                  ["reverb", "残響（WPE＋後期残響）"],
                  ["muffle", "こもり（tilt / 箱鳴り EQ）"],
                  ["enhance", "低音質（ハイパス / NR / デクリップ）"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="train-announce-check">
                  <input
                    type="checkbox"
                    checked={value.autoFix?.[key] !== false}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        autoFix: {
                          enabled: value.autoFix?.enabled !== false,
                          reverb: value.autoFix?.reverb !== false,
                          muffle: value.autoFix?.muffle !== false,
                          enhance: value.autoFix?.enhance !== false,
                          [key]: e.target.checked,
                        },
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="hint" style={{ margin: 0 }}>
              バッチの中央値が体育館・ホール寄り（発話後の残響テールが長い）なら全スライスに残響処理をかけます。乾いたスタジオ録音はほぼ無処理です。ニューラル復元は使いません。
            </p>
          </>
        )}
      </div>
      <div className="slice-review-aspect-toggles">
        {ASPECT_META.map(([id, label]) => (
          <label key={id} className="train-announce-check">
            <input
              type="checkbox"
              checked={value.aspects[id] !== false}
              onChange={(e) =>
                onChange({
                  ...value,
                  aspects: { ...value.aspects, [id]: e.target.checked },
                })
              }
            />
            {id}: {label}
          </label>
        ))}
      </div>
      <div className="slice-review-settings-grid">
        <label>
          外れ値 |z|（C/D/F/H/I）
          <input
            type="number"
            step={0.1}
            value={th.outlierZ ?? DEFAULT_SLICE_REVIEW.thresholds.outlierZ}
            onChange={(e) => setTh("outlierZ", Number(e.target.value))}
          />
        </label>
        <label>
          A 長さ |z|
          <input
            type="number"
            step={0.1}
            value={th.durationZ ?? DEFAULT_SLICE_REVIEW.thresholds.durationZ}
            onChange={(e) => setTh("durationZ", Number(e.target.value))}
          />
        </label>
        <label>
          B 速度 |z|
          <input
            type="number"
            step={0.1}
            value={th.speedZ ?? DEFAULT_SLICE_REVIEW.thresholds.speedZ}
            onChange={(e) => setTh("speedZ", Number(e.target.value))}
          />
        </label>
        <label>
          G スペクトル |z|
          <input
            type="number"
            step={0.1}
            value={th.centroidZ ?? DEFAULT_SLICE_REVIEW.thresholds.centroidZ}
            onChange={(e) => setTh("centroidZ", Number(e.target.value))}
          />
        </label>
        <label>
          IQR 倍率
          <input
            type="number"
            step={0.1}
            value={
              th.durationIqrMult ?? DEFAULT_SLICE_REVIEW.thresholds.durationIqrMult
            }
            onChange={(e) => setTh("durationIqrMult", Number(e.target.value))}
          />
        </label>
      </div>
      <button
        type="button"
        className="chip"
        onClick={() =>
          onChange({
            ...DEFAULT_SLICE_REVIEW,
            aspects: { ...DEFAULT_SLICE_REVIEW.aspects },
            thresholds: { ...DEFAULT_SLICE_REVIEW.thresholds },
            autoFix: { ...DEFAULT_SLICE_AUTO_FIX },
          })
        }
      >
        レビュー設定を既定に戻す
      </button>
    </div>
  );
}
