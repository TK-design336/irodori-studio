mod asr;
mod dictionary;
mod http_server;
mod native_asr;
mod native_output;
mod project;
mod python_env;
mod settings;
mod speakers;
mod split_text;
mod synth;
mod train;
mod voicevox_compat;
mod worker;

use parking_lot::Mutex;
use serde_json::{json, Value};
use settings::{
    generate_http_token, infer_paths_from_root, init_studio_resource_paths, load_settings,
    needs_first_setup, normalize_http_bind_address, normalize_http_cors_origins, resolve_ffmpeg,
    resolve_ffprobe, save_settings, studio_python_dir, validate_settings, AppSettings,
    InferredPaths, PathValidation, MISSING_FFMPEG_MSG,
};
use speakers::{
    RenameSpeakerArgs, SpeakerInfo, UpdateSpeakerMetaArgs, UpsertSpeakerProfileArgs,
};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use train::{
    cancel_train_job, clear_resume_info, get_resume_info, run_alkana_suggest, run_blend,
    run_blend_to, start_train_job, TrainResumeInfo, TrainState,
};
use worker::OptWorkerSimple;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub worker: Mutex<OptWorkerSimple>,
    pub asr_worker: Mutex<asr::AsrWorker>,
    pub train: Arc<TrainState>,
    pub http: Mutex<http_server::HttpServerHandle>,
}

/// Run `f` on Tokio's blocking pool so sync Python/mutex work never stalls
/// the WebView2 UI thread (Tauri sync commands run inline on that thread).
async fn with_state_blocking<T, F>(app: AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppState) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        f(&state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> AppSettings {
    state.settings.lock().clone()
}

#[tauri::command]
async fn set_settings(
    app: AppHandle,
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    settings.export_filename_parts =
        settings::normalize_export_filename_parts(settings.export_filename_parts);
    settings.export_audio_format =
        settings::normalize_export_audio_format(&settings.export_audio_format);
    settings.export_mp3_bitrate_kbps =
        settings::normalize_mp3_bitrate_kbps(settings.export_mp3_bitrate_kbps);
    settings.export_opus_bitrate_kbps =
        settings::normalize_opus_bitrate_kbps(settings.export_opus_bitrate_kbps);
    settings.accent_light = settings::normalize_accent_light(&settings.accent_light);
    settings.accent_dark = settings::normalize_accent_dark(&settings.accent_dark);
    settings.http_bind_address = normalize_http_bind_address(&settings.http_bind_address);
    settings.http_cors_origins = normalize_http_cors_origins(settings.http_cors_origins);
    settings.http_max_chars = settings::normalize_http_max_chars(settings.http_max_chars);
    if settings.http_token.trim().is_empty() {
        settings.http_token = generate_http_token();
    }
    if settings.vocal_separator_model.trim().is_empty() {
        settings.vocal_separator_model = settings::DEFAULT_VOCAL_SEPARATOR_MODEL.into();
    }
    with_state_blocking(app.clone(), move |state| {
        let prev = state.settings.lock().clone();
        save_settings(&settings)?;
        if prev.engine_identity_changed(&settings) {
            // Version / root / checkpoint change → drop loaded OPT runtime.
            let _ = state.worker.lock().shutdown();
        }
        *state.settings.lock() = settings.clone();
        state.http.lock().apply_settings(&app, &settings);
        Ok(settings)
    })
    .await
}

#[tauri::command]
fn http_server_status(state: tauri::State<'_, AppState>) -> http_server::HttpServerStatus {
    state.http.lock().status()
}

#[tauri::command]
fn regenerate_http_token(
    state: tauri::State<'_, AppState>,
) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().clone();
    settings.http_token = generate_http_token();
    save_settings(&settings)?;
    *state.settings.lock() = settings.clone();
    state.http.lock().update_auth_config(&settings);
    Ok(settings)
}

#[tauri::command]
fn infer_engine_paths(root: String, version: String) -> InferredPaths {
    infer_paths_from_root(&root, &version)
}

#[tauri::command]
fn needs_first_setup_cmd() -> bool {
    needs_first_setup()
}

#[tauri::command]
fn validate_paths(state: tauri::State<'_, AppState>) -> PathValidation {
    let settings = state.settings.lock().clone();
    validate_settings(&settings)
}

#[tauri::command]
fn list_speakers(state: tauri::State<'_, AppState>) -> Result<Vec<SpeakerInfo>, String> {
    let settings = state.settings.lock().clone();
    speakers::scan_speakers(settings.outputs_root())
}

#[tauri::command]
fn upsert_speaker_profile_cmd(
    state: tauri::State<'_, AppState>,
    args: UpsertSpeakerProfileArgs,
) -> Result<SpeakerInfo, String> {
    let settings = state.settings.lock().clone();
    speakers::upsert_speaker_profile(
        settings.outputs_root(),
        args,
        resolve_ffmpeg(&settings),
    )
}

#[tauri::command]
fn update_speaker_meta_cmd(
    state: tauri::State<'_, AppState>,
    args: UpdateSpeakerMetaArgs,
) -> Result<SpeakerInfo, String> {
    let settings = state.settings.lock().clone();
    speakers::update_speaker_meta(settings.outputs_root(), args)
}

#[tauri::command]
fn delete_speaker_profile_cmd(profile_path: String) -> Result<(), String> {
    speakers::delete_speaker_profile(&profile_path)
}

#[tauri::command]
fn delete_speaker_cmd(embed_path: String, kind: String) -> Result<(), String> {
    speakers::delete_speaker(&embed_path, &kind)
}

#[tauri::command]
fn rename_speaker_cmd(
    state: tauri::State<'_, AppState>,
    args: RenameSpeakerArgs,
) -> Result<SpeakerInfo, String> {
    let settings = state.settings.lock().clone();
    speakers::rename_speaker(settings.outputs_root(), args)
}

