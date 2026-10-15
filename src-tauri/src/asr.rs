//! ASR helpers: faster-whisper (CPU) + kana CER verify.

use crate::python_env::{ensure_asr_python_deps, resolve_python};
use crate::settings::{studio_python_dir, AppSettings};
use serde::Deserialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Cache dir for Whisper weights (downloaded on first load by faster-whisper).
pub fn asr_model_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("irodori-studio")
        .join("asr")
        .join("whisper-small")
}

/// Ensure Python deps + download directory. Model files are fetched on worker `load`.
pub fn ensure_asr_model(settings: &AppSettings) -> Result<PathBuf, String> {
    ensure_asr_python_deps(settings)?;
    let dir = asr_model_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn extract_json_value(stdout: &str) -> Result<serde_json::Value, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err("empty stdout".into());
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return Ok(v);
    }
    // Libraries (e.g. pyopenjtalk) may print download logs before JSON.
    // Prefer the last JSON object / array in the stream.
    for (i, ch) in trimmed.char_indices().rev() {
        if ch == '{' || ch == '[' {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&trimmed[i..]) {
                return Ok(v);
            }
        }
    }
    for (i, ch) in trimmed.char_indices() {
        if ch == '{' || ch == '[' {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&trimmed[i..]) {
                return Ok(v);
            }
        }
    }
    Err(format!("no JSON object found; out={trimmed}"))
}

pub fn run_python_json_script(
    settings: &AppSettings,
    script_name: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    run_python_json(settings, script_name, payload)
}

