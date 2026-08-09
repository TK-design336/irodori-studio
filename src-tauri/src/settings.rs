use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tauri::path::BaseDirectory;

/// Resolved once at app startup (Tauri `$RESOURCE/python`).
static STUDIO_PYTHON_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Per-engine path bundle (v3 and v4 keep separate roots / checkpoints / embeddings).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VersionPathSettings {
    pub irodori_root: String,
    pub checkpoint_path: String,
    pub outputs_root: String,
    pub python_exe: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// `"v3"` | `"v4"` — selects which path profile is active.
    #[serde(default = "default_irodori_version")]
    pub irodori_version: String,
    #[serde(default = "default_paths_v3")]
    pub paths_v3: VersionPathSettings,
    #[serde(default = "default_paths_v4")]
    pub paths_v4: VersionPathSettings,
    pub model_precision: String,
    pub codec_precision: String,
    pub model_device: String,
    pub codec_device: String,
    pub projects_root: String,
    /// Absolute path to `ffmpeg` / `ffmpeg.exe`. Empty → resolve from PATH.
    #[serde(default)]
    pub ffmpeg_path: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Silence between chunks on batch play / default for concat export (ms).
    #[serde(default = "default_chunk_silence_ms")]
    pub chunk_silence_ms: u32,
    /// Max utterance chars used in export filenames.
    #[serde(default = "default_utterance_max_chars")]
    pub utterance_max_chars: u32,
    /// Ordered tokens for individual export filenames (`project`/`index`/`speaker`/`utterance`).
    /// Always includes `index`; other parts optional.
    #[serde(default = "default_export_filename_parts")]
    pub export_filename_parts: Vec<String>,
    /// CER above this → ASR warning badge (0–1).
    #[serde(default = "default_asr_cer_warn_threshold")]
    pub asr_cer_warn_threshold: f64,
}

fn default_theme() -> String {
    "light".into()
}

fn default_chunk_silence_ms() -> u32 {
    300
}

fn default_utterance_max_chars() -> u32 {
    20
}

fn default_export_filename_parts() -> Vec<String> {
    vec![
        "project".into(),
        "index".into(),
        "speaker".into(),
        "utterance".into(),
    ]
}

pub fn normalize_export_filename_parts(parts: Vec<String>) -> Vec<String> {
    const ALLOWED: &[&str] = &["project", "index", "speaker", "utterance"];
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for p in parts {
        if !ALLOWED.contains(&p.as_str()) || !seen.insert(p.clone()) {
            continue;
        }
        out.push(p);
    }
    if !seen.contains("index") {
        let project_idx = out.iter().position(|p| p == "project");
        if let Some(i) = project_idx {
            out.insert(i + 1, "index".into());
        } else {
            out.insert(0, "index".into());
        }
    }
    if out.is_empty() {
        return default_export_filename_parts();
    }
    out
}

fn default_asr_cer_warn_threshold() -> f64 {
    0.15
}

fn default_irodori_version() -> String {
    "v3".into()
}

fn default_engine_root(folder: &str) -> PathBuf {
    dirs::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(folder)
}

fn default_paths_v3() -> VersionPathSettings {
    let root = default_engine_root("IrodoriTTS");
    VersionPathSettings {
        irodori_root: root.display().to_string(),
        checkpoint_path: root
            .join("checkpoints")
            .join("Aratako_Irodori-TTS-500M-v3")
            .join("model.safetensors")
            .display()
            .to_string(),
        outputs_root: root.join("outputs").display().to_string(),
        python_exe: root
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
            .display()
            .to_string(),
    }
}

fn find_hf_v4_checkpoint() -> Option<PathBuf> {
    let hub = dirs::home_dir()?.join(".cache").join("huggingface").join("hub");
    let model_dir = hub.join("models--Aratako--Irodori-TTS-v4-Small").join("snapshots");
    if !model_dir.is_dir() {
        return None;
    }
    let mut snapshots: Vec<_> = fs::read_dir(&model_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    snapshots.sort_by_key(|e| e.file_name());
    for snap in snapshots.into_iter().rev() {
        let ckpt = snap.path().join("model.safetensors");
        if ckpt.is_file() {
            return Some(ckpt);
        }
    }
    None
}

fn default_paths_v4() -> VersionPathSettings {
    let root = default_engine_root("IrodoriTTS-v4");
    let local_ckpt = root
        .join("checkpoints")
        .join("Aratako_Irodori-TTS-v4-Small")
        .join("model.safetensors");
    let checkpoint = if local_ckpt.is_file() {
        local_ckpt
    } else {
        find_hf_v4_checkpoint().unwrap_or(local_ckpt)
    };
    VersionPathSettings {
        irodori_root: root.display().to_string(),
        checkpoint_path: checkpoint.display().to_string(),
        outputs_root: root.join("outputs").display().to_string(),
        python_exe: root
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
            .display()
            .to_string(),
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            irodori_version: default_irodori_version(),
            paths_v3: default_paths_v3(),
            paths_v4: default_paths_v4(),
            model_precision: "fp32".into(),
            codec_precision: "fp32".into(),
            model_device: "cuda".into(),
            codec_device: "cuda".into(),
            projects_root: dirs::document_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("IrodoriStudio")
                .join("projects")
                .display()
                .to_string(),
            ffmpeg_path: String::new(),
            theme: default_theme(),
            chunk_silence_ms: default_chunk_silence_ms(),
            utterance_max_chars: default_utterance_max_chars(),
            export_filename_parts: default_export_filename_parts(),
            asr_cer_warn_threshold: default_asr_cer_warn_threshold(),
        }
    }
}