#[tauri::command]
fn start_training(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    input_dir: String,
    speaker_name: String,
    input_mode: Option<String>,
    speed: Option<f64>,
    vocal_separate: Option<bool>,
    vocal_model: Option<String>,
    job_dir: Option<String>,
    review_mode: Option<String>,
    slice_method: Option<String>,
) -> Result<(), String> {
    let settings = state.settings.lock().clone();
    start_train_job(
        app,
        settings,
        input_dir,
        speaker_name,
        input_mode.unwrap_or_else(|| "raw".into()),
        speed.unwrap_or(1.0),
        vocal_separate.unwrap_or(false),
        vocal_model,
        job_dir,
        review_mode,
        slice_method,
        state.train.clone(),
    )
}

#[tauri::command]
fn load_diarization_cmd(job_dir: String) -> Result<serde_json::Value, String> {
    train::load_diarization(&job_dir)
}

#[tauri::command]
fn save_diarization_cmd(
    job_dir: String,
    selected: Vec<String>,
) -> Result<serde_json::Value, String> {
    train::save_diarization(&job_dir, selected)
}

#[tauri::command]
fn load_slice_review_metrics_cmd(job_dir: String) -> Result<serde_json::Value, String> {
    train::load_slice_review_metrics(&job_dir)
}

#[tauri::command]
fn load_slice_review_exclusions_cmd(job_dir: String) -> Result<serde_json::Value, String> {
    train::load_slice_review_exclusions(&job_dir)
}

#[tauri::command]
fn load_slice_review_log_cmd(job_dir: String) -> Result<serde_json::Value, String> {
    train::load_slice_review_log(&job_dir)
}

#[tauri::command]
fn save_slice_review_exclusions_cmd(
    job_dir: String,
    exclusions: serde_json::Value,
) -> Result<(), String> {
    train::save_slice_review_exclusions(&job_dir, exclusions)
}

#[tauri::command]
fn complete_slice_review_cmd(job_dir: String) -> Result<u64, String> {
    train::complete_slice_review(&job_dir)
}

#[tauri::command]
fn load_slice_autofix_log_cmd(job_dir: String) -> Result<serde_json::Value, String> {
    train::load_slice_autofix_log(&job_dir)
}

#[tauri::command]
fn run_slice_autofix_cmd(
    state: tauri::State<'_, AppState>,
    job_dir: String,
) -> Result<serde_json::Value, String> {
    let settings = state.settings.lock().clone();
    train::run_slice_autofix(&job_dir, &settings)
}

#[tauri::command]
fn cancel_training(state: tauri::State<'_, AppState>) -> Result<(), String> {
    cancel_train_job(&state.train)
}

