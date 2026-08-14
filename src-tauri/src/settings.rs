use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tauri::path::BaseDirectory;

/// Resolved once at app startup (Tauri `$RESOURCE/python`).
static STUDIO_PYTHON_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Bundled `ffmpeg` / `ffmpeg.exe` (never PATH / user override).
static BUNDLED_FFMPEG: OnceLock<PathBuf> = OnceLock::new();
/// Bundled `ffprobe` beside ffmpeg, if present.
static BUNDLED_FFPROBE: OnceLock<PathBuf> = OnceLock::new();

pub const MISSING_FFMPEG_MSG: &str = "同梱の ffmpeg が見つかりません";

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
    /// Legacy field (ignored). Bundled ffmpeg is always used.
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

fn empty_paths() -> VersionPathSettings {
    VersionPathSettings {
        irodori_root: String::new(),
        checkpoint_path: String::new(),
        outputs_root: String::new(),
        python_exe: String::new(),
    }
}

fn default_paths_for(folder: &str, version: &str) -> VersionPathSettings {
    let root = default_engine_root(folder);
    if root.is_dir() {
        infer_paths_from_root(&root.display().to_string(), version).into_version_paths()
    } else {
        empty_paths()
    }
}

fn default_paths_v3() -> VersionPathSettings {
    default_paths_for("IrodoriTTS", "v3")
}

