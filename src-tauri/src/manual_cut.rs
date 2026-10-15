//! Manual cut workspace: vocal separation + clip export for Train tab.
use crate::python_env;
use crate::settings::{
    apply_ffmpeg_env, resolve_ffmpeg, resolve_python_exe, studio_python_dir, AppSettings,
    MISSING_FFMPEG_MSG,
};
use crate::studio_data_cache_dir;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const VIDEO_EXTS: &[&str] = &[".mp4", ".mkv", ".webm", ".mov", ".m4v"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCutClip {
    pub start_sec: f64,
    pub end_sec: f64,
    pub speaker_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCutSeparateResult {
    pub play_path: String,
    pub vocals_path: String,
    pub is_video: bool,
}

fn is_video_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTS.iter().any(|x| e.eq_ignore_ascii_case(&x[1..])))
        .unwrap_or(false)
}

fn sanitize_fs_name(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    let base = if trimmed.is_empty() { fallback } else { trimmed };
    let mut out = String::new();
    for ch in base.chars() {
        if ch.is_alphanumeric() || matches!(ch, '-' | '_' | ' ' | '　') {
            out.push(if ch == '　' { '_' } else { ch });
        } else {
            out.push('_');
        }
    }
    let out = out.trim().trim_matches('.').to_string();
    if out.is_empty() {
        fallback.into()
    } else {
        out
    }
}

fn sanitize_speaker_dir(name: &str) -> String {
    sanitize_fs_name(name, "speaker")
}

fn sanitize_clip_stem(name: &str) -> String {
    sanitize_fs_name(name, "clip")
}

fn stem_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(sanitize_clip_stem)
        .unwrap_or_else(|| "clip".into())
}

fn run_cmd_capture(mut cmd: Command) -> Result<String, String> {
    python_env::hide_console(&mut cmd);
    let output = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("起動失敗: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!("{stderr}\n{stdout}").trim().to_string());
    }
    Ok(stdout)
}

fn parse_vocals_path(stdout: &str) -> Result<PathBuf, String> {
    for line in stdout.lines().rev() {
        let t = line.trim();
        if t.starts_with('{') && t.contains("vocalsPath") {
            let v: serde_json::Value =
                serde_json::from_str(t).map_err(|e| format!("vocals JSON: {e}"))?;
            if let Some(p) = v.get("vocalsPath").and_then(|x| x.as_str()) {
                return Ok(PathBuf::from(p));
            }
        }
    }
    Err("ボーカル分離の出力パスが得られませんでした".into())
}

pub fn separate_for_playback(
    settings: &AppSettings,
    source_path: &str,
) -> Result<ManualCutSeparateResult, String> {
    let src = PathBuf::from(source_path.trim());
    if !src.is_file() {
        return Err(format!("ファイルが見つかりません: {}", src.display()));
    }
    let python = resolve_python_exe(settings)
        .ok_or_else(|| format!("Python が見つかりません: {}", settings.python_exe()))?;
    python_env::ensure_audio_separator(&python)?;
    let py_dir = studio_python_dir()?;
    let work = studio_data_cache_dir().join("manual_cut");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out_dir = work.join(format!("sep_{stamp}"));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let model_dir = studio_data_cache_dir().join("audio-separator-models");
    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;
    let model = settings.vocal_separator_model.trim();
    let model = if model.is_empty() {
        crate::settings::DEFAULT_VOCAL_SEPARATOR_MODEL
    } else {
        model
    };

    let mut cmd = Command::new(&python);
    apply_ffmpeg_env(&mut cmd, settings);
    cmd.arg("-u")
        .arg(py_dir.join("vocal_separator.py"))
        .arg("--input")
        .arg(&src)
        .arg("--output-dir")
        .arg(&out_dir)
        .arg("--model-name")
        .arg(model)
        .arg("--model-file-dir")
        .arg(&model_dir)
        .current_dir(settings.irodori_root())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1");
    let stdout = run_cmd_capture(cmd)?;
    let vocals = parse_vocals_path(&stdout)?;
    if !vocals.is_file() {
        return Err(format!("Vocals がありません: {}", vocals.display()));
    }

    let video = is_video_path(&src);
    // 動画はフロントで元映像をミュートし、分離WAVを同期再生する。
    // 再融合MP4を介さないため、元音声の混入や再mux時の時刻ずれを避けられる。
    let play_path = if video { src } else { vocals.clone() };

    Ok(ManualCutSeparateResult {
        play_path: play_path.display().to_string(),
        vocals_path: vocals.display().to_string(),
        is_video: video,
    })
}