#[tauri::command]
fn is_training(state: tauri::State<'_, AppState>) -> bool {
    state.train.running.load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
fn get_train_resume(state: tauri::State<'_, AppState>) -> Option<TrainResumeInfo> {
    get_resume_info(&state.train).filter(|r| !r.job_dir.trim().is_empty())
}

#[tauri::command]
fn clear_train_resume(state: tauri::State<'_, AppState>) {
    clear_resume_info(&state.train);
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VocalSeparatorModelInfo {
    arch: String,
    name: String,
    filename: String,
    #[serde(default)]
    stems: Vec<String>,
    #[serde(default)]
    target_stem: Option<String>,
}

fn default_vocal_model_fallback() -> Vec<VocalSeparatorModelInfo> {
    vec![VocalSeparatorModelInfo {
        arch: "MDXC".into(),
        name: "BS-Roformer（推奨・既定）".into(),
        filename: settings::DEFAULT_VOCAL_SEPARATOR_MODEL.into(),
        stems: vec!["Vocals".into(), "Instrumental".into()],
        target_stem: Some("Vocals".into()),
    }]
}

#[tauri::command]
fn list_vocal_separator_models(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<VocalSeparatorModelInfo>, String> {
    let settings = state.settings.lock().clone();
    let python = match resolve_python_exe_from_settings(&settings) {
        Some(p) => p,
        None => return Ok(default_vocal_model_fallback()),
    };
    crate::python_env::ensure_audio_separator_best_effort(&python);

    let python_dir = match studio_python_dir() {
        Ok(d) => d,
        Err(_) => return Ok(default_vocal_model_fallback()),
    };
    let script = python_dir.join("vocal_separator.py");
    if !script.is_file() {
        return Ok(default_vocal_model_fallback());
    }

    let mut cmd = std::process::Command::new(&python);
    cmd.arg("-u")
        .arg(&script)
        .arg("--list-models")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    apply_ffmpeg_env_for_list(&mut cmd, &settings);
    crate::python_env::hide_console(&mut cmd);

    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return Ok(default_vocal_model_fallback()),
    };
    if !output.status.success() {
        return Ok(default_vocal_model_fallback());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with('['))
        .unwrap_or("");
    if line.is_empty() {
        return Ok(default_vocal_model_fallback());
    }
    match serde_json::from_str::<Vec<VocalSeparatorModelInfo>>(line) {
        Ok(list) if !list.is_empty() => Ok(list),
        _ => Ok(default_vocal_model_fallback()),
    }
}

fn resolve_python_exe_from_settings(settings: &AppSettings) -> Option<PathBuf> {
    settings::resolve_python_exe(settings)
}

fn apply_ffmpeg_env_for_list(cmd: &mut std::process::Command, settings: &AppSettings) {
    settings::apply_ffmpeg_env(cmd, settings);
}

#[tauri::command]
fn blend_embeddings(
    state: tauri::State<'_, AppState>,
    embed_a: String,
    embed_b: String,
    output_name: String,
    embed_c: Option<String>,
    weight_a: Option<f64>,
    weight_b: Option<f64>,
    weight_c: Option<f64>,
    alpha: Option<f64>,
    preview: Option<bool>,
) -> Result<String, String> {
    let settings = state.settings.lock().clone();
    let (wa, wb, wc) = if let (Some(a), Some(b)) = (weight_a, weight_b) {
        (a, b, weight_c.unwrap_or(0.0))
    } else if let Some(al) = alpha {
        if !(0.0..=1.0).contains(&al) {
            return Err("alpha は 0〜1 です".into());
        }
        (1.0 - al, al, 0.0)
    } else {
        return Err("weightA/weightB または alpha が必要です".into());
    };
    let c = embed_c.as_deref().filter(|s| !s.is_empty());
    if preview.unwrap_or(false) {
        let out_path = studio_cache_dir()
            .join("blend_preview")
            .join("preview.speaker.safetensors");
        run_blend_to(&settings, &embed_a, &embed_b, c, wa, wb, wc, &out_path)
    } else {
        run_blend(&settings, &embed_a, &embed_b, c, wa, wb, wc, &output_name)
    }
}

#[tauri::command]
fn suggest_katakana(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<Vec<train::KatakanaHit>, String> {
    let settings = state.settings.lock().clone();
    run_alkana_suggest(&settings, &text)
}

#[tauri::command]
async fn ensure_worker(app: AppHandle) -> Result<Value, String> {
    with_state_blocking(app, |state| {
        let settings = state.settings.lock().clone();
        let python_dir = studio_python_dir()?;
        let mut worker = state.worker.lock();
        // Health-check existing process; dead/hung → restart.
        let _ = worker.ensure_alive();
        worker.start(&settings, &python_dir)?;
        if !worker.is_loaded() {
            let resp = worker.load(&settings)?;
            if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                return Err(format!("load failed: {resp}"));
            }
            return Ok(resp);
        }
        Ok(json!({"ok": true, "status": "already_loaded"}))
    })
    .await
}

#[tauri::command]
async fn ping_worker(app: AppHandle) -> Result<Value, String> {
    with_state_blocking(app, |state| {
        let settings = state.settings.lock().clone();
        let python_dir = studio_python_dir()?;
        // Skip if HTTP/UI synth holds the mutex — never wait on the periodic ping path.
        let mut worker = match state.worker.try_lock() {
            Some(w) => w,
            None => {
                return Ok(json!({
                    "ok": true,
                    "status": "busy",
                    "loaded": true,
                    "recovered": false,
                }));
            }
        };
        if !worker.is_running() {
            return Ok(json!({"ok": false, "status": "not_running", "recovered": false}));
        }
        match worker.ensure_alive() {
            Ok(true) => Ok(json!({
                "ok": true,
                "status": "pong",
                "loaded": worker.is_loaded(),
                "recovered": false,
            })),
            Ok(false) => {
                // Auto-restart + reload only when nobody else is using the worker.
                worker.start(&settings, &python_dir)?;
                let resp = worker.load(&settings)?;
                if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                    return Err(format!("worker restart load failed: {resp}"));
                }
                Ok(json!({
                    "ok": true,
                    "status": "restarted",
                    "loaded": true,
                    "recovered": true,
                }))
            }
            Err(e) => Err(e),
        }
    })
    .await
}

#[tauri::command]
async fn worker_status(app: AppHandle) -> Result<Value, String> {
    with_state_blocking(app, |state| {
        Ok(match state.worker.try_lock() {
            Some(mut w) => {
                w.reap_if_dead();
                json!({
                    "running": w.is_running(),
                    "loaded": w.is_loaded(),
                    "busy": false,
                })
            }
            None => json!({
                "running": true,
                "loaded": true,
                "busy": true,
            }),
        })
    })
    .await
}

#[tauri::command]
async fn unload_worker(app: AppHandle) -> Result<Value, String> {
    with_state_blocking(app, |state| {
        let mut worker = state.worker.lock();
        if worker.is_running() {
            worker.unload()
        } else {
            Ok(json!({"ok": true, "status": "not_running"}))
        }
    })
    .await
}

#[tauri::command]
async fn shutdown_worker(app: AppHandle) -> Result<(), String> {
    with_state_blocking(app, |state| {
        let mut worker = state.worker.lock();
        worker.shutdown()
    })
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SynthesizeArgs {
    text: String,
    #[serde(default)]
    ref_embed: Option<String>,
    #[serde(default)]
    ref_wav: Option<String>,
    /// Multiple reference WAV paths (v4.1+). Takes precedence over ref_wav when set.
    #[serde(default)]
    ref_wavs: Option<Vec<String>>,
    #[serde(default)]
    caption: Option<String>,
    #[serde(default)]
    no_ref: Option<bool>,
    output_wav: String,
    /// One path per candidate. When set, length should match num_candidates.
    #[serde(default)]
    output_wavs: Option<Vec<String>>,
    num_steps: u32,
    num_candidates: u32,
    seed: Option<i64>,
    seconds: Option<f64>,
    duration_scale: f64,
    t_schedule_mode: String,
    sway_coeff: f64,
    cfg_guidance_mode: String,
    cfg_scale_text: f64,
    #[serde(default)]
    cfg_scale_caption: Option<f64>,
    cfg_scale_speaker: f64,
}

#[tauri::command]
async fn synthesize_line(app: AppHandle, args: SynthesizeArgs) -> Result<Value, String> {
    with_state_blocking(app, move |state| {
        let settings = state.settings.lock().clone();
        synth::synthesize_with_worker(
            &settings,
            &state.worker,
            synth::SynthesizeArgs {
                text: args.text,
                ref_embed: args.ref_embed,
                ref_wav: args.ref_wav,
                ref_wavs: args.ref_wavs,
                caption: args.caption,
                no_ref: args.no_ref,
                output_wav: args.output_wav,
                output_wavs: args.output_wavs,
                num_steps: args.num_steps,
                num_candidates: args.num_candidates,
                seed: args.seed,
                seconds: args.seconds,
                duration_scale: args.duration_scale,
                t_schedule_mode: args.t_schedule_mode,
                sway_coeff: args.sway_coeff,
                cfg_guidance_mode: args.cfg_guidance_mode,
                cfg_scale_text: args.cfg_scale_text,
                cfg_scale_caption: args.cfg_scale_caption,
                cfg_scale_speaker: args.cfg_scale_speaker,
            },
        )
    })
    .await
}

#[tauri::command]
fn save_project_cmd(
    state: tauri::State<'_, AppState>,
    project: project::Project,
) -> Result<String, String> {
    let settings = state.settings.lock().clone();
    project::save_project(&settings.projects_root, &project)
}

#[tauri::command]
fn rename_project_cmd(
    state: tauri::State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let settings = state.settings.lock().clone();
    project::rename_project_dir(&settings.projects_root, &old_name, &new_name)
}

#[tauri::command]
fn load_project_cmd(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<project::Project, String> {
    let settings = state.settings.lock().clone();
    project::load_project(&settings.projects_root, &name)
}

#[tauri::command]
fn list_projects_cmd(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = state.settings.lock().clone();
    project::list_projects(&settings.projects_root)
}

#[tauri::command]
fn delete_project_cmd(state: tauri::State<'_, AppState>, name: String) -> Result<(), String> {
    let settings = state.settings.lock().clone();
    project::delete_project(&settings.projects_root, &name)?;
    let cache = studio_cache_dir()
        .join("gen_cache")
        .join(project::sanitize_name(&name));
    if cache.is_dir() {
        let _ = std::fs::remove_dir_all(&cache);
    }
    Ok(())
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

pub(crate) fn studio_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("irodori-studio")
}

pub fn studio_data_cache_dir() -> PathBuf {
    studio_cache_dir()
}

/// Cache path for a line's trial generation (not a permanent export).
#[tauri::command]
fn line_cache_wav_path(
    project_name: String,
    line_id: String,
    variant_id: Option<String>,
) -> Result<String, String> {
    let dir = studio_cache_dir()
        .join("gen_cache")
        .join(project::sanitize_name(&project_name));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Some(vid) = variant_id.filter(|s| !s.trim().is_empty()) {
        let variant_dir = dir.join(&line_id);
        std::fs::create_dir_all(&variant_dir).map_err(|e| e.to_string())?;
        Ok(variant_dir
            .join(format!("{vid}.wav"))
            .display()
            .to_string())
    } else {
        Ok(dir.join(format!("{line_id}.wav")).display().to_string())
    }
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_file(src: String, dest: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dest)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExportAudioFormat {
    Wav,
    Mp3,
    Opus,
    Flac,
    M4b,
}

impl ExportAudioFormat {
    fn from_label(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "mp3" => Self::Mp3,
            "opus" | "ogg" => Self::Opus,
            "flac" => Self::Flac,
            "m4b" | "m4a" => Self::M4b,
            _ => Self::Wav,
        }
    }

    fn from_dest(dest: &str) -> Option<Self> {
        let ext = std::path::Path::new(dest)
            .extension()
            .and_then(|e| e.to_str())?
            .to_ascii_lowercase();
        match ext.as_str() {
            "wav" => Some(Self::Wav),
            "mp3" => Some(Self::Mp3),
            "opus" | "ogg" => Some(Self::Opus),
            "flac" => Some(Self::Flac),
            "m4b" | "m4a" => Some(Self::M4b),
            _ => None,
        }
    }

    fn ext(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Mp3 => "mp3",
            Self::Opus => "opus",
            Self::Flac => "flac",
            Self::M4b => "m4b",
        }
    }
}

fn resolve_export_format(explicit: Option<&str>, dest: &str) -> ExportAudioFormat {
    if let Some(from_dest) = ExportAudioFormat::from_dest(dest) {
        return from_dest;
    }
    if let Some(s) = explicit {
        return ExportAudioFormat::from_label(s);
    }
    ExportAudioFormat::Wav
}

pub(crate) fn ensure_audio_ext(dest: &str, format: ExportAudioFormat) -> String {
    if ExportAudioFormat::from_dest(dest).is_some() {
        return dest.to_string();
    }
    format!("{}.{}", dest.trim_end_matches('.'), format.ext())
}

fn ffmpeg_codec_args(
    format: ExportAudioFormat,
    bitrate_kbps: Option<u32>,
    settings: &AppSettings,
) -> Vec<String> {
    match format {
        ExportAudioFormat::Wav => Vec::new(),
        ExportAudioFormat::Mp3 => {
            let br = settings::normalize_mp3_bitrate_kbps(
                bitrate_kbps.unwrap_or(settings.export_mp3_bitrate_kbps),
            );
            vec![
                "-c:a".into(),
                "libmp3lame".into(),
                "-b:a".into(),
                format!("{br}k"),
            ]
        }
        ExportAudioFormat::Opus => {
            let br = settings::normalize_opus_bitrate_kbps(
                bitrate_kbps.unwrap_or(settings.export_opus_bitrate_kbps),
            );
            vec![
                "-c:a".into(),
                "libopus".into(),
                "-b:a".into(),
                format!("{br}k"),
                "-application".into(),
                "audio".into(),
            ]
        }
        ExportAudioFormat::Flac => {
            vec!["-c:a".into(), "flac".into()]
        }
        ExportAudioFormat::M4b => {
            let br = settings::normalize_mp3_bitrate_kbps(
                bitrate_kbps.unwrap_or(settings.export_mp3_bitrate_kbps),
            );
            vec![
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                format!("{br}k"),
                "-f".into(),
                "mp4".into(),
            ]
        }
    }
}

fn run_ffmpeg_export(
    settings: &AppSettings,
    src: &str,
    dest: &str,
    af: Option<&str>,
    codec_args: &[String],
) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let ffmpeg = resolve_ffmpeg(settings).ok_or_else(|| MISSING_FFMPEG_MSG.to_string())?;
    let mut cmd = std::process::Command::new(ffmpeg);
    crate::python_env::hide_console(&mut cmd);
    cmd.args(["-y", "-i", src]);
    if let Some(filter) = af {
        if !filter.is_empty() {
            cmd.args(["-af", filter]);
        }
    }
    for a in codec_args {
        cmd.arg(a);
    }
    cmd.arg(dest);
    let status = cmd.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("ffmpeg failed: {status}"));
    }
    Ok(())
}

