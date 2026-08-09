//! ASR helpers: faster-whisper (CPU) + kana CER verify.

use crate::python_env::{ensure_asr_python_deps, resolve_python};
use crate::settings::{studio_python_dir, AppSettings};
use serde::Deserialize;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

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
                self.reap_if_dead();
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
                    self.reap_if_dead();
                    return Err("ASR worker timed out".into());
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    self.reap_if_dead();
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

    pub fn shutdown(&mut self) {
        if self.stdin.is_some() {
            let _ = self.request(
                serde_json::json!({ "cmd": "shutdown" }),
                std::time::Duration::from_secs(5),
            );
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.stdin = None;
        self.lines_rx = None;
        self.loaded_model_dir = None;
        self.script_mtime_secs = None;
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