/// Replace each WAV in place with its Vocals stem.
/// Short clips are silence-padded inside `vocal_separator.py`, then trimmed back.
pub fn replace_with_vocals(settings: &AppSettings, paths: &[String]) -> Result<u32, String> {
    let mut unique: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        if path.as_os_str().is_empty() {
            continue;
        }
        if !path.is_file() {
            return Err(format!("ファイルが見つかりません: {}", path.display()));
        }
        let key = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .to_lowercase();
        if seen.insert(key) {
            unique.push(path);
        }
    }
    if unique.is_empty() {
        return Err("分離する音声ファイルがありません".into());
    }

    let python = resolve_python_exe(settings)
        .ok_or_else(|| format!("Python が見つかりません: {}", settings.python_exe()))?;
    python_env::ensure_audio_separator(&python)?;
    let py_dir = studio_python_dir()?;
    let model_dir = studio_data_cache_dir().join("audio-separator-models");
    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;
    let model = settings.vocal_separator_model.trim();
    let model = if model.is_empty() {
        crate::settings::DEFAULT_VOCAL_SEPARATOR_MODEL
    } else {
        model
    };

    let mut cmd = Command::new(&python);
    apply_ffmpeg_env(&mut cmd, settings);
    cmd.arg("-u")
        .arg(py_dir.join("vocal_separator.py"))
        .arg("--model-name")
        .arg(model)
        .arg("--model-file-dir")
        .arg(&model_dir)
        .arg("--replace");
    for path in &unique {
        cmd.arg(path);
    }
    cmd.current_dir(settings.irodori_root())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1");
    let _stdout = run_cmd_capture(cmd)?;
    Ok(unique.len() as u32)
}

