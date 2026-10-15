//! OPT worker process (stdio JSON-RPC).
use crate::settings::{apply_ffmpeg_env, resolve_python_exe, AppSettings};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

pub struct OptWorkerSimple {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    lines_rx: Option<std::sync::mpsc::Receiver<String>>,
    loaded: bool,
    meanflow: bool,
    default_num_steps: u32,
}

impl Default for OptWorkerSimple {
    fn default() -> Self {
        Self {
            child: None,
            stdin: None,
            lines_rx: None,
            loaded: false,
            meanflow: false,
            default_num_steps: 40,
        }
    }
}

impl OptWorkerSimple {
    pub fn is_running(&self) -> bool {
        self.child.is_some()
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    pub fn is_meanflow(&self) -> bool {
        self.meanflow
    }

    pub fn default_num_steps(&self) -> u32 {
        if self.default_num_steps == 0 {
            if self.meanflow { 4 } else { 40 }
        } else {
            self.default_num_steps
        }
    }

    fn remember_load(&mut self, resp: &Value) {
        self.loaded = true;
        self.meanflow = resp.get("meanflow").and_then(|v| v.as_bool()).unwrap_or(false);
        self.default_num_steps = resp
            .get("default_num_steps")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .filter(|n| *n > 0)
            .unwrap_or(if self.meanflow { 4 } else { 40 });
    }

    fn clear_loaded(&mut self) {
        self.loaded = false;
        self.meanflow = false;
        self.default_num_steps = 40;
    }

    pub fn reap_if_dead(&mut self) {
        let dead = self
            .child
            .as_mut()
            .map(|c| c.try_wait().ok().flatten().is_some())
            .unwrap_or(false);
        if dead {
            self.child = None;
            self.stdin = None;
            self.lines_rx = None;
            self.clear_loaded();
        }
    }

    pub fn start(
        &mut self,
        settings: &AppSettings,
        python_dir: &PathBuf,
    ) -> Result<(), String> {
        self.reap_if_dead();
        if self.child.is_some() {
            return Ok(());
        }
        let worker_script = python_dir.join("opt_worker.py");
        if !worker_script.is_file() {
            return Err(format!(
                "opt_worker.py not found: {}",
                worker_script.display()
            ));
        }

        let python = resolve_python_exe(settings).ok_or_else(|| {
            format!(
                "Python が見つかりません。設定の pythonExe（現在: {}）か PATH の python を確認してください",
                settings.python_exe()
            )
        })?;

        let irodori_root = settings.irodori_root();
        let mut child_cmd = Command::new(&python);
        child_cmd
            .arg("-u")
            .arg(&worker_script)
            .current_dir(irodori_root)
            .env("IRODORI_ROOT", irodori_root)
            .env("PYTHONPATH", irodori_root)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            // Keep stdout JSON-only: HF/tqdm progress must not pollute the RPC pipe.
            .env("HF_HUB_DISABLE_PROGRESS_BARS", "1")
            .env("TQDM_DISABLE", "1")
            .env("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        apply_ffmpeg_env(&mut child_cmd, settings);
        crate::python_env::hide_console(&mut child_cmd);
        let mut child = child_cmd
            .spawn()
            .map_err(|e| format!("failed to start opt worker ({python:?}): {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        crate::python_env::drain_child_stderr(stderr, "opt_worker:stderr");
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
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
        self.loaded = false;

        let ready = self.read_response(Duration::from_secs(120))?;
        if ready.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(format!("worker failed to start: {ready}"));
        }
        Ok(())
    }

    fn read_response(&mut self, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.reap_if_dead();
                return Err(
                    "worker response wait failed: timed out（プロセスが落ちた可能性があります。再読込してください）"
                        .into(),
                );
            }
            let recv_result = {
                let rx = self.lines_rx.as_ref().ok_or("worker not running")?;
                rx.recv_timeout(remaining)
            };
            match recv_result {
                Ok(line) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(trimmed) {
                        Ok(v) => return Ok(v),
                        Err(e) => {
                            // Libraries (HF hub, transformers, …) sometimes leak
                            // progress/debug text onto stdout. Skip until a real RPC line.
                            eprintln!(
                                "[opt_worker] skip non-json stdout ({e}): {}",
                                trimmed.chars().take(160).collect::<String>()
                            );
                            continue;
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    self.reap_if_dead();
                    return Err(
                        "worker response wait failed: timed out（プロセスが落ちた可能性があります。再読込してください）"
                            .into(),
                    );
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    self.reap_if_dead();
                    return Err(
                        "worker response wait failed: disconnected（プロセスが落ちた可能性があります。再読込してください）"
                            .into(),
                    );
                }
            }
        }
    }

    fn request(&mut self, payload: Value, timeout: Duration) -> Result<Value, String> {
        self.reap_if_dead();
        let stdin = self.stdin.as_mut().ok_or("worker not running")?;
        let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        if let Err(e) = writeln!(stdin, "{line}").and_then(|_| stdin.flush()) {
            self.reap_if_dead();
            return Err(format!("worker write failed: {e}"));
        }
        self.read_response(timeout)
    }
}

pub fn load_failure_message(resp: &Value) -> String {
    let err = resp
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if err == "このチェックポイントには、いまの Irodori では対応していません"
        || err.to_ascii_lowercase().contains("meanflow")
    {
        "このチェックポイントには、いまの Irodori では対応していません".into()
    } else if err.is_empty() {
        format!("load failed: {resp}")
    } else {
        err.to_string()
    }
}

impl OptWorkerSimple {
    pub fn load(&mut self, settings: &AppSettings) -> Result<Value, String> {
        let resp = self.request(
            json!({
                "cmd": "load",
                "checkpoint": settings.checkpoint_path(),
                "model_device": settings.model_device,
                "model_precision": settings.model_precision,
                "codec_device": settings.codec_device,
                "codec_precision": settings.codec_precision,
            }),
            Duration::from_secs(900),
        )?;
        if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            self.remember_load(&resp);
        }
        Ok(resp)
    }

    /// Encode reference WAVs to latent files. `false` means this Irodori has no encode API.
    pub fn encode_refs(&mut self, wavs: &[String], outs: &[String]) -> Result<bool, String> {
        let resp = self.request(
            json!({
                "cmd": "encode_refs",
                "wavs": wavs,
                "outs": outs,
            }),
            Duration::from_secs(180),
        )?;
        Ok(resp.get("ok").and_then(|v| v.as_bool()) == Some(true))
    }

    pub fn synthesize(&mut self, mut payload: Value) -> Result<Value, String> {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("cmd".into(), json!("synthesize"));
        }
        self.request(payload, Duration::from_secs(900))
    }

    pub fn ping(&mut self) -> Result<Value, String> {
        self.reap_if_dead();
        if self.child.is_none() {
            return Err("worker not running".into());
        }
        self.request(json!({"cmd": "ping"}), Duration::from_secs(5))
    }

    /// Ping the worker; on failure shut down so the next start() recreates it.
    pub fn ensure_alive(&mut self) -> Result<bool, String> {
        self.reap_if_dead();
        if self.child.is_none() {
            return Ok(false);
        }
        match self.ping() {
            Ok(resp) if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) => Ok(true),
            Ok(_) | Err(_) => {
                let _ = self.shutdown();
                Ok(false)
            }
        }
    }

    pub fn unload(&mut self) -> Result<Value, String> {
        let resp = self.request(json!({"cmd": "unload"}), Duration::from_secs(180))?;
        self.clear_loaded();
        Ok(resp)
    }

    pub fn shutdown(&mut self) -> Result<(), String> {
        if self.stdin.is_some() {
            let _ = self.request(json!({"cmd": "shutdown"}), Duration::from_secs(30));
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.stdin = None;
        self.lines_rx = None;
        self.clear_loaded();
        Ok(())
    }
}