impl AppSettings {
    pub fn is_v4(&self) -> bool {
        self.irodori_version.eq_ignore_ascii_case("v4")
    }

    pub fn active_paths(&self) -> &VersionPathSettings {
        if self.is_v4() {
            &self.paths_v4
        } else {
            &self.paths_v3
        }
    }

    pub fn irodori_root(&self) -> &str {
        &self.active_paths().irodori_root
    }

    pub fn checkpoint_path(&self) -> &str {
        &self.active_paths().checkpoint_path
    }

    pub fn outputs_root(&self) -> &str {
        &self.active_paths().outputs_root
    }

    pub fn python_exe(&self) -> &str {
        &self.active_paths().python_exe
    }

    /// Speaker-inversion YAML relative to irodori root.
    pub fn train_config_rel(&self) -> &'static str {
        if self.is_v4() {
            "configs/train_v4_small_speaker_inversion.yaml"
        } else {
            "configs/train_500m_v3_speaker_inversion.yaml"
        }
    }

    /// True when engine root / python / checkpoint / outputs / version / device / precision differ.
    pub fn engine_identity_changed(&self, other: &AppSettings) -> bool {
        self.irodori_version != other.irodori_version
            || self.active_paths() != other.active_paths()
            || self.model_device != other.model_device
            || self.codec_device != other.codec_device
            || self.model_precision != other.model_precision
            || self.codec_precision != other.codec_precision
    }
}

/// Legacy flat settings.json (pre version-profiles).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyFlatSettings {
    irodori_root: Option<String>,
    checkpoint_path: Option<String>,
    outputs_root: Option<String>,
    python_exe: Option<String>,
    model_precision: Option<String>,
    codec_precision: Option<String>,
    model_device: Option<String>,
    codec_device: Option<String>,
    projects_root: Option<String>,
    ffmpeg_path: Option<String>,
    theme: Option<String>,
    chunk_silence_ms: Option<u32>,
    utterance_max_chars: Option<u32>,
    export_filename_parts: Option<Vec<String>>,
    asr_cer_warn_threshold: Option<f64>,
    irodori_version: Option<String>,
    paths_v3: Option<VersionPathSettings>,
    paths_v4: Option<VersionPathSettings>,
}

fn migrate_from_value(value: serde_json::Value) -> Option<AppSettings> {
    // Prefer modern shape when pathsV3 is present.
    if value.get("pathsV3").is_some() || value.get("paths_v3").is_some() {
        return serde_json::from_value::<AppSettings>(value).ok();
    }

    let legacy: LegacyFlatSettings = serde_json::from_value(value).ok()?;
    let mut settings = AppSettings::default();

    if let Some(v) = legacy.irodori_version {
        settings.irodori_version = v;
    }
    if let Some(p) = legacy.paths_v3 {
        settings.paths_v3 = p;
    } else if let (Some(root), Some(ckpt), Some(out), Some(py)) = (
        legacy.irodori_root.clone(),
        legacy.checkpoint_path.clone(),
        legacy.outputs_root.clone(),
        legacy.python_exe.clone(),
    ) {
        // Old single-profile install → treat as v3 paths.
        settings.paths_v3 = VersionPathSettings {
            irodori_root: root,
            checkpoint_path: ckpt,
            outputs_root: out,
            python_exe: py,
        };
        settings.irodori_version = "v3".into();
    } else {
        // Partial legacy: fill what we can onto v3.
        if let Some(root) = legacy.irodori_root {
            settings.paths_v3.irodori_root = root;
        }
        if let Some(ckpt) = legacy.checkpoint_path {
            settings.paths_v3.checkpoint_path = ckpt;
        }
        if let Some(out) = legacy.outputs_root {
            settings.paths_v3.outputs_root = out;
        }
        if let Some(py) = legacy.python_exe {
            settings.paths_v3.python_exe = py;
        }
    }
    if let Some(p) = legacy.paths_v4 {
        settings.paths_v4 = p;
    }
    if let Some(v) = legacy.model_precision {
        settings.model_precision = v;
    }
    if let Some(v) = legacy.codec_precision {
        settings.codec_precision = v;
    }
    if let Some(v) = legacy.model_device {
        settings.model_device = v;
    }
    if let Some(v) = legacy.codec_device {
        settings.codec_device = v;
    }
    if let Some(v) = legacy.projects_root {
        settings.projects_root = v;
    }
    if let Some(v) = legacy.ffmpeg_path {
        settings.ffmpeg_path = v;
    }
    if let Some(v) = legacy.theme {
        settings.theme = v;
    }
    if let Some(v) = legacy.asr_cer_warn_threshold {
        settings.asr_cer_warn_threshold = v;
    }
    if let Some(v) = legacy.chunk_silence_ms {
        settings.chunk_silence_ms = v;
    }
    if let Some(v) = legacy.utterance_max_chars {
        settings.utterance_max_chars = v;
    }
    if let Some(v) = legacy.export_filename_parts {
        settings.export_filename_parts = normalize_export_filename_parts(v);
    }
    Some(settings)
}