fn hf_hub_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut push = |p: PathBuf| {
        if p.is_dir() && !out.iter().any(|x| x == &p) {
            out.push(p);
        }
    };
    if let Ok(v) = std::env::var("HF_HUB_CACHE") {
        let t = v.trim();
        if !t.is_empty() {
            push(PathBuf::from(t));
        }
    }
    if let Ok(v) = std::env::var("HF_HOME") {
        let t = v.trim();
        if !t.is_empty() {
            push(PathBuf::from(t).join("hub"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        push(home.join(".cache").join("huggingface").join("hub"));
    }
    out
}

fn hf_repos_for_version(version: &str) -> &'static [&'static str] {
    if version.eq_ignore_ascii_case("v4") {
        &[
            "Aratako/Irodori-TTS-v4.1-Small",
            "Aratako/Irodori-TTS-v4-Small",
        ]
    } else {
        &["Aratako/Irodori-TTS-500M-v3"]
    }
}

fn snapshot_model_safetensors(model_root: &Path) -> Option<PathBuf> {
    let snapshots = model_root.join("snapshots");
    if !snapshots.is_dir() {
        return None;
    }
    let refs_main = model_root.join("refs").join("main");
    if let Ok(hash) = fs::read_to_string(&refs_main) {
        let p = snapshots.join(hash.trim()).join("model.safetensors");
        if p.is_file() {
            return Some(p);
        }
    }
    let mut dirs: Vec<_> = fs::read_dir(&snapshots)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    dirs.sort_by_key(|e| {
        e.metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    for e in dirs.into_iter().rev() {
        let p = e.path().join("model.safetensors");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn hub_dir_matches_version(dir_name: &str, version: &str) -> bool {
    let n = dir_name.to_ascii_lowercase();
    if !n.contains("irodori-tts") || n.contains("quantized") {
        return false;
    }
    if version.eq_ignore_ascii_case("v4") {
        n.contains("v4")
    } else {
        (n.contains("v3") || n.contains("500m")) && !n.contains("v4")
    }
}

fn hf_dir_preference(dir_name: &str, version: &str) -> u8 {
    let n = dir_name.to_ascii_lowercase();
    if version.eq_ignore_ascii_case("v4") {
        if n.contains("v4.1") {
            0
        } else {
            1
        }
    } else if n.contains("500m") {
        0
    } else {
        1
    }
}

fn scan_hub_for_version(hub: &Path, version: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(hub)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            hub_dir_matches_version(name, version)
        })
        .collect();
    dirs.sort_by_key(|p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        hf_dir_preference(name, version)
    });
    for d in dirs {
        if let Some(ckpt) = snapshot_model_safetensors(&d) {
            return Some(ckpt);
        }
    }
    None
}

/// Hugging Face hub: `hub/models--Aratako--…/snapshots/<revision>/model.safetensors`
fn find_hf_checkpoint(version: &str) -> Option<PathBuf> {
    let hubs = hf_hub_roots();
    for repo in hf_repos_for_version(version) {
        let dir_name = format!("models--{}", repo.replace('/', "--"));
        for hub in &hubs {
            if let Some(p) = snapshot_model_safetensors(&hub.join(&dir_name)) {
                return Some(p);
            }
        }
    }
    for hub in &hubs {
        if let Some(p) = scan_hub_for_version(hub, version) {
            return Some(p);
        }
    }
    None
}

fn find_checkpoint_for_version(root: &Path, version: &str) -> Option<PathBuf> {
    if let Some(p) = find_hf_checkpoint(version) {
        return Some(p);
    }
    let local_known = known_checkpoint(root, version);
    if local_known.is_file() {
        return Some(local_known);
    }
    find_model_safetensors(&root.join("checkpoints"), 0, 4)
}

fn default_paths_v4() -> VersionPathSettings {
    default_paths_for("IrodoriTTS-v4", "v4")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferredPaths {
    pub irodori_root: String,
    pub outputs_root: String,
    pub python_exe: String,
    pub checkpoint_path: String,
    pub python_found: bool,
    pub checkpoint_found: bool,
}

impl InferredPaths {
    fn into_version_paths(self) -> VersionPathSettings {
        VersionPathSettings {
            irodori_root: self.irodori_root,
            checkpoint_path: self.checkpoint_path,
            outputs_root: self.outputs_root,
            python_exe: self.python_exe,
        }
    }
}

fn python_under_root(root: &Path) -> Option<PathBuf> {
    let candidates = [
        root.join(".venv").join("Scripts").join("python.exe"),
        root.join(".venv").join("bin").join("python"),
        root.join("venv").join("Scripts").join("python.exe"),
        root.join("venv").join("bin").join("python"),
    ];
    candidates.into_iter().find(|c| c.is_file())
}

fn conventional_python(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join(".venv").join("Scripts").join("python.exe")
    } else {
        root.join(".venv").join("bin").join("python")
    }
}

fn known_checkpoint(root: &Path, version: &str) -> PathBuf {
    if version.eq_ignore_ascii_case("v4") {
        root.join("checkpoints")
            .join("Aratako_Irodori-TTS-v4-Small")
            .join("model.safetensors")
    } else {
        root.join("checkpoints")
            .join("Aratako_Irodori-TTS-500M-v3")
            .join("model.safetensors")
    }
}

fn find_model_safetensors(dir: &Path, depth: u32, max_depth: u32) -> Option<PathBuf> {
    if depth > max_depth || !dir.is_dir() {
        return None;
    }
    let direct = dir.join("model.safetensors");
    if direct.is_file() {
        return Some(direct);
    }
    let mut entries: Vec<_> = fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        if p.is_dir() {
            if let Some(found) = find_model_safetensors(&p, depth + 1, max_depth) {
                return Some(found);
            }
        }
    }
    None
}

/// Infer Outputs / Python / Checkpoint from an Irodori engine root.
pub fn infer_paths_from_root(root: &str, version: &str) -> InferredPaths {
    let root_str = root.trim().to_string();
    let root_path = Path::new(&root_str);
    let outputs = root_path.join("outputs");

    let (python_exe, python_found) = match python_under_root(root_path) {
        Some(p) => (p.display().to_string(), true),
        None => (conventional_python(root_path).display().to_string(), false),
    };

    let found = find_checkpoint_for_version(root_path, version);
    let known = known_checkpoint(root_path, version);
    let (checkpoint_path, checkpoint_found) = match found {
        Some(p) if p.is_file() => (p.display().to_string(), true),
        _ => (known.display().to_string(), false),
    };

    InferredPaths {
        irodori_root: if root_str.is_empty() {
            String::new()
        } else {
            root_path.display().to_string()
        },
        outputs_root: if root_str.is_empty() {
            String::new()
        } else {
            outputs.display().to_string()
        },
        python_exe: if root_str.is_empty() {
            String::new()
        } else {
            python_exe
        },
        checkpoint_path: if root_str.is_empty() {
            String::new()
        } else {
            checkpoint_path
        },
        python_found: python_found && !root_str.is_empty(),
        checkpoint_found: checkpoint_found && !root_str.is_empty(),
    }
}

pub fn needs_first_setup() -> bool {
    !settings_path().is_file()
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

/// Call once from app `setup` so release installs resolve `$RESOURCE/python` and bundled ffmpeg.
pub fn init_studio_resource_paths(app: &AppHandle) -> Result<PathBuf, String> {
    init_bundled_ffmpeg(Some(app));
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

fn ffmpeg_bin_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn ffprobe_bin_name() -> &'static str {
    if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    }
}

fn remember_ffprobe_beside(ffmpeg: &Path) {
    if BUNDLED_FFPROBE.get().is_some() {
        return;
    }
    if let Some(dir) = ffmpeg.parent() {
        let probe = dir.join(ffprobe_bin_name());
        if probe.is_file() {
            let _ = BUNDLED_FFPROBE.set(probe);
        }
    }
}

fn discover_bundled_ffmpeg_local(tried: &mut Vec<String>) -> Option<PathBuf> {
    let name = ffmpeg_bin_name();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for rel in [
                parent.join("ffmpeg").join(name),
                parent.join(name),
                parent.join("_up_").join("ffmpeg").join(name),
            ] {
                push_unique(tried, &rel);
                if rel.is_file() {
                    return Some(rel);
                }
            }
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let vendor = manifest.join("..").join("vendor").join("ffmpeg").join(name);
    push_unique(tried, &vendor);
    if vendor.is_file() {
        return Some(vendor.canonicalize().unwrap_or(vendor));
    }
    None
}

fn discover_bundled_ffmpeg(app: Option<&AppHandle>, tried: &mut Vec<String>) -> Option<PathBuf> {
    let name = ffmpeg_bin_name();
    if let Some(app) = app {
        let file_rels = [
            format!("ffmpeg/{name}"),
            format!("_up_/ffmpeg/{name}"),
        ];
        for rel in file_rels {
            match app.path().resolve(&rel, BaseDirectory::Resource) {
                Ok(p) => {
                    push_unique(tried, &p);
                    if p.is_file() {
                        return Some(p);
                    }
                }
                Err(e) => tried.push(format!("{rel} (resolve): {e}")),
            }
        }
        for rel in ["ffmpeg", "_up_/ffmpeg"] {
            match app.path().resolve(rel, BaseDirectory::Resource) {
                Ok(dir) => {
                    let p = dir.join(name);
                    push_unique(tried, &p);
                    if p.is_file() {
                        return Some(p);
                    }
                }
                Err(e) => tried.push(format!("{rel} (resolve): {e}")),
            }
        }
        if let Ok(res) = app.path().resource_dir() {
            for dir_name in ["ffmpeg", "_up_/ffmpeg"] {
                let p = res.join(dir_name).join(name);
                push_unique(tried, &p);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    discover_bundled_ffmpeg_local(tried)
}

fn init_bundled_ffmpeg(app: Option<&AppHandle>) {
    if BUNDLED_FFMPEG.get().is_some() {
        return;
    }
    let mut tried = Vec::new();
    if let Some(p) = discover_bundled_ffmpeg(app, &mut tried) {
        remember_ffprobe_beside(&p);
        eprintln!("[irodori-studio] bundled ffmpeg: {}", p.display());
        let _ = BUNDLED_FFMPEG.set(p);
    } else {
        eprintln!(
            "[irodori-studio] WARNING: {MISSING_FFMPEG_MSG}。試行: {}",
            tried.join(" | ")
        );
    }
}

/// Resolve bundled ffmpeg only (never settings path or PATH).
pub fn resolve_ffmpeg(_settings: &AppSettings) -> Option<PathBuf> {
    if let Some(p) = BUNDLED_FFMPEG.get() {
        return Some(p.clone());
    }
    init_bundled_ffmpeg(None);
    BUNDLED_FFMPEG.get().cloned()
}

/// Resolve bundled ffprobe beside bundled ffmpeg.
pub fn resolve_ffprobe(settings: &AppSettings) -> Option<PathBuf> {
    if let Some(p) = BUNDLED_FFPROBE.get() {
        return Some(p.clone());
    }
    if let Some(ff) = resolve_ffmpeg(settings) {
        remember_ffprobe_beside(&ff);
        return BUNDLED_FFPROBE.get().cloned();
    }
    None
}

/// Inject `FFMPEG_BINARY` (absolute bundled path). Does not modify PATH.
pub fn apply_ffmpeg_env(cmd: &mut std::process::Command, settings: &AppSettings) {
    let Some(ff) = resolve_ffmpeg(settings) else {
        return;
    };
    cmd.env("FFMPEG_BINARY", &ff);
}