fn run_ffmpeg_af(
    settings: &AppSettings,
    src: &str,
    dest: &str,
    filter: &str,
) -> Result<(), String> {
    run_ffmpeg_export(settings, src, dest, Some(filter), &[])
}

fn run_ffmpeg_cmd(
    settings: &AppSettings,
    args: &[String],
    cwd: Option<&std::path::Path>,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg(settings).ok_or_else(|| MISSING_FFMPEG_MSG.to_string())?;
    let mut cmd = std::process::Command::new(ffmpeg);
    crate::python_env::hide_console(&mut cmd);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.args(args);
    let status = cmd.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("ffmpeg failed: {status}"));
    }
    Ok(())
}

/// Normalize to 48 kHz / mono / s16le so concat demuxer inputs match.
fn ffmpeg_pcm_mono_48k(
    settings: &AppSettings,
    src: &std::path::Path,
    dest: &std::path::Path,
) -> Result<(), String> {
    let src_s = src.display().to_string();
    let dest_s = dest.display().to_string();
    run_ffmpeg_cmd(
        settings,
        &[
            "-y".into(),
            "-i".into(),
            src_s,
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "1".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            dest_s,
        ],
        None,
    )
}

/// Keep numeric targets in sync with `src/lib/audioFx.ts`.
fn build_clip_af(clip: &project::ClipEdit) -> String {
    let clip = clip.clamped();
    if clip.is_identity() {
        return String::new();
    }
    let mut filters: Vec<String> = Vec::new();
    let trim_start = clip.trim_start_sec;
    let trim_end = clip.trim_end_sec;
    if trim_start > 0.001 || trim_end > 0.001 {
        if trim_end > trim_start + 0.001 {
            filters.push(format!("atrim=start={trim_start:.6}:end={trim_end:.6}"));
        } else if trim_start > 0.001 {
            filters.push(format!("atrim=start={trim_start:.6}"));
        }
        filters.push("asetpts=PTS-STARTPTS".into());
    }
    if clip.pre_pad_sec > 0.001 {
        let ms = (clip.pre_pad_sec * 1000.0).round() as u64;
        filters.push(format!("adelay={ms}|{ms}"));
    }
    if clip.post_pad_sec > 0.001 {
        filters.push(format!("apad=pad_dur={:.6}", clip.post_pad_sec));
    }
    if clip.fade_in_sec > 0.001 {
        filters.push(format!("afade=t=in:st=0:d={:.6}", clip.fade_in_sec));
    }
    if clip.fade_out_sec > 0.001 {
        filters.push(format!(
            "areverse,afade=t=in:st=0:d={:.6},areverse",
            clip.fade_out_sec
        ));
    }
    filters.join(",")
}