pub fn settings_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("irodori-studio")
        .join("settings.json")
}

pub fn load_settings() -> AppSettings {
    let path = settings_path();
    if path.is_file() {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                let needs_rewrite = value.get("pathsV3").is_none() && value.get("paths_v3").is_none();
                if let Some(mut s) = migrate_from_value(value) {
                    s.export_filename_parts =
                        normalize_export_filename_parts(s.export_filename_parts);
                    if needs_rewrite {
                        let _ = save_settings(&s);
                    }
                    return s;
                }
            }
        }
    }
    AppSettings::default()
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let _ = fs::create_dir_all(settings.outputs_root());
    let _ = fs::create_dir_all(&settings.projects_root);
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathValidation {
    pub irodori_root_ok: bool,
    pub python_ok: bool,
    pub checkpoint_ok: bool,
    pub outputs_ok: bool,
    pub ffmpeg_ok: bool,
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub irodori_version: String,
    #[serde(default)]
    pub train_config_ok: bool,
    /// Bundled Studio scripts (`opt_worker.py` etc.) resolved.
    #[serde(default)]
    pub studio_scripts_ok: bool,
    #[serde(default)]
    pub studio_python_dir: Option<String>,
}

/// Resolve a usable Python executable.
/// Order: configured path → `{irodoriRoot}/.venv/Scripts/python.exe` (Win) /
/// `{irodoriRoot}/.venv/bin/python` → `python` / `py` / `python3` on PATH.
pub fn resolve_python_exe(settings: &AppSettings) -> Option<PathBuf> {
    let configured = PathBuf::from(settings.python_exe());
    if configured.is_file() {
        return Some(configured);
    }

    let root = Path::new(settings.irodori_root());
    let venv_candidates = [
        root.join(".venv").join("Scripts").join("python.exe"),
        root.join(".venv").join("bin").join("python"),
        root.join("venv").join("Scripts").join("python.exe"),
        root.join("venv").join("bin").join("python"),
    ];
    for c in venv_candidates {
        if c.is_file() {
            return Some(c);
        }
    }

    for name in ["python", "py", "python3"] {
        if let Ok(p) = which::which(name) {
            return Some(p);
        }
    }
    None
}

pub fn validate_settings(settings: &AppSettings) -> PathValidation {
    let ffmpeg = resolve_ffmpeg(settings).map(|p| p.display().to_string());
    let python_ok = resolve_python_exe(settings).is_some();
    let train_cfg = Path::new(settings.irodori_root()).join(settings.train_config_rel());
    let studio = studio_python_dir().ok();
    PathValidation {
        irodori_root_ok: Path::new(settings.irodori_root()).is_dir(),
        python_ok,
        checkpoint_ok: Path::new(settings.checkpoint_path()).is_file(),
        outputs_ok: Path::new(settings.outputs_root()).is_dir()
            || Path::new(settings.irodori_root()).is_dir(),
        ffmpeg_ok: ffmpeg.is_some(),
        ffmpeg_path: ffmpeg,
        irodori_version: settings.irodori_version.clone(),
        train_config_ok: train_cfg.is_file(),
        studio_scripts_ok: studio.is_some(),
        studio_python_dir: studio.map(|p| p.display().to_string()),
    }
}

fn studio_python_candidate_ok(dir: &Path) -> bool {
    dir.join("opt_worker.py").is_file()
}