fn run_python_json(
    settings: &AppSettings,
    script_name: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let python_dir = studio_python_dir()?;
    let script = python_dir.join(script_name);
    if !script.is_file() {
        return Err(format!("script missing: {}", script.display()));
    }
    let python = resolve_python(settings)?;

    let mut child_cmd = Command::new(&python);
    child_cmd
        .arg("-u")
        .arg(&script)
        .current_dir(settings.irodori_root())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::python_env::hide_console(&mut child_cmd);
    let mut child = child_cmd.spawn().map_err(|e| e.to_string())?;

    {
        let stdin = child.stdin.as_mut().ok_or("stdin unavailable")?;
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{script_name} failed: {err}"));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_json_value(&stdout).map_err(|e| {
        format!("{script_name} JSON parse error: {e}")
    })
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomographHit {
    pub surface: String,
    pub start: usize,
    pub end: usize,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomographExtra {
    pub surface: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub readings: Vec<String>,
}

pub fn detect_homographs(
    settings: &AppSettings,
    text: &str,
    extras: &[HomographExtra],
) -> Result<Vec<HomographHit>, String> {
    let payload = serde_json::json!({
        "text": text,
        "extraEntries": extras,
    });
    let v = run_python_json(settings, "homograph_detect.py", &payload)?;
    let hits = v
        .get("hits")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    serde_json::from_value(hits).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationCandidate {
    pub reading: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAnnotation {
    pub kind: String,
    pub start: usize,
    pub end: usize,
    pub surface: String,
    pub candidates: Vec<AnnotationCandidate>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingDictPayload {
    pub kind: String,
    pub surface: String,
    pub reading: String,
}

pub fn detect_annotations(
    settings: &AppSettings,
    text: &str,
    extra_homographs: &[HomographExtra],
    reading_dict: &[ReadingDictPayload],
) -> Result<Vec<DetectedAnnotation>, String> {
    let payload = serde_json::json!({
        "text": text,
        "extraHomographs": extra_homographs,
        "readingDict": reading_dict,
    });
    let v = run_python_json(settings, "annotate_detect.py", &payload)?;
    let annotations = v
        .get("annotations")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    serde_json::from_value(annotations).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrVerifyResult {
    pub ok: bool,
    pub asr_text: String,
    pub expected_kana: String,
    pub actual_kana: String,
    pub cer: f64,
    #[serde(default)]
    pub error: Option<String>,
}

/// Long-lived Python ASR process (model stays loaded).
pub struct AsrWorker {
    child: Option<std::process::Child>,
    stdin: Option<std::process::ChildStdin>,
    lines_rx: Option<std::sync::mpsc::Receiver<String>>,
    loaded_model_dir: Option<String>,
    /// mtime of asr_worker.py when the process was spawned (restart on change)
    script_mtime_secs: Option<u64>,
}

impl Default for AsrWorker {
    fn default() -> Self {
        Self {
            child: None,
            stdin: None,
            lines_rx: None,
            loaded_model_dir: None,
            script_mtime_secs: None,
        }
    }
}

impl AsrWorker {
    fn script_mtime(settings: &AppSettings) -> Option<u64> {
        let _ = settings;
        let python_dir = studio_python_dir().ok()?;
        let script = python_dir.join("asr_worker.py");
        let meta = std::fs::metadata(&script).ok()?;
        let modified = meta.modified().ok()?;
        Some(
            modified
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs(),
        )
    }

    fn restart_if_script_changed(&mut self, settings: &AppSettings) {
        let Some(now) = Self::script_mtime(settings) else {
            return;
        };
        if self.child.is_some() {
            if self.script_mtime_secs != Some(now) {
                self.shutdown();
            }
        }
    }

    fn reap_if_dead(&mut self) {
        let dead = self
            .child
            .as_mut()
            .map(|c| c.try_wait().ok().flatten().is_some())
            .unwrap_or(false);
        if dead {
            self.child = None;
            self.stdin = None;
            self.lines_rx = None;
            self.loaded_model_dir = None;
            self.script_mtime_secs = None;
        }
    }

    fn start(&mut self, settings: &AppSettings) -> Result<(), String> {
        self.reap_if_dead();
        if self.child.is_some() {
            return Ok(());
        }
        let python_dir = studio_python_dir()?;
        let script = python_dir.join("asr_worker.py");
        if !script.is_file() {
            return Err(format!("asr_worker.py not found: {}", script.display()));
        }
        let python = resolve_python(settings)?;

        let mut child_cmd = Command::new(&python);
        child_cmd
            .arg("-u")
            .arg(&script)
            .current_dir(&python_dir)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .env("PYTHONPATH", &python_dir)
            // Never allow Whisper/ctranslate2 to touch the GPU (Irodori owns VRAM).
            .env("CUDA_VISIBLE_DEVICES", "")
            .env("CT2_FORCE_CPU", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::python_env::hide_console(&mut child_cmd);
        let mut child = child_cmd
            .spawn()
            .map_err(|e| format!("failed to start ASR worker: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        crate::python_env::drain_child_stderr(stderr, "asr_worker:stderr");
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        self.child = Some(child);
        self.stdin = Some(stdin);
        self.lines_rx = Some(rx);
        self.loaded_model_dir = None;
        self.script_mtime_secs = Self::script_mtime(settings);

        let ready = self.read_response(std::time::Duration::from_secs(60))?;
        if ready.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(format!("ASR worker failed to start: {ready}"));
        }
        Ok(())
    }

    fn read_response(&mut self, timeout: std::time::Duration) -> Result<serde_json::Value, String> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                self.force_kill();
                return Err("ASR worker timed out".into());
            }
            let recv = {
                let rx = self.lines_rx.as_ref().ok_or("ASR worker not running")?;
                rx.recv_timeout(remaining)
            };
            match recv {
                Ok(line) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<serde_json::Value>(trimmed) {
                        Ok(v) => return Ok(v),
                        Err(_) => continue,
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    self.force_kill();
                    return Err("ASR worker timed out".into());
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    self.force_kill();
                    return Err("ASR worker disconnected".into());
                }
            }
        }
    }

    fn request(
        &mut self,
        payload: serde_json::Value,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, String> {
        self.reap_if_dead();
        let stdin = self.stdin.as_mut().ok_or("ASR worker not running")?;
        let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        use std::io::Write as _;
        if let Err(e) = writeln!(stdin, "{line}").and_then(|_| stdin.flush()) {
            self.reap_if_dead();
            return Err(format!("ASR worker write failed: {e}"));
        }
        self.read_response(timeout)
    }

    pub fn ensure_loaded(&mut self, settings: &AppSettings) -> Result<PathBuf, String> {
        let model_dir = ensure_asr_model(settings)?;
        let dir_s = model_dir.display().to_string();
        // Key includes engine so a previous Reazon worker process is replaced.
        let load_key = format!("whisper-small:{dir_s}");
        self.restart_if_script_changed(settings);
        self.start(settings)?;
        if self.loaded_model_dir.as_deref() == Some(load_key.as_str()) {
            return Ok(model_dir);
        }
        let resp = self.request(
            serde_json::json!({
                "cmd": "load",
                "downloadRoot": dir_s,
                "modelSize": "small",
            }),
            // First run may download ~500MB weights.
            std::time::Duration::from_secs(600),
        )?;
        if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let err = resp
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("load failed");
            return Err(err.to_string());
        }
        self.loaded_model_dir = Some(load_key);
        Ok(model_dir)
    }

    pub fn verify(
        &mut self,
        settings: &AppSettings,
        wav_path: &str,
        expected_text: &str,
    ) -> Result<AsrVerifyResult, String> {
        self.ensure_loaded(settings)?;
        let resp = self.request(
            serde_json::json!({
                "cmd": "verify",
                "wavPath": wav_path,
                "expectedText": expected_text,
            }),
            std::time::Duration::from_secs(180),
        )?;
        if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let err = resp
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("ASR failed")
                .to_string();
            return Ok(AsrVerifyResult {
                ok: false,
                asr_text: String::new(),
                expected_kana: String::new(),
                actual_kana: String::new(),
                cer: 1.0,
                error: Some(err),
            });
        }
        Ok(AsrVerifyResult {
            ok: true,
            asr_text: resp
                .get("asrText")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            expected_kana: resp
                .get("expectedKana")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            actual_kana: resp
                .get("actualKana")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            cer: resp.get("cer").and_then(|x| x.as_f64()).unwrap_or(1.0),
            error: None,
        })
    }

    pub fn transcribe(&mut self, settings: &AppSettings, wav_path: &str) -> Result<String, String> {
        self.ensure_loaded(settings)?;
        let resp = self.request(
            serde_json::json!({
                "cmd": "transcribe",
                "wavPath": wav_path,
            }),
            std::time::Duration::from_secs(120),
        )?;
        if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let err = resp
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("ASR transcribe failed");
            return Err(err.to_string());
        }
        Ok(resp
            .get("text")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string())
    }

    fn force_kill(&mut self) {
        self.stdin = None;
        self.lines_rx = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.loaded_model_dir = None;
        self.script_mtime_secs = None;
    }

    pub fn shutdown(&mut self) {
        if self.stdin.is_some() && self.child.is_some() {
            let _ = self.request(
                serde_json::json!({ "cmd": "shutdown" }),
                Duration::from_secs(2),
            );
        }
        self.force_kill();
    }
}

pub fn verify_wav_asr(
    settings: &AppSettings,
    worker: &mut AsrWorker,
    wav_path: &str,
    expected_text: &str,
) -> Result<AsrVerifyResult, String> {
    worker.verify(settings, wav_path, expected_text)
}

pub fn write_wav_mono_i16(path: &std::path::Path, samples: &[i16], sample_rate: u32) -> Result<(), String> {
    let data_size = samples.len().saturating_mul(2);
    let mut out = Vec::with_capacity(44 + data_size);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_size) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate.saturating_mul(2)).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_size as u32).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, out).map_err(|e| e.to_string())
}