pub fn export_clips(
    settings: &AppSettings,
    source_path: &str,
    dest_dir: &str,
    clips: &[ManualCutClip],
    name_stem: Option<&str>,
) -> Result<u64, String> {
    let src = PathBuf::from(source_path.trim());
    if !src.is_file() {
        return Err(format!("再生ソースが見つかりません: {}", src.display()));
    }
    let dest_root = PathBuf::from(dest_dir.trim());
    if dest_root.as_os_str().is_empty() {
        return Err("保存先フォルダを指定してください".into());
    }
    std::fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;
    let ffmpeg = resolve_ffmpeg(settings).ok_or_else(|| MISSING_FFMPEG_MSG.to_string())?;
    let clip_stem = name_stem
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(sanitize_clip_stem)
        .unwrap_or_else(|| stem_from_path(&src));

    let mut counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut written: u64 = 0;
    for clip in clips {
        let start = clip.start_sec.max(0.0);
        let end = clip.end_sec.max(0.0);
        if end <= start + 0.02 {
            continue;
        }
        let folder = sanitize_speaker_dir(&clip.speaker_name);
        let speaker_dir = dest_root.join(&folder);
        std::fs::create_dir_all(&speaker_dir).map_err(|e| e.to_string())?;
        let n = counts.entry(folder.clone()).or_insert(0);
        *n += 1;
        let dest = speaker_dir.join(format!("{clip_stem}_{:03}.wav", *n));
        let mut cmd = Command::new(&ffmpeg);
        apply_ffmpeg_env(&mut cmd, settings);
        python_env::hide_console(&mut cmd);
        // -ss/-to after -i for accuracy on video+audio remux sources
        cmd.args([
            "-y",
            "-i",
            &src.display().to_string(),
            "-ss",
            &format!("{start:.6}"),
            "-to",
            &format!("{end:.6}"),
            "-vn",
            "-ar",
            "44100",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            &dest.display().to_string(),
        ]);
        let status = cmd.status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!(
                "クリップ書き出し失敗 ({} {:.2}-{:.2}): {status}",
                clip.speaker_name, start, end
            ));
        }
        written += 1;
    }
    Ok(written)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCutWorkspaceSpeaker {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCutWorkspaceClip {
    pub id: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub speaker_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCutWorkspace {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub source_path: String,
    #[serde(default)]
    pub vocals_rel: Option<String>,
    #[serde(default)]
    pub separated_video: bool,
    pub speakers: Vec<ManualCutWorkspaceSpeaker>,
    pub active_speaker_id: String,
    pub clips: Vec<ManualCutWorkspaceClip>,
    #[serde(default = "default_rate")]
    pub playback_rate: f64,
    #[serde(default)]
    pub current_time_sec: f64,
    #[serde(default)]
    pub zoom_origin_sec: f64,
    #[serde(default)]
    pub selected_clip_id: Option<String>,
    #[serde(default)]
    pub mark_in_sec: Option<f64>,
}

fn default_rate() -> f64 {
    1.0
}

fn default_schema_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCutWorkspaceLoadResult {
    pub workspace: ManualCutWorkspace,
    pub vocals_path: Option<String>,
}

fn assets_dir_for(json_path: &Path) -> PathBuf {
    let stem = json_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("manual_cut");
    json_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}.assets"))
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn paths_same_file(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// Save workspace JSON and copy vocals into `<jsonStem>.assets/vocals.wav` when present.
pub fn save_workspace(
    path: &str,
    mut workspace: ManualCutWorkspace,
    vocals_src: Option<String>,
) -> Result<(), String> {
    let dest = PathBuf::from(path.trim());
    if dest.as_os_str().is_empty() {
        return Err("保存先を指定してください".into());
    }
    workspace.schema_version = 1;
    if let Some(src) = vocals_src
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let src_path = PathBuf::from(src);
        if !src_path.is_file() {
            return Err(format!("分離音声が見つかりません: {}", src_path.display()));
        }
        let assets = assets_dir_for(&dest);
        std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
        let vocals_dest = assets.join("vocals.wav");
        // 再保存時は既に assets 内の同一ファイルを指すことがある。自己コピーは Windows でロックエラーになる。
        let same_file = paths_same_file(&src_path, &vocals_dest);
        if !same_file {
            std::fs::copy(&src_path, &vocals_dest).map_err(|e| {
                format!(
                    "分離音声のコピーに失敗: {} → {}: {e}",
                    src_path.display(),
                    vocals_dest.display()
                )
            })?;
        }
        workspace.vocals_rel = Some("vocals.wav".into());
    } else {
        workspace.vocals_rel = None;
    }
    let text = serde_json::to_string_pretty(&workspace).map_err(|e| e.to_string())?;
    write_atomic(&dest, &text)
}

/// Load workspace JSON and resolve vocals absolute path if the asset exists.
pub fn load_workspace(path: &str) -> Result<ManualCutWorkspaceLoadResult, String> {
    let src = PathBuf::from(path.trim());
    if !src.is_file() {
        return Err(format!("作業ファイルが見つかりません: {}", src.display()));
    }
    let text = std::fs::read_to_string(&src).map_err(|e| e.to_string())?;
    let workspace: ManualCutWorkspace =
        serde_json::from_str(&text).map_err(|e| format!("作業ファイルの解析に失敗: {e}"))?;
    if workspace.schema_version > 1 {
        return Err(format!(
            "未対応の作業ファイル形式です (schemaVersion={})",
            workspace.schema_version
        ));
    }
    let vocals_path = workspace
        .vocals_rel
        .as_ref()
        .map(|rel| {
            let assets = assets_dir_for(&src);
            let candidate = assets.join(rel);
            if candidate.is_file() {
                Some(candidate.display().to_string())
            } else {
                None
            }
        })
        .flatten();
    Ok(ManualCutWorkspaceLoadResult {
        workspace,
        vocals_path,
    })
}