fn join_af_parts(parts: &[String]) -> String {
    parts
        .iter()
        .filter(|p| !p.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(",")
}

/// Keep numeric targets in sync with `src/lib/audioFx.ts`.
fn build_post_af(
    volume: f64,
    speed: f64,
    fx: &project::AudioFx,
    playback: bool,
) -> String {
    let fx = fx.clamped();
    let speed = speed.clamp(0.5, 2.0);
    let mut filters: Vec<String> = Vec::new();

    if fx.denoise > 0.001 {
        let nr = 4.0 + 16.0 * fx.denoise;
        filters.push(format!("afftdn=nr={nr:.2}:nf=-55"));
    }

    if (speed - 1.0).abs() >= 0.001 {
        filters.push(format!("atempo={speed}"));
    }

    if playback {
        return filters.join(",");
    }

    if fx.highpass > 0.001 {
        let hz = 40.0 + 110.0 * fx.highpass;
        filters.push(format!("highpass=f={hz:.1}:poles=2"));
    }
    if fx.muffle > 0.001 {
        let g = -8.0 * fx.muffle;
        filters.push(format!("lowshelf=f=320:t=q:w=0.7:g={g:.2}"));
    }
    if fx.clarity > 0.001 {
        let g = 6.0 * fx.clarity;
        filters.push(format!("equalizer=f=3200:t=q:w=1.1:g={g:.2}"));
    }
    if fx.air > 0.001 {
        let g = 5.0 * fx.air;
        filters.push(format!("highshelf=f=9000:t=q:w=0.7:g={g:.2}"));
    }
    if fx.deesser > 0.001 {
        let i = 0.12 + 0.75 * fx.deesser;
        let m = 0.25 + 0.6 * fx.deesser;
        filters.push(format!("deesser=i={i:.3}:m={m:.3}:f=0.5:s=o"));
    }
    if fx.flatten > 0.001 {
        let thr_db = -6.0 - 18.0 * fx.flatten;
        let thr_lin = 10f64.powf(thr_db / 20.0);
        let ratio = 1.0 + 11.0 * fx.flatten;
        let makeup = 8.0 * fx.flatten * (0.45 + 0.55 * fx.flatten);
        filters.push(format!(
            "acompressor=threshold={thr_lin:.5}:ratio={ratio:.2}:attack=4:release=120:makeup={makeup:.2}:knee=6"
        ));
    }
    if (volume - 1.0).abs() >= 0.001 {
        filters.push(format!("volume={volume}"));
    }
    let may_boost =
        volume > 1.001 || fx.clarity > 0.001 || fx.air > 0.001 || fx.flatten > 0.001;
    if may_boost {
        filters.push("alimiter=limit=0.99:attack=5:release=50".into());
    }

    filters.join(",")
}

/// Export audio applying volume + speed + post-FX via ffmpeg.
pub(crate) fn export_wav_adjusted_inner(
    settings: &AppSettings,
    src: String,
    dest: String,
    volume: f64,
    speed: f64,
    audio_fx: &project::AudioFx,
    format: ExportAudioFormat,
    bitrate_kbps: Option<u32>,
    clip_edit: Option<&project::ClipEdit>,
) -> Result<(), String> {
    let dest = ensure_audio_ext(&dest, format);
    let vol_ok = (volume - 1.0).abs() < 0.001;
    let spd_ok = (speed - 1.0).abs() < 0.001;
    let clip = clip_edit.map(|c| c.clamped()).filter(|c| !c.is_identity());
    if vol_ok && spd_ok && audio_fx.is_identity() && clip.is_none() && format == ExportAudioFormat::Wav {
        return copy_file(src, dest);
    }

    let post = build_post_af(volume, speed, audio_fx, false);
    let clip_af = clip.as_ref().map(build_clip_af).unwrap_or_default();
    let af = join_af_parts(&[clip_af, post]);
    let af = if af.is_empty() { None } else { Some(af) };
    run_ffmpeg_export(
        settings,
        &src,
        &dest,
        af.as_deref(),
        &ffmpeg_codec_args(format, bitrate_kbps, settings),
    )
}

#[tauri::command]
fn export_wav_adjusted(
    state: tauri::State<'_, AppState>,
    src: String,
    dest: String,
    volume: f64,
    speed: f64,
    audio_fx: Option<project::AudioFx>,
    clip_edit: Option<project::ClipEdit>,
    format: Option<String>,
    bitrate_kbps: Option<u32>,
) -> Result<(), String> {
    let settings = state.settings.lock().clone();
    let fmt = resolve_export_format(format.as_deref(), &dest);
    let fx = audio_fx.unwrap_or_default();
    let clip = clip_edit.as_ref();
    export_wav_adjusted_inner(&settings, src, dest, volume, speed, &fx, fmt, bitrate_kbps, clip)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WavExportSeg {
    pub src: String,
    pub volume: f64,
    pub speed: f64,
    #[serde(default)]
    pub audio_fx: project::AudioFx,
    #[serde(default)]
    pub clip_edit: Option<project::ClipEdit>,
}

/// Concatenate adjusted audio with optional silence between segments.
#[tauri::command]
fn export_wavs_concatenated(
    state: tauri::State<'_, AppState>,
    segments: Vec<WavExportSeg>,
    silence_secs: f64,
    dest: String,
    format: Option<String>,
    bitrate_kbps: Option<u32>,
) -> Result<(), String> {
    let settings = state.settings.lock().clone();
    export_wavs_concatenated_inner(
        &settings,
        segments,
        silence_secs,
        dest,
        format,
        bitrate_kbps,
    )
}

pub(crate) fn export_wavs_concatenated_inner(
    settings: &AppSettings,
    segments: Vec<WavExportSeg>,
    silence_secs: f64,
    dest: String,
    format: Option<String>,
    bitrate_kbps: Option<u32>,
) -> Result<(), String> {
    if segments.is_empty() {
        return Err("連結する音声がありません".into());
    }

    let fmt = resolve_export_format(format.as_deref(), &dest);
    let dest = ensure_audio_ext(&dest, fmt);
    let codec_args = ffmpeg_codec_args(fmt, bitrate_kbps, settings);

    let tmp_dir = studio_cache_dir()
        .join("export_batch")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let cleanup = |dir: &std::path::Path| {
        let _ = std::fs::remove_dir_all(dir);
    };

    // Windows CreateProcess fails with os error 206 when the filter_complex /
    // argv with hundreds of -i paths exceeds ~32k chars. Normalize each file
    // with a short command, then concat via a list file (one -i).
    let mut seg_names: Vec<String> = Vec::with_capacity(segments.len());
    for (i, seg) in segments.iter().enumerate() {
        let adj = tmp_dir.join(format!("adj_{i:04}.wav"));
        let pcm_name = format!("seg_{i:04}.wav");
        let pcm = tmp_dir.join(&pcm_name);
        if let Err(e) = export_wav_adjusted_inner(
            settings,
            seg.src.clone(),
            adj.display().to_string(),
            seg.volume,
            seg.speed,
            &seg.audio_fx,
            ExportAudioFormat::Wav,
            None,
            seg.clip_edit.as_ref(),
        ) {
            cleanup(&tmp_dir);
            return Err(e);
        }
        if let Err(e) = ffmpeg_pcm_mono_48k(settings, &adj, &pcm) {
            cleanup(&tmp_dir);
            return Err(e);
        }
        let _ = std::fs::remove_file(&adj);
        seg_names.push(pcm_name);
    }

    if seg_names.len() == 1 {
        let src = tmp_dir.join(&seg_names[0]).display().to_string();
        let result = if fmt == ExportAudioFormat::Wav {
            copy_file(src, dest)
        } else {
            run_ffmpeg_export(settings, &src, &dest, None, &codec_args)
        };
        cleanup(&tmp_dir);
        return result;
    }

    let silence_secs = silence_secs.max(0.0);
    let insert_silence = silence_secs > 0.001;

    if insert_silence {
        let silence_s = format!("{silence_secs:.3}");
        if let Err(e) = run_ffmpeg_cmd(
            settings,
            &[
                "-y".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "anullsrc=r=48000:cl=mono".into(),
                "-t".into(),
                silence_s,
                "-c:a".into(),
                "pcm_s16le".into(),
                "silence.wav".into(),
            ],
            Some(&tmp_dir),
        ) {
            cleanup(&tmp_dir);
            return Err(e);
        }
    }

    let mut list = String::new();
    for (i, name) in seg_names.iter().enumerate() {
        list.push_str(&format!("file '{name}'\n"));
        if insert_silence && i + 1 < seg_names.len() {
            list.push_str("file 'silence.wav'\n");
        }
    }
    let list_path = tmp_dir.join("concat.txt");
    if let Err(e) = std::fs::write(&list_path, list) {
        cleanup(&tmp_dir);
        return Err(e.to_string());
    }

    if let Some(parent) = std::path::Path::new(&dest).parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            cleanup(&tmp_dir);
            return Err(e.to_string());
        }
    }

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        "concat.txt".into(),
    ];
    if fmt == ExportAudioFormat::Wav {
        args.push("-c:a".into());
        args.push("pcm_s16le".into());
    } else {
        args.extend(codec_args.iter().cloned());
    }
    args.push(dest.clone());

    let result = run_ffmpeg_cmd(settings, &args, Some(&tmp_dir)).map_err(|e| {
        if e.contains("os error 206") {
            format!("連結に失敗しました（パスまたはコマンドが長すぎます）: {e}")
        } else {
            format!("ffmpeg concat failed: {e}")
        }
    });
    cleanup(&tmp_dir);
    result
}