pub fn transcribe_pcm_asr(
    settings: &AppSettings,
    worker: &mut AsrWorker,
    samples: &[i16],
    sample_rate: u32,
) -> Result<String, String> {
    if samples.is_empty() {
        return Ok(String::new());
    }
    let rate = sample_rate.max(8_000).min(48_000);
    let dir = crate::studio_cache_dir().join("live_asr");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("seg_{}.wav", uuid::Uuid::new_v4()));
    write_wav_mono_i16(&path, samples, rate)?;
    let text = worker.transcribe(settings, &path.display().to_string())?;
    let _ = std::fs::remove_file(&path);
    Ok(text)
}

fn audio_import_ext(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".mp3") {
        Some("mp3")
    } else if lower.ends_with(".wav") {
        Some("wav")
    } else {
        None
    }
}

pub fn import_asr_dir() -> Result<PathBuf, String> {
    let dir = crate::studio_cache_dir().join("import_asr");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn path_under_dir(path: &Path, dir: &Path) -> bool {
    let Ok(dir) = dir.canonicalize() else {
        return false;
    };
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    path.starts_with(dir)
}

/// Create an empty cache file to receive imported audio in chunks (avoids huge IPC arrays).
pub fn create_import_audio_temp(file_name: &str) -> Result<String, String> {
    let ext = audio_import_ext(file_name).ok_or_else(|| {
        "対応していない音声形式です（.mp3 .wav）".to_string()
    })?;
    let dir = import_asr_dir()?;
    let path = dir.join(format!("up_{}.{ext}", uuid::Uuid::new_v4()));
    fs::write(&path, b"").map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

pub fn append_import_audio_temp(path: &str, chunk: &[u8]) -> Result<(), String> {
    if chunk.is_empty() {
        return Ok(());
    }
    let path = Path::new(path);
    let dir = import_asr_dir()?;
    if !path_under_dir(path, &dir) {
        return Err("invalid import cache path".into());
    }
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(chunk).map_err(|e| e.to_string())
}

fn convert_to_wav_16k_mono(
    settings: &AppSettings,
    src: &Path,
    dest: &Path,
) -> Result<(), String> {
    let ffmpeg = crate::settings::resolve_ffmpeg(settings)
        .ok_or_else(|| crate::settings::MISSING_FFMPEG_MSG.to_string())?;
    let mut cmd = Command::new(ffmpeg);
    crate::python_env::hide_console(&mut cmd);
    // -nostdin is required: streaming/malformed WAV headers make ffmpeg wait on stdin forever.
    cmd.args([
        "-nostdin",
        "-hide_banner",
        "-y",
        "-i",
        &src.display().to_string(),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        &dest.display().to_string(),
    ]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stderr = child.stderr.take();
    let stderr_join = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(pipe) = stderr {
            let _ = std::io::BufReader::new(pipe).read_to_string(&mut buf);
        }
        buf
    });
    let timeout = Duration::from_secs(120);
    let started = Instant::now();
    let status = loop {
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_join.join();
            return Err("音声の変換がタイムアウトしました".into());
        }
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let err = stderr_join.join().unwrap_or_default();
    if !status.success() {
        let preview: String = err.chars().take(400).collect();
        return Err(format!("音声の変換に失敗しました: {preview}"));
    }
    let meta = fs::metadata(dest).map_err(|_| "音声の変換結果が空です".to_string())?;
    if meta.len() < 44 {
        return Err("音声の変換結果が空です".into());
    }
    Ok(())
}

fn resample_to_16k(samples: &[f32], rate: u32) -> Vec<f32> {
    const TARGET: u32 = 16_000;
    if rate == TARGET || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = f64::from(rate) / f64::from(TARGET);
    let out_len = ((samples.len() as f64) / ratio).round().max(1.0) as usize;
    let last = samples.len().saturating_sub(1);
    (0..out_len)
        .map(|i| {
            let src = i as f64 * ratio;
            let j = (src.floor() as usize).min(last);
            let frac = (src - j as f64) as f32;
            let a = samples[j];
            let b = samples[(j + 1).min(last)];
            a + (b - a) * frac
        })
        .collect()
}

fn read_wav_mono_f32(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let rate = spec.sample_rate;
    if rate == 0 {
        return Err("sample rate 0".into());
    }
    let ch = spec.channels.max(1) as usize;
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
        hound::SampleFormat::Int => {
            let bits = spec.bits_per_sample.clamp(1, 31);
            let denom = (1i64 << (bits - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / denom))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        }
    };
    let mono = if ch <= 1 {
        interleaved
    } else {
        interleaved
            .chunks(ch)
            .map(|frame| frame.iter().sum::<f32>() / ch as f32)
            .collect()
    };
    Ok((mono, rate))
}

/// Decode mp3/wav to 16 kHz mono f32. WAV prefers hound (no ffmpeg / no Python).
pub fn load_import_pcm_16k_mono(
    settings: &AppSettings,
    src: &Path,
    label: &str,
) -> Result<Vec<f32>, String> {
    if !src.is_file() {
        return Err(format!("ファイルが見つかりません: {}", src.display()));
    }
    let ext = audio_import_ext(label)
        .or_else(|| audio_import_ext(&src.display().to_string()))
        .ok_or_else(|| "対応していない音声形式です（.mp3 .wav）".to_string())?;

    if ext == "wav" {
        match read_wav_mono_f32(src) {
            Ok((mono, rate)) => return Ok(resample_to_16k(&mono, rate)),
            Err(e) => eprintln!("[import-asr] WAV header not readable ({e}); using ffmpeg"),
        }
    }

    let dir = import_asr_dir()?;
    let wav = dir.join(format!("src_{}.wav", uuid::Uuid::new_v4()));
    convert_to_wav_16k_mono(settings, src, &wav)?;
    let result = read_wav_mono_f32(&wav).map(|(mono, rate)| resample_to_16k(&mono, rate));
    let _ = fs::remove_file(&wav);
    result
}
