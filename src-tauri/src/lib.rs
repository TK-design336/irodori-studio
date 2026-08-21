mod asr;
mod dictionary;
mod http_server;
mod project;
mod python_env;
mod settings;
mod speakers;
mod synth;
mod train;
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
    start_train_job, TrainResumeInfo, TrainState,
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
        state.train.clone(),
    )
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
fn complete_slice_review_cmd(job_dir: String) -> Result<(), String> {
    train::complete_slice_review(&job_dir)
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
    run_blend(&settings, &embed_a, &embed_b, c, wa, wb, wc, &output_name)
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

/// Export audio applying volume + speed (atempo, pitch-preserving) via ffmpeg.
pub(crate) fn export_wav_adjusted_inner(
    settings: &AppSettings,
    src: String,
    dest: String,
    volume: f64,
    speed: f64,
    format: ExportAudioFormat,
    bitrate_kbps: Option<u32>,
) -> Result<(), String> {
    let dest = ensure_audio_ext(&dest, format);
    let vol_ok = (volume - 1.0).abs() < 0.001;
    let spd_ok = (speed - 1.0).abs() < 0.001;
    if vol_ok && spd_ok && format == ExportAudioFormat::Wav {
        return copy_file(src, dest);
    }

    let speed = speed.clamp(0.5, 2.0);
    let mut filters = Vec::new();
    if !vol_ok {
        filters.push(format!("volume={volume}"));
    }
    if !spd_ok {
        filters.push(format!("atempo={speed}"));
    }
    let af = if filters.is_empty() {
        None
    } else {
        Some(filters.join(","))
    };
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
    format: Option<String>,
    bitrate_kbps: Option<u32>,
) -> Result<(), String> {
    let settings = state.settings.lock().clone();
    let fmt = resolve_export_format(format.as_deref(), &dest);
    export_wav_adjusted_inner(&settings, src, dest, volume, speed, fmt, bitrate_kbps)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WavExportSeg {
    pub src: String,
    pub volume: f64,
    pub speed: f64,
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

    let mut seg_paths: Vec<PathBuf> = Vec::with_capacity(segments.len());
    for (i, seg) in segments.iter().enumerate() {
        let path = tmp_dir.join(format!("seg_{i:04}.wav"));
        if let Err(e) = export_wav_adjusted_inner(
            settings,
            seg.src.clone(),
            path.display().to_string(),
            seg.volume,
            seg.speed,
            ExportAudioFormat::Wav,
            None,
        ) {
            cleanup(&tmp_dir);
            return Err(e);
        }
        seg_paths.push(path);
    }

    if seg_paths.len() == 1 {
        let src = seg_paths[0].display().to_string();
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
    let n = seg_paths.len();

    let mut filter_parts: Vec<String> = Vec::new();
    let mut concat_labels = String::new();
    for i in 0..n {
        filter_parts.push(format!(
            "[{i}:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono[a{i}]"
        ));
        concat_labels.push_str(&format!("[a{i}]"));
        if insert_silence && i + 1 < n {
            filter_parts.push(format!(
                "anullsrc=r=48000:cl=mono,atrim=0:{silence_secs},aformat=sample_fmts=s16:channel_layouts=mono[s{i}]"
            ));
            concat_labels.push_str(&format!("[s{i}]"));
        }
    }
    let concat_n = if insert_silence { n * 2 - 1 } else { n };
    filter_parts.push(format!(
        "{concat_labels}concat=n={concat_n}:v=0:a=1[out]"
    ));
    let filter = filter_parts.join(";");

    if let Some(parent) = std::path::Path::new(&dest).parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            cleanup(&tmp_dir);
            return Err(e.to_string());
        }
    }

    let ffmpeg = match resolve_ffmpeg(settings) {
        Some(p) => p,
        None => {
            cleanup(&tmp_dir);
            return Err(MISSING_FFMPEG_MSG.into());
        }
    };

    let mut cmd = std::process::Command::new(ffmpeg);
    crate::python_env::hide_console(&mut cmd);
    cmd.arg("-y");
    for p in &seg_paths {
        cmd.arg("-i").arg(p);
    }
    cmd.args(["-filter_complex", &filter, "-map", "[out]"]);
    for a in &codec_args {
        cmd.arg(a);
    }
    cmd.arg(&dest);

    let status = match cmd.status() {
        Ok(s) => s,
        Err(e) => {
            cleanup(&tmp_dir);
            return Err(e.to_string());
        }
    };
    cleanup(&tmp_dir);
    if !status.success() {
        return Err(format!("ffmpeg concat failed: {status}"));
    }
    Ok(())
}

/// Pitch-preserving speed adjust into a temp file for playback (volume left to WebAudio).
#[tauri::command]
fn prepare_playback_wav(
    state: tauri::State<'_, AppState>,
    src: String,
    speed: f64,
) -> Result<String, String> {
    let settings = state.settings.lock().clone();
    let speed = speed.clamp(0.5, 2.0);
    if (speed - 1.0).abs() < 0.001 {
        return Ok(src);
    }
    let dest = studio_cache_dir()
        .join("playback")
        .join(format!("play_{}.wav", uuid::Uuid::new_v4()));
    run_ffmpeg_af(
        &settings,
        &src,
        &dest.display().to_string(),
        &format!("atempo={speed}"),
    )?;
    Ok(dest.display().to_string())
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
            resolve_python_path,
            get_dictionaries,
            set_dictionaries,
            detect_homographs_cmd,
            detect_annotations_cmd,
            verify_line_asr,
            ensure_asr_model_cmd,
            wav_duration_secs,
            write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