/// Pitch-preserving speed + denoise into a temp file for playback (EQ left to WebAudio).
#[tauri::command]
fn prepare_playback_wav(
    state: tauri::State<'_, AppState>,
    src: String,
    speed: f64,
    denoise: Option<f64>,
    clip_edit: Option<project::ClipEdit>,
) -> Result<String, String> {
    let settings = state.settings.lock().clone();
    let speed = speed.clamp(0.5, 2.0);
    let denoise = denoise.unwrap_or(0.0);
    let mut fx = project::AudioFx::default();
    fx.denoise = denoise;
    let clip = clip_edit.map(|c| c.clamped()).filter(|c| !c.is_identity());
    if (speed - 1.0).abs() < 0.001 && fx.denoise.abs() < 0.001 && clip.is_none() {
        return Ok(src);
    }
    let dest = studio_cache_dir()
        .join("playback")
        .join(format!("play_{}.wav", uuid::Uuid::new_v4()));
    let post = build_post_af(1.0, speed, &fx, true);
    let clip_af = clip.as_ref().map(build_clip_af).unwrap_or_default();
    let af = join_af_parts(&[clip_af, post]);
    run_ffmpeg_af(&settings, &src, &dest.display().to_string(), &af)?;
    Ok(dest.display().to_string())
}

