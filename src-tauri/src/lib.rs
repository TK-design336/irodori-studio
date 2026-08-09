mod asr;
mod dictionary;
mod project;
mod python_env;
mod settings;
mod speakers;
mod train;
mod worker;

use parking_lot::Mutex;
use serde_json::{json, Value};
use settings::{load_settings, save_settings, studio_python_dir, validate_settings, AppSettings, PathValidation};
use speakers::{SpeakerInfo, UpsertSpeakerProfileArgs};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
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
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> AppSettings {
    state.settings.lock().clone()
}

#[tauri::command]
fn set_settings(
    state: tauri::State<'_, AppState>,
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    settings.export_filename_parts =
        settings::normalize_export_filename_parts(settings.export_filename_parts);
    let prev = state.settings.lock().clone();
    save_settings(&settings)?;
    if prev.engine_identity_changed(&settings) {
        // Version / root / checkpoint change → drop loaded OPT runtime.
        let _ = state.worker.lock().shutdown();
    }
    *state.settings.lock() = settings.clone();
    Ok(settings)
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
    speakers::upsert_speaker_profile(settings.outputs_root(), args)
}

#[tauri::command]
fn delete_speaker_profile_cmd(profile_path: String) -> Result<(), String> {
    speakers::delete_speaker_profile(&profile_path)
}

#[tauri::command]
fn start_training(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    input_dir: String,
    speaker_name: String,
    input_mode: Option<String>,
    speed: Option<f64>,
    job_dir: Option<String>,
) -> Result<(), String> {
    let settings = state.settings.lock().clone();
    start_train_job(
        app,
        settings,
        input_dir,
        speaker_name,
        input_mode.unwrap_or_else(|| "raw".into()),
        speed.unwrap_or(1.0),
        job_dir,
        state.train.clone(),
    )
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

#[tauri::command]
fn blend_embeddings(
    state: tauri::State<'_, AppState>,
    embed_a: String,
    embed_b: String,
    alpha: f64,
    output_name: String,
) -> Result<String, String> {
    let settings = state.settings.lock().clone();
    run_blend(&settings, &embed_a, &embed_b, alpha, &output_name)
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
fn ensure_worker(state: tauri::State<'_, AppState>) -> Result<Value, String> {
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
}

#[tauri::command]
fn ping_worker(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let settings = state.settings.lock().clone();
    let python_dir = studio_python_dir()?;
    let mut worker = state.worker.lock();
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
            // Auto-restart + reload.
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
}

#[tauri::command]
fn worker_status(state: tauri::State<'_, AppState>) -> Value {
    let mut worker = state.worker.lock();
    worker.reap_if_dead();
    json!({
        "running": worker.is_running(),
        "loaded": worker.is_loaded(),
    })
}

#[tauri::command]
fn unload_worker(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let mut worker = state.worker.lock();
    if worker.is_running() {
        worker.unload()
    } else {
        Ok(json!({"ok": true, "status": "not_running"}))
    }
}

#[tauri::command]
fn shutdown_worker(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut worker = state.worker.lock();
    worker.shutdown()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SynthesizeArgs {
    text: String,
    #[serde(default)]
    ref_embed: Option<String>,
    #[serde(default)]
    ref_wav: Option<String>,
    #[serde(default)]
    caption: Option<String>,
    #[serde(default)]
    no_ref: Option<bool>,
    output_wav: String,
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
fn synthesize_line(
    state: tauri::State<'_, AppState>,
    args: SynthesizeArgs,
) -> Result<Value, String> {
    let settings = state.settings.lock().clone();
    let python_dir = studio_python_dir()?;
    let mut worker = state.worker.lock();
    let _ = worker.ensure_alive();
    worker.start(&settings, &python_dir)?;
    if !worker.is_loaded() {
        let resp = worker.load(&settings)?;
        if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(format!("load failed: {resp}"));
        }
    }

    let ref_embed = args
        .ref_embed
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let ref_wav = args
        .ref_wav
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let caption = args
        .caption
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let no_ref = args.no_ref.unwrap_or(false)
        || (caption.is_some() && ref_embed.is_none() && ref_wav.is_none());

    if ref_embed.is_none() && ref_wav.is_none() && !no_ref {
        return Err("話者の埋め込み・参照音源・キャプションのいずれかを指定してください".into());
    }

    let mut payload = json!({
        "text": args.text,
        "output_wav": args.output_wav,
        "num_steps": args.num_steps,
        "num_candidates": args.num_candidates,
        "duration_scale": args.duration_scale,
        "t_schedule_mode": args.t_schedule_mode,
        "sway_coeff": args.sway_coeff,
        "cfg_guidance_mode": args.cfg_guidance_mode,
        "cfg_scale_text": args.cfg_scale_text,
        "cfg_scale_caption": args.cfg_scale_caption.unwrap_or(3.0),
        "cfg_scale_speaker": args.cfg_scale_speaker,
        "no_ref": no_ref,
        "context_kv_cache": true,
    });
    if let Some(ref embed) = ref_embed {
        payload["ref_embed"] = json!(embed);
    }
    if let Some(ref wav) = ref_wav {
        payload["ref_wav"] = json!(wav);
    }
    if let Some(ref cap) = caption {
        payload["caption"] = json!(cap);
    }
    if let Some(seed) = args.seed {
        payload["seed"] = json!(seed);
    }
    if let Some(seconds) = args.seconds {
        payload["seconds"] = json!(seconds);
    }

    let try_once = |w: &mut OptWorkerSimple, p: Value| -> Result<Value, String> {
        let resp = w.synthesize(p)?;
        if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("synthesize failed")
                .to_string());
        }
        Ok(resp)
    };

    match try_once(&mut worker, payload.clone()) {
        Ok(resp) => Ok(resp),
        Err(first_err) => {
            // One automatic restart + retry (worker may have died mid-request).
            let _ = worker.shutdown();
            worker.start(&settings, &python_dir)?;
            let load_resp = worker.load(&settings)?;
            if load_resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                return Err(format!(
                    "再起動後のロードに失敗: {load_resp}（初回エラー: {first_err}）"
                ));
            }
            try_once(&mut worker, payload).map_err(|e| {
                format!("再試行も失敗: {e}（初回エラー: {first_err}）")
            })
        }
    }
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
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

fn studio_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("irodori-studio")
}

