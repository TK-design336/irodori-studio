use crate::settings::{
    apply_ffmpeg_env, resolve_python_exe, studio_python_dir, AppSettings,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainLogEvent {
    pub line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainDoneEvent {
    pub ok: bool,
    pub message: String,
    pub embed_path: Option<String>,
    /// True when the user cancelled mid-run (job may be resumable).
    #[serde(default)]
    pub cancelled: bool,
    /// True when pipeline paused for manual slice review.
    #[serde(default)]
    pub paused_for_review: bool,
    #[serde(default)]
    pub job_dir: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainProgressEvent {
    pub step: u32,
    pub total: u32,
    pub name: String,
    /// 0.0–1.0 progress within the current step.
    pub fraction: f64,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainResumeInfo {
    pub input_dir: String,
    pub speaker_name: String,
    pub input_mode: String,
    pub job_dir: String,
    #[serde(default = "default_train_speed")]
    pub speed: f64,
    #[serde(default)]
    pub vocal_separate: bool,
    #[serde(default = "default_vocal_model")]
    pub vocal_model: String,
    #[serde(default = "default_review_mode")]
    pub review_mode: String,
    /// Waiting for user to finish SliceReviewView.
    #[serde(default)]
    pub paused_for_review: bool,
}

fn default_train_speed() -> f64 {
    1.0
}

fn default_vocal_model() -> String {
    crate::settings::DEFAULT_VOCAL_SEPARATOR_MODEL.into()
}

fn default_review_mode() -> String {
    "manual".into()
}

pub struct TrainState {
    pub running: AtomicBool,
    pub cancel_requested: AtomicBool,
    pub child_pid: Mutex<Option<u32>>,
    pub resume: Mutex<Option<TrainResumeInfo>>,
}

impl Default for TrainState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            cancel_requested: AtomicBool::new(false),
            child_pid: Mutex::new(None),
            resume: Mutex::new(None),
        }
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub fn cancel_train_job(train_state: &TrainState) -> Result<(), String> {
    if !train_state.running.load(Ordering::SeqCst) {
        return Err("学習ジョブは実行中ではありません".into());
    }
    train_state.cancel_requested.store(true, Ordering::SeqCst);
    if let Some(pid) = *train_state.child_pid.lock() {
        kill_process_tree(pid);
    }
    Ok(())
}

pub fn get_resume_info(train_state: &TrainState) -> Option<TrainResumeInfo> {
    train_state.resume.lock().clone()
}

pub fn clear_resume_info(train_state: &TrainState) {
    *train_state.resume.lock() = None;
}

fn parse_step_line(line: &str) -> Option<(u32, u32, String)> {
    let rest = line.strip_prefix("STEP ")?;
    let (nums, name) = rest.split_once(' ')?;
    let (n, m) = nums.split_once('/')?;
    let step = n.parse().ok()?;
    let total = m.parse().ok()?;
    Some((step, total, name.trim().to_string()))
}

fn parse_progress_line(line: &str) -> Option<TrainProgressEvent> {
    let json = line.strip_prefix("PROGRESS\t")?;
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let step = v.get("step")?.as_u64()? as u32;
    let total = v.get("total")?.as_u64()? as u32;
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let fraction = v.get("fraction").and_then(|x| x.as_f64()).unwrap_or(0.0);
    let detail = v
        .get("detail")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Some(TrainProgressEvent {
        step,
        total,
        name,
        fraction: fraction.clamp(0.0, 1.0),
        detail,
    })
}

pub fn start_train_job(
    app: AppHandle,
    settings: AppSettings,
    input_dir: String,
    speaker_name: String,
    // "raw" = convert+slice from media; "sliced" = pre-sliced wav/audio folder.
    input_mode: String,
    speed: f64,
    vocal_separate: bool,
    vocal_model: Option<String>,
    job_dir: Option<String>,
    review_mode: Option<String>,
    train_state: Arc<TrainState>,
) -> Result<(), String> {
    if train_state.running.swap(true, Ordering::SeqCst) {
        return Err("training job already running".into());
    }
    train_state.cancel_requested.store(false, Ordering::SeqCst);
    *train_state.child_pid.lock() = None;

    let python_dir = match studio_python_dir() {
        Ok(d) => d,
        Err(e) => {
            train_state.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let pipeline = python_dir.join("run_train_pipeline.py");
    if !pipeline.is_file() {
        train_state.running.store(false, Ordering::SeqCst);
        return Err(format!("pipeline not found: {}", pipeline.display()));
    }

    let mode = if input_mode.eq_ignore_ascii_case("sliced") {
        "sliced"
    } else {
        "raw"
    };
    let speed = if speed.is_finite() {
        speed.clamp(0.5, 2.0)
    } else {
        1.0
    };
    let vocal_model = vocal_model
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| settings.vocal_separator_model.clone());
    let vocal_model = if vocal_model.trim().is_empty() {
        crate::settings::DEFAULT_VOCAL_SEPARATOR_MODEL.to_string()
    } else {
        vocal_model
    };
    let review_mode = crate::settings::normalize_slice_review_mode(
        review_mode
            .as_deref()
            .unwrap_or(settings.slice_review.mode.as_str()),
    );

    // Seed resume info (job_dir filled when JOB_DIR= is printed, or from arg).
    {
        let mut resume = train_state.resume.lock();
        *resume = Some(TrainResumeInfo {
            input_dir: input_dir.clone(),
            speaker_name: speaker_name.clone(),
            input_mode: mode.to_string(),
            job_dir: job_dir.clone().unwrap_or_default(),
            speed,
            vocal_separate,
            vocal_model: vocal_model.clone(),
            review_mode: review_mode.clone(),
            paused_for_review: false,
        });
    }

    std::thread::spawn(move || {
        let result = (|| -> Result<(Option<String>, bool, Option<String>), String> {
            let python = match resolve_python_exe(&settings) {
                Some(p) => p,
                None => {
                    return Err(format!(
                        "Python が見つかりません: {}",
                        settings.python_exe()
                    ));
                }
            };
            // Slice step needs pydub; latent encode uses soundfile (not torchcodec).
            crate::python_env::ensure_packages_best_effort(
                &python,
                "import pydub",
                &["pydub"],
            );
            crate::python_env::ensure_packages_best_effort(
                &python,
                "import soundfile",
                &["soundfile"],
            );
            if vocal_separate {
                crate::python_env::ensure_audio_separator(&python)?;
            }
            // Slice review metrics deps (best-effort; skip mode may not need them).
            if review_mode != "skip" {
                crate::python_env::ensure_packages_best_effort(
                    &python,
                    "import numpy, scipy, librosa, soundfile, pyloudnorm",
                    &[
                        "numpy",
                        "scipy",
                        "librosa",
                        "soundfile",
                        "pyloudnorm",
                    ],
                );
            }
            let python_str = python.display().to_string();
            let irodori_root = settings.irodori_root().to_string();
            let separator_model_dir = crate::studio_data_cache_dir()
                .join("audio-separator-models");
            let _ = std::fs::create_dir_all(&separator_model_dir);
            let review_model_cache = crate::studio_data_cache_dir().join("slice-review-models");
            let _ = std::fs::create_dir_all(&review_model_cache);
            let asr_dir = crate::asr::asr_model_dir();
            let _ = std::fs::create_dir_all(&asr_dir);

            // Write review config for the Python sidecar.
            let review_cfg_path = {
                let dir = std::env::temp_dir().join("irodori-studio");
                let _ = std::fs::create_dir_all(&dir);
                let p = dir.join(format!(
                    "slice_review_cfg_{}.json",
                    std::process::id()
                ));
                let review = &settings.slice_review;
                let aspects = &review.aspects;
                let th = &review.thresholds;
                let cfg = serde_json::json!({
                    "aspects": {
                        "A": aspects.a, "B": aspects.b, "C": aspects.c, "D": aspects.d,
                        "E": aspects.e, "F": aspects.f, "G": aspects.g, "H": aspects.h,
                        "I": aspects.i, "J": aspects.j,
                    },
                    "thresholds": {
                        "outlierZ": th.outlier_z,
                        "durationZ": th.duration_z,
                        "durationIqrMult": th.duration_iqr_mult,
                        "speedZ": th.speed_z,
                        "centroidZ": th.centroid_z,
                    },
                    "auto": {
                        "removePercent": review.auto_remove_percent.clamp(0.0, 90.0),
                        "keepMax": review.auto_keep_max,
                    }
                });
                std::fs::write(&p, cfg.to_string()).map_err(|e| e.to_string())?;
                p
            };

            let mut cmd = Command::new(&python);
            cmd.arg("-u")
                .arg(&pipeline)
                .arg("--irodori-root")
                .arg(&irodori_root)
                .arg("--python-exe")
                .arg(&python_str)
                .arg("--studio-python-dir")
                .arg(python_dir.display().to_string())
                .arg("--input-dir")
                .arg(&input_dir)
                .arg("--input-mode")
                .arg(mode)
                .arg("--speed")
                .arg(format!("{speed}"))
                .arg("--speaker-name")
                .arg(&speaker_name)
                .arg("--init-checkpoint")
                .arg(settings.checkpoint_path())
                .arg("--config")
                .arg(settings.train_config_rel())
                .arg("--outputs-root")
                .arg(settings.outputs_root())
                .arg("--vocal-model")
                .arg(&vocal_model)
                .arg("--separator-model-dir")
                .arg(separator_model_dir.display().to_string())
                .arg("--review-mode")
                .arg(&review_mode)
                .arg("--review-config-json")
                .arg(review_cfg_path.display().to_string())
                .arg("--review-model-cache-dir")
                .arg(review_model_cache.display().to_string())
                .arg("--asr-model-dir")
                .arg(asr_dir.display().to_string())
                .current_dir(&irodori_root)
                .env("IRODORI_ROOT", &irodori_root)
                .env("PYTHONPATH", &irodori_root)
                .env("PYTHONUNBUFFERED", "1")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if vocal_separate {
                cmd.arg("--vocal-separate");
            }
            apply_ffmpeg_env(&mut cmd, &settings);

            if let Some(ref jd) = job_dir {
                if !jd.trim().is_empty() {
                    cmd.arg("--job-dir").arg(jd);
                }
            }

            #[cfg(windows)]
            {
                // CREATE_NEW_PROCESS_GROUP so cancel can signal the tree; CREATE_NO_WINDOW
                // avoids a console flash that steals focus from the Studio UI.
                const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
                crate::python_env::hide_console_with(&mut cmd, CREATE_NEW_PROCESS_GROUP);
            }
            #[cfg(not(windows))]
            {
                crate::python_env::hide_console(&mut cmd);
            }

            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            let pid = child.id();
            *train_state.child_pid.lock() = Some(pid);

            let stdout = child.stdout.take().ok_or("no stdout")?;
            let stderr = child.stderr.take().ok_or("no stderr")?;

            let app_out = app.clone();
            let resume_state = train_state.clone();
            let out_handle = std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                let mut embed: Option<String> = None;
                let mut review_job: Option<String> = None;
                let mut current_step = TrainProgressEvent {
                    step: 0,
                    total: 5,
                    name: String::new(),
                    fraction: 0.0,
                    detail: None,
                };
                for line in reader.lines().flatten() {
                    if let Some(rest) = line.strip_prefix("EMBED_OK=") {
                        embed = Some(rest.to_string());
                    }
                    if let Some(rest) = line.strip_prefix("REVIEW_READY=") {
                        review_job = Some(rest.to_string());
                        if let Some(info) = resume_state.resume.lock().as_mut() {
                            info.job_dir = rest.to_string();
                            info.paused_for_review = true;
                        }
                    }
                    if let Some(rest) = line
                        .strip_prefix("JOB_DIR=")
                        .or_else(|| line.strip_prefix("RESUME_JOB_DIR="))
                    {
                        if let Some(info) = resume_state.resume.lock().as_mut() {
                            info.job_dir = rest.to_string();
                        }
                    }
                    if let Some((step, total, name)) = parse_step_line(&line) {
                        current_step = TrainProgressEvent {
                            step,
                            total,
                            name: name.clone(),
                            fraction: 0.0,
                            detail: None,
                        };
                        let _ = app_out.emit("train-progress", current_step.clone());
                    }
                    if let Some(mut prog) = parse_progress_line(&line) {
                        if prog.name.is_empty() {
                            prog.name = current_step.name.clone();
                        }
                        if prog.step == 0 {
                            prog.step = current_step.step;
                            prog.total = current_step.total;
                        }
                        current_step = prog.clone();
                        let _ = app_out.emit("train-progress", prog);
                        // Don't spam the log view with PROGRESS lines.
                        continue;
                    }
                    if line.starts_with("PROGRESS\t") {
                        continue;
                    }
                    let _ = app_out.emit("train-log", TrainLogEvent { line });
                }
                (embed, review_job)
            });

            let app_err = app.clone();
            let err_handle = std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    let _ = app_err.emit(
                        "train-log",
                        TrainLogEvent {
                            line: format!("[stderr] {line}"),
                        },
                    );
                }
            });

            let status = child.wait().map_err(|e| e.to_string())?;
            *train_state.child_pid.lock() = None;
            let (embed, review_job) = out_handle.join().ok().unwrap_or((None, None));
            let _ = err_handle.join();

            let cancelled = train_state.cancel_requested.load(Ordering::SeqCst);
            if cancelled {
                return Ok((None, true, None));
            }
            if let Some(jd) = review_job {
                return Ok((None, false, Some(jd)));
            }
            if !status.success() {
                return Err(format!("pipeline exited with {status}"));
            }
            Ok((embed, false, None))
        })();

        train_state.running.store(false, Ordering::SeqCst);
        train_state.cancel_requested.store(false, Ordering::SeqCst);
        *train_state.child_pid.lock() = None;

        match result {
            Ok((embed, cancelled, review_job)) => {
                if cancelled {
                    let _ = app.emit(
                        "train-done",
                        TrainDoneEvent {
                            ok: false,
                            message: "学習を中断しました（完了済みステップから再開できます）".into(),
                            embed_path: None,
                            cancelled: true,
                            paused_for_review: false,
                            job_dir: None,
                        },
                    );
                } else if let Some(jd) = review_job {
                    let _ = app.emit(
                        "train-done",
                        TrainDoneEvent {
                            ok: true,
                            message: "スライスレビュー待ち".into(),
                            embed_path: None,
                            cancelled: false,
                            paused_for_review: true,
                            job_dir: Some(jd),
                        },
                    );
                } else {
                    // Successful finish — clear resume checkpoint.
                    *train_state.resume.lock() = None;
                    let _ = app.emit(
                        "train-done",
                        TrainDoneEvent {
                            ok: true,
                            message: "training finished".into(),
                            embed_path: embed,
                            cancelled: false,
                            paused_for_review: false,
                            job_dir: None,
                        },
                    );
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "train-done",
                    TrainDoneEvent {
                        ok: false,
                        message: e,
                        embed_path: None,
                        cancelled: false,
                        paused_for_review: false,
                        job_dir: None,
                    },
                );
            }
        }
    });

    Ok(())
}