fn push_unique(tried: &mut Vec<String>, path: &Path) {
    let s = path.display().to_string();
    if !tried.iter().any(|t| t == &s) {
        tried.push(s);
    }
}

/// Dev / portable fallbacks that do not need Tauri PathResolver.
fn discover_studio_python_dir_local(tried: &mut Vec<String>) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for name in ["python", "_up_/python"] {
                let p = parent.join(name);
                push_unique(tried, &p);
                if studio_python_candidate_ok(&p) {
                    return Some(p);
                }
            }
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev = manifest.join("..").join("python");
    push_unique(tried, &dev);
    if studio_python_candidate_ok(&dev) {
        return Some(dev.canonicalize().unwrap_or(dev));
    }
    None
}

fn discover_studio_python_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut tried = Vec::new();

    // Preferred: mapped resource `python/` (tauri.conf.json bundle.resources).
    // Legacy: array form `../python/**/*` landed under `_up_/python`.
    for rel in ["python", "_up_/python"] {
        match app.path().resolve(rel, BaseDirectory::Resource) {
            Ok(p) => {
                push_unique(&mut tried, &p);
                if studio_python_candidate_ok(&p) {
                    return Ok(p);
                }
            }
            Err(e) => tried.push(format!("{rel} (resolve): {e}")),
        }
    }

    if let Ok(res) = app.path().resource_dir() {
        for name in ["python", "_up_/python"] {
            let p = res.join(name);
            push_unique(&mut tried, &p);
            if studio_python_candidate_ok(&p) {
                return Ok(p);
            }
        }
    }

    if let Some(p) = discover_studio_python_dir_local(&mut tried) {
        return Ok(p);
    }

    Err(format!(
        "Studio 同梱の python/（opt_worker.py）が見つかりません。試行: {}",
        tried.join(" | ")
    ))
}

/// Call once from app `setup` so release installs resolve `$RESOURCE/python`.
pub fn init_studio_resource_paths(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = discover_studio_python_dir(app)?;
    let _ = STUDIO_PYTHON_DIR.set(dir.clone());
    Ok(dir)
}

/// Directory containing Studio-owned scripts (`opt_worker.py`, preprocess, …).
pub fn studio_python_dir() -> Result<PathBuf, String> {
    if let Some(d) = STUDIO_PYTHON_DIR.get() {
        return Ok(d.clone());
    }
    let mut tried = Vec::new();
    if let Some(p) = discover_studio_python_dir_local(&mut tried) {
        let _ = STUDIO_PYTHON_DIR.set(p.clone());
        return Ok(p);
    }
    Err(format!(
        "Studio 同梱の python/（opt_worker.py）が見つかりません。試行: {}",
        tried.join(" | ")
    ))
}

/// Resolve ffmpeg binary. Order: settings.ffmpegPath → PATH.
pub fn resolve_ffmpeg(settings: &AppSettings) -> Option<PathBuf> {
    let configured = settings.ffmpeg_path.trim();
    if !configured.is_empty() {
        let p = PathBuf::from(configured);
        if p.is_file() {
            return Some(p);
        }
        // Allow pointing at a directory that contains ffmpeg.exe
        let beside = if cfg!(windows) {
            p.join("ffmpeg.exe")
        } else {
            p.join("ffmpeg")
        };
        if beside.is_file() {
            return Some(beside);
        }
    }
    which::which("ffmpeg").ok()
}

/// Resolve ffprobe beside configured ffmpeg, else PATH.
pub fn resolve_ffprobe(settings: &AppSettings) -> Option<PathBuf> {
    if let Some(ff) = resolve_ffmpeg(settings) {
        if let Some(dir) = ff.parent() {
            let beside = if cfg!(windows) {
                dir.join("ffprobe.exe")
            } else {
                dir.join("ffprobe")
            };
            if beside.is_file() {
                return Some(beside);
            }
        }
    }
    which::which("ffprobe").ok()
}

/// Ensure child processes (Python preprocess) can find the chosen ffmpeg.
pub fn apply_ffmpeg_env(cmd: &mut std::process::Command, settings: &AppSettings) {
    let Some(ff) = resolve_ffmpeg(settings) else {
        return;
    };
    cmd.env("FFMPEG_BINARY", &ff);
    if let Some(dir) = ff.parent() {
        let path_key = std::ffi::OsString::from("PATH");
        let mut new_path = std::ffi::OsString::new();
        new_path.push(dir.as_os_str());
        #[cfg(windows)]
        new_path.push(";");
        #[cfg(not(windows))]
        new_path.push(":");
        if let Some(old) = std::env::var_os(&path_key) {
            new_path.push(old);
        }
        cmd.env(path_key, new_path);
    }
}