/// Cache path for a line's trial generation (not a permanent export).
#[tauri::command]
fn line_cache_wav_path(project_name: String, line_id: String) -> Result<String, String> {
    let dir = studio_cache_dir()
        .join("gen_cache")
        .join(project::sanitize_name(&project_name));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{line_id}.wav")).display().to_string())
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

fn run_ffmpeg_af(src: &str, dest: &str, filter: &str) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let ffmpeg = which::which("ffmpeg").map_err(|_| "ffmpeg が PATH にありません".to_string())?;
    let status = std::process::Command::new(ffmpeg)
        .args(["-y", "-i", src, "-af", filter, dest])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("ffmpeg failed: {status}"));
    }
    Ok(())
}

/// Export WAV applying volume + speed (atempo, pitch-preserving) via ffmpeg.
#[tauri::command]
fn export_wav_adjusted(
    src: String,
    dest: String,
    volume: f64,
    speed: f64,
) -> Result<(), String> {
    let vol_ok = (volume - 1.0).abs() < 0.001;
    let spd_ok = (speed - 1.0).abs() < 0.001;
    if vol_ok && spd_ok {
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
    run_ffmpeg_af(&src, &dest, &filters.join(","))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WavExportSeg {
    src: String,
    volume: f64,
    speed: f64,
}

/// Concatenate adjusted WAVs with optional silence between segments.
#[tauri::command]
fn export_wavs_concatenated(
    segments: Vec<WavExportSeg>,
    silence_secs: f64,
    dest: String,
) -> Result<(), String> {
    if segments.is_empty() {
        return Err("連結する音声がありません".into());
    }

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
        if let Err(e) = export_wav_adjusted(
            seg.src.clone(),
            path.display().to_string(),
            seg.volume,
            seg.speed,
        ) {
            cleanup(&tmp_dir);
            return Err(e);
        }
        seg_paths.push(path);
    }

    if seg_paths.len() == 1 {
        let result = copy_file(seg_paths[0].display().to_string(), dest);
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

    let ffmpeg = match which::which("ffmpeg") {
        Ok(p) => p,
        Err(_) => {
            cleanup(&tmp_dir);
            return Err("ffmpeg が PATH にありません".into());
        }
    };

    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.arg("-y");
    for p in &seg_paths {
        cmd.arg("-i").arg(p);
    }
    cmd.args(["-filter_complex", &filter, "-map", "[out]", &dest]);

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
fn prepare_playback_wav(src: String, speed: f64) -> Result<String, String> {
    let speed = speed.clamp(0.5, 2.0);
    if (speed - 1.0).abs() < 0.001 {
        return Ok(src);
    }
    let dest = studio_cache_dir()
        .join("playback")
        .join(format!("play_{}.wav", uuid::Uuid::new_v4()));
    run_ffmpeg_af(&src, &dest.display().to_string(), &format!("atempo={speed}"))?;
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

#[tauri::command]
fn detect_homographs_cmd(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<Vec<asr::HomographHit>, String> {
    let settings = state.settings.lock().clone();
    let dicts = dictionary::load_dictionaries();
    let extras: Vec<asr::HomographExtra> = dicts
        .homograph
        .iter()
        .filter(|e| e.enabled && !e.surface.is_empty())
        .map(|e| asr::HomographExtra {
            surface: e.surface.clone(),
            note: e
                .note
                .as_ref()
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty()),
        })
        .collect();
    asr::detect_homographs(&settings, &text, &extras)
}

#[tauri::command]
fn verify_line_asr(
    state: tauri::State<'_, AppState>,
    wav_path: String,
    expected_text: String,
) -> Result<asr::AsrVerifyResult, String> {
    let settings = state.settings.lock().clone();
    let mut asr = state.asr_worker.lock();
    asr::verify_wav_asr(&settings, &mut asr, &wav_path, &expected_text)
}

#[tauri::command]
fn ensure_asr_model_cmd(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let settings = state.settings.lock().clone();
    let mut asr = state.asr_worker.lock();
    let dir = asr.ensure_loaded(&settings)?;
    Ok(dir.display().to_string())
}

/// Return WAV duration in seconds (via ffprobe or WAV header).
#[tauri::command]
fn wav_duration_secs(path: String) -> Result<f64, String> {
    // Prefer ffprobe
    if let Ok(ffprobe) = which::which("ffprobe") {
        let output = std::process::Command::new(ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                &path,
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
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
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
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            validate_paths,
            list_speakers,
            upsert_speaker_profile_cmd,
            delete_speaker_profile_cmd,
            start_training,
            cancel_training,
            is_training,
            get_train_resume,
            clear_train_resume,
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
            read_file_bytes,
            file_exists,
            line_cache_wav_path,
            copy_file,
            export_wav_adjusted,
            export_wavs_concatenated,
            prepare_playback_wav,
            resolve_python_path,
            get_dictionaries,
            set_dictionaries,
            detect_homographs_cmd,
            verify_line_asr,
            ensure_asr_model_cmd,
            wav_duration_secs,
            write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