/// Trim a reference WAV to [start_sec, end_sec) and write a new file (original kept).
#[tauri::command]
fn trim_ref_wav(
    state: tauri::State<'_, AppState>,
    src: String,
    dest: Option<String>,
    start_sec: f64,
    end_sec: f64,
) -> Result<String, String> {
    let settings = state.settings.lock().clone();
    let start = start_sec.max(0.0);
    let end = end_sec.max(0.0);
    if end <= start + 0.01 {
        return Err("終了位置は開始位置より後にしてください".into());
    }
    let dest = dest.unwrap_or_else(|| {
        let p = std::path::Path::new(&src);
        let stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("trim");
        let parent = p.parent().unwrap_or_else(|| std::path::Path::new("."));
        parent
            .join(format!("{stem}_trim_{:.0}ms_{:.0}ms.wav", start * 1000.0, end * 1000.0))
            .display()
            .to_string()
    });
    let af = format!("atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS");
    run_ffmpeg_af(&settings, &src, &dest, &af)?;
    Ok(dest)
}

#[tauri::command]
fn resolve_python_path(state: tauri::State<'_, AppState>) -> Option<String> {
    let settings = state.settings.lock().clone();
    settings::resolve_python_exe(&settings).map(|p| p.display().to_string())
}

#[tauri::command]
fn get_dictionaries() -> dictionary::Dictionaries {
    dictionary::load_dictionaries()
}

#[tauri::command]
fn set_dictionaries(dicts: dictionary::Dictionaries) -> Result<dictionary::Dictionaries, String> {
    dictionary::save_dictionaries(&dicts)?;
    Ok(dicts)
}

fn homograph_extras(dicts: &dictionary::Dictionaries) -> Vec<asr::HomographExtra> {
    let mut out: Vec<asr::HomographExtra> = dicts
        .reading
        .iter()
        .filter(|e| e.enabled && e.kind == "heteronym" && !e.surface.is_empty())
        .map(|e| asr::HomographExtra {
            surface: e.surface.clone(),
            note: None,
            readings: dictionary::split_readings(&e.reading),
        })
        .collect();
    // Pre-migration leftover user homograph rows
    for e in &dicts.homograph {
        if !e.enabled || e.surface.is_empty() {
            continue;
        }
        if out.iter().any(|x| x.surface == e.surface) {
            continue;
        }
        out.push(asr::HomographExtra {
            surface: e.surface.clone(),
            note: e
                .note
                .as_ref()
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty()),
            readings: dictionary::split_readings(&e.readings),
        });
    }
    out
}

fn reading_payloads(dicts: &dictionary::Dictionaries) -> Vec<asr::ReadingDictPayload> {
    dicts
        .reading
        .iter()
        .filter(|e| e.enabled && !e.surface.is_empty())
        .map(|e| asr::ReadingDictPayload {
            kind: e.kind.clone(),
            surface: e.surface.clone(),
            reading: e.reading.clone(),
        })
        .collect()
}

#[tauri::command]
fn prepare_synth_text_cmd(
    state: tauri::State<'_, AppState>,
    text: String,
    manual_readings: Option<Vec<project::AppliedReading>>,
) -> Result<String, String> {
    let settings = state.settings.lock().clone();
    dictionary::prepare_synth_text(&settings, &text, &manual_readings.unwrap_or_default())
}

#[tauri::command]
fn auto_readings_cmd(
    state: tauri::State<'_, AppState>,
    text: String,
    manual_readings: Option<Vec<project::AppliedReading>>,
) -> Result<Vec<dictionary::ReadingSpan>, String> {
    let settings = state.settings.lock().clone();
    let replaced = dictionary::apply_dict_replacements(&text);
    let dicts = dictionary::load_dictionaries();
    let reading_dict = reading_payloads(&dicts);
    let manual = manual_readings.unwrap_or_default();
    let manual_json: Vec<serde_json::Value> = manual
        .iter()
        .map(|r| {
            serde_json::json!({
                "start": r.start,
                "end": r.end,
                "surface": r.surface,
                "reading": r.reading,
            })
        })
        .collect();
    let payload = serde_json::json!({
        "text": replaced,
        "manualReadings": manual_json,
        "readingDict": reading_dict,
    });
    let v = asr::run_python_json_script(&settings, "auto_readings_apply.py", &payload)?;
    let items = v.get("readings").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for item in items {
        let start = item.get("start").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
        let end = item.get("end").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
        let reading = item
            .get("reading")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if reading.is_empty() || start >= end {
            continue;
        }
        out.push(dictionary::ReadingSpan {
            kind: item
                .get("kind")
                .and_then(|x| x.as_str())
                .unwrap_or("english")
                .to_string(),
            start,
            end,
            surface: item
                .get("surface")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            reading,
        });
    }
    Ok(out)
}