pub fn run_blend(
    settings: &AppSettings,
    embed_a: &str,
    embed_b: &str,
    embed_c: Option<&str>,
    weight_a: f64,
    weight_b: f64,
    weight_c: f64,
    output_name: &str,
) -> Result<String, String> {
    let python_dir = studio_python_dir()?;
    let script = python_dir.join("blend_embeddings.py");
    let out_dir = std::path::Path::new(settings.outputs_root()).join("_blends");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let safe = crate::project::sanitize_name(output_name);
    let out_path = out_dir.join(format!("{safe}.speaker.safetensors"));

    let python = resolve_python_exe(settings).ok_or_else(|| {
        format!("Python が見つかりません: {}", settings.python_exe())
    })?;

    let mut cmd = Command::new(&python);
    cmd.arg("-u")
        .arg(&script)
        .arg("--embed-a")
        .arg(embed_a)
        .arg("--embed-b")
        .arg(embed_b)
        .arg("--weight-a")
        .arg(weight_a.to_string())
        .arg("--weight-b")
        .arg(weight_b.to_string())
        .arg("--weight-c")
        .arg(weight_c.to_string())
        .arg("--output")
        .arg(&out_path);
    if let Some(c) = embed_c.filter(|s| !s.is_empty()) {
        cmd.arg("--embed-c").arg(c);
    }
    cmd.current_dir(settings.irodori_root());
    crate::python_env::hide_console(&mut cmd);
    let status = cmd.status().map_err(|e| e.to_string())?;

    if !status.success() {
        return Err(format!("blend failed: {status}"));
    }
    Ok(out_path.display().to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KatakanaHit {
    pub word: String,
    pub kana: Option<String>,
    pub start: usize,
    pub end: usize,
}

/// Run alkana_suggest.py; returns English-word → katakana candidates.
pub fn run_alkana_suggest(settings: &AppSettings, text: &str) -> Result<Vec<KatakanaHit>, String> {
    crate::python_env::ensure_alkana(settings)?;

    let python_dir = studio_python_dir()?;
    let script = python_dir.join("alkana_suggest.py");
    if !script.is_file() {
        return Err(format!("script missing: {}", script.display()));
    }

    let python = resolve_python_exe(settings).ok_or_else(|| {
        format!("Python が見つかりません: {}", settings.python_exe())
    })?;

    let mut child_cmd = Command::new(&python);
    child_cmd
        .arg("-u")
        .arg(&script)
        .current_dir(settings.irodori_root())
        // Windows CP932 既定だとカタカナ JSON が文字化けするため UTF-8 固定
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::python_env::hide_console(&mut child_cmd);
    let mut child = child_cmd.spawn().map_err(|e| e.to_string())?;

    {
        let stdin = child.stdin.as_mut().ok_or("stdin unavailable")?;
        let payload = serde_json::json!({ "text": text });
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("alkana_suggest failed: {err}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| {
        format!("alkana_suggest JSON parse error: {e}; out={}", stdout.trim())
    })
}

fn slice_review_dir(job_dir: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(job_dir.trim());
    if !p.is_dir() {
        return Err(format!("job dir not found: {}", p.display()));
    }
    Ok(p.join("slice_review"))
}

pub fn load_slice_review_metrics(job_dir: &str) -> Result<serde_json::Value, String> {
    let path = slice_review_dir(job_dir)?.join("metrics.json");
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub fn load_slice_review_exclusions(job_dir: &str) -> Result<serde_json::Value, String> {
    let path = slice_review_dir(job_dir)?.join("exclusions.json");
    if !path.is_file() {
        return Ok(serde_json::json!({}));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub fn load_slice_review_log(job_dir: &str) -> Result<serde_json::Value, String> {
    let path = slice_review_dir(job_dir)?.join("review_log.json");
    if !path.is_file() {
        return Ok(serde_json::json!({}));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub fn save_slice_review_exclusions(
    job_dir: &str,
    exclusions: serde_json::Value,
) -> Result<(), String> {
    let dir = slice_review_dir(job_dir)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("exclusions.json");
    let text = serde_json::to_string_pretty(&exclusions).map_err(|e| e.to_string())?;
    std::fs::write(&path, text + "\n").map_err(|e| e.to_string())?;

    // Also refresh review_log counts for manual sessions.
    let mut by_aspect: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut excluded_count = 0u64;
    if let Some(obj) = exclusions.as_object() {
        for (_k, v) in obj {
            if v.get("excluded").and_then(|x| x.as_bool()).unwrap_or(false) {
                excluded_count += 1;
                if let Some(arr) = v.get("aspects").and_then(|a| a.as_array()) {
                    for a in arr {
                        if let Some(s) = a.as_str() {
                            let n = by_aspect
                                .get(s)
                                .and_then(|x| x.as_u64())
                                .unwrap_or(0)
                                + 1;
                            by_aspect.insert(s.to_string(), serde_json::json!(n));
                        }
                    }
                }
            }
        }
    }
    let log = serde_json::json!({
        "mode": "manual",
        "excludedCount": excluded_count,
        "byAspect": by_aspect,
    });
    let _ = std::fs::write(
        dir.join("review_log.json"),
        serde_json::to_string_pretty(&log).unwrap_or_default() + "\n",
    );
    Ok(())
}

/// Mark review done and invalidate dataset/manifest so they rebuild with exclusions.
pub fn complete_slice_review(job_dir: &str) -> Result<(), String> {
    let root = PathBuf::from(job_dir.trim());
    if !root.is_dir() {
        return Err(format!("job dir not found: {}", root.display()));
    }
    let review_dir = root.join("slice_review");
    std::fs::create_dir_all(&review_dir).map_err(|e| e.to_string())?;
    std::fs::write(root.join(".done_review"), b"").map_err(|e| e.to_string())?;
    // Force dataset + latent rebuild with updated exclusions.
    let _ = std::fs::remove_file(root.join(".done_dataset"));
    let _ = std::fs::remove_file(root.join(".done_prepare_manifest"));
    Ok(())
}