#[tauri::command]
fn detect_homographs_cmd(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<Vec<asr::HomographHit>, String> {
    let settings = state.settings.lock().clone();
    let dicts = dictionary::load_dictionaries();
    asr::detect_homographs(&settings, &text, &homograph_extras(&dicts))
}

#[tauri::command]
fn detect_annotations_cmd(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<Vec<asr::DetectedAnnotation>, String> {
    let settings = state.settings.lock().clone();
    let dicts = dictionary::load_dictionaries();
    asr::detect_annotations(
        &settings,
        &text,
        &homograph_extras(&dicts),
        &reading_payloads(&dicts),
    )
}

#[tauri::command]
async fn verify_line_asr(
    app: AppHandle,
    wav_path: String,
    expected_text: String,
) -> Result<asr::AsrVerifyResult, String> {
    with_state_blocking(app, move |state| {
        let settings = state.settings.lock().clone();
        let mut asr = state.asr_worker.lock();
        asr::verify_wav_asr(&settings, &mut asr, &wav_path, &expected_text)
    })
    .await
}

#[tauri::command]
async fn ensure_asr_model_cmd(app: AppHandle) -> Result<String, String> {
    with_state_blocking(app, |state| {
        let settings = state.settings.lock().clone();
        let mut asr = state.asr_worker.lock();
        let dir = asr.ensure_loaded(&settings)?;
        Ok(dir.display().to_string())
    })
    .await
}

#[tauri::command]
async fn transcribe_pcm_asr_cmd(
    app: AppHandle,
    samples: Vec<i16>,
    sample_rate: u32,
) -> Result<String, String> {
    with_state_blocking(app, move |state| {
        let settings = state.settings.lock().clone();
        let mut asr = state.asr_worker.lock();
        asr::transcribe_pcm_asr(&settings, &mut asr, &samples, sample_rate)
    })
    .await
}

/// Return WAV duration in seconds (via ffprobe or WAV header).
#[tauri::command]
fn wav_duration_secs(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<f64, String> {
    let settings = state.settings.lock().clone();
    probe_wav_duration(&settings, &path)
}

pub(crate) fn probe_wav_duration(settings: &AppSettings, path: &str) -> Result<f64, String> {
    // Prefer bundled ffprobe (beside bundled ffmpeg)
    if let Some(ffprobe) = resolve_ffprobe(settings) {
        let mut cmd = std::process::Command::new(ffprobe);
        crate::python_env::hide_console(&mut cmd);
        let output = cmd
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Ok(v) = s.parse::<f64>() {
                return Ok(v);
            }
        }
    }
    // Fallback: parse WAV header
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    if data.len() < 44 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err("WAV の長さを取得できません".into());
    }
    let channels = u16::from_le_bytes([data[22], data[23]]) as f64;
    let sample_rate = u32::from_le_bytes([data[24], data[25], data[26], data[27]]) as f64;
    let bits = u16::from_le_bytes([data[34], data[35]]) as f64;
    // Find data chunk
    let mut i = 12usize;
    while i + 8 <= data.len() {
        let id = &data[i..i + 4];
        let size = u32::from_le_bytes([data[i + 4], data[i + 5], data[i + 6], data[i + 7]]) as usize;
        if id == b"data" {
            let bytes_per_sec = sample_rate * channels * (bits / 8.0);
            if bytes_per_sec <= 0.0 {
                return Err("invalid WAV format".into());
            }
            return Ok(size as f64 / bytes_per_sec);
        }
        i += 8 + size;
        if size % 2 == 1 {
            i += 1;
        }
    }
    Err("WAV data chunk が見つかりません".into())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = load_settings();
    let state = AppState {
        settings: Mutex::new(settings),
        worker: Mutex::new(OptWorkerSimple::default()),
        asr_worker: Mutex::new(asr::AsrWorker::default()),
        train: Arc::new(TrainState::default()),
        http: Mutex::new(http_server::HttpServerHandle::default()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(state)
        .manage(native_asr::NativeAsrAppState::default())
        .manage(native_output::NativeOutputState::default())
        .setup(|app| {
            match init_studio_resource_paths(app.handle()) {
                Ok(dir) => {
                    eprintln!(
                        "[irodori-studio] studio python dir: {}",
                        dir.display()
                    );
                }
                Err(e) => {
                    eprintln!("[irodori-studio] WARNING: {e}");
                }
            }
            let settings = app.state::<AppState>().settings.lock().clone();
            if settings.http_server_enabled {
                if let Err(e) = app
                    .state::<AppState>()
                    .http
                    .lock()
                    .start(app.handle(), &settings)
                {
                    eprintln!("[irodori-studio] HTTP server start failed: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            http_server_status,
            regenerate_http_token,
            validate_paths,
            infer_engine_paths,
            needs_first_setup_cmd,
            list_speakers,
            upsert_speaker_profile_cmd,
            update_speaker_meta_cmd,
            delete_speaker_profile_cmd,
            delete_speaker_cmd,
            rename_speaker_cmd,
            start_training,
            cancel_training,
            is_training,
            get_train_resume,
            clear_train_resume,
            load_slice_review_metrics_cmd,
            load_slice_review_exclusions_cmd,
            load_slice_review_log_cmd,
            save_slice_review_exclusions_cmd,
            complete_slice_review_cmd,
            save_diarization_cmd,
            load_diarization_cmd,
            load_slice_autofix_log_cmd,
            run_slice_autofix_cmd,
            list_vocal_separator_models,
            blend_embeddings,
            suggest_katakana,
            ensure_worker,
            ping_worker,
            worker_status,
            unload_worker,
            shutdown_worker,
            synthesize_line,
            save_project_cmd,
            rename_project_cmd,
            load_project_cmd,
            list_projects_cmd,
            delete_project_cmd,
            read_file_bytes,
            file_exists,
            line_cache_wav_path,
            delete_file,
            copy_file,
            export_wav_adjusted,
            export_wavs_concatenated,
            prepare_playback_wav,
            trim_ref_wav,
            prepare_synth_text_cmd,
            auto_readings_cmd,
            resolve_python_path,
            get_dictionaries,
            set_dictionaries,
            detect_homographs_cmd,
            detect_annotations_cmd,
            verify_line_asr,
            ensure_asr_model_cmd,
            transcribe_pcm_asr_cmd,
            native_asr::commands::native_asr_get_model_status,
            native_asr::commands::native_asr_download_models,
            native_asr::commands::native_asr_preload,
            native_asr::commands::native_asr_start,
            native_asr::commands::native_asr_stop,
            native_asr::commands::native_asr_set_paused,
            native_asr::commands::native_asr_list_devices,
            native_asr::commands::native_asr_get_config,
            native_asr::commands::native_asr_set_config,
            native_output::native_audio_list_outputs,
            native_output::native_audio_play_path,
            native_output::native_audio_set_volume,
            native_output::native_audio_stop,
            wav_duration_secs,
            write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
