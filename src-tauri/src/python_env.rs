//! Ensure the configured Irodori Python has pip + optional packages.

use crate::settings::{resolve_python_exe, AppSettings};
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Hide the console window on Windows so short-lived python/ffmpeg spawns
/// do not flash a CMD window or steal focus from the UI (e.g. while typing).
pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Like [`hide_console`], but OR-ed with extra Windows creation flags.
pub fn hide_console_with(cmd: &mut Command, extra_flags: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW | extra_flags);
    }
    #[cfg(not(windows))]
    {
        let _ = (cmd, extra_flags);
    }
}

pub fn resolve_python(settings: &AppSettings) -> Result<PathBuf, String> {
    resolve_python_exe(settings).ok_or_else(|| {
        format!("Python が見つかりません: {}", settings.python_exe())
    })
}

fn python_ok(python: &PathBuf, code: &str) -> bool {
    let mut cmd = Command::new(python);
    cmd.args(["-c", code])
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut cmd);
    cmd.status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Bootstrap pip via ensurepip when `python -m pip` is missing (common on bare venvs).
pub fn ensure_pip(python: &PathBuf) -> Result<(), String> {
    if python_ok(python, "import pip; print('ok')") {
        return Ok(());
    }

    let mut cmd = Command::new(python);
    cmd.args(["-m", "ensurepip", "--upgrade"])
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("ensurepip 起動失敗: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "pip の復旧（ensurepip）に失敗しました（{}）: {err} {out}",
            python.display()
        ));
    }

    if !python_ok(python, "import pip; print('ok')") {
        return Err(format!(
            "ensurepip 後も pip が import できません（{}）",
            python.display()
        ));
    }
    Ok(())
}

/// If `import_check` fails, `pip install` the given package name(s).
pub fn ensure_packages(
    python: &PathBuf,
    import_check: &str,
    pip_packages: &[&str],
) -> Result<(), String> {
    if python_ok(python, import_check) {
        return Ok(());
    }

    ensure_pip(python)?;

    let mut args = vec!["-m", "pip", "install", "--upgrade"];
    args.extend(pip_packages.iter().copied());

    let mut cmd = Command::new(python);
    cmd.args(&args)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("pip 起動失敗: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "{} のインストールに失敗しました（{}）: {err} {out}",
            pip_packages.join(", "),
            python.display()
        ));
    }

    if !python_ok(python, import_check) {
        return Err(format!(
            "{} の import に失敗しました（pip 後・{}）",
            pip_packages.join(", "),
            python.display()
        ));
    }
    Ok(())
}

/// Best-effort install; does not fail the caller if install fails.
pub fn ensure_packages_best_effort(
    python: &PathBuf,
    import_check: &str,
    pip_packages: &[&str],
) {
    let _ = ensure_packages(python, import_check, pip_packages);
}

pub fn ensure_alkana(settings: &AppSettings) -> Result<(), String> {
    let python = resolve_python(settings)?;
    ensure_packages(&python, "from alkana import get_kana", &["alkana"])
}

pub fn ensure_asr_python_deps(settings: &AppSettings) -> Result<(), String> {
    let python = resolve_python(settings)?;
    // CPU-only Whisper (ctranslate2). Do not install CUDA builds.
    ensure_packages(&python, "import faster_whisper", &["faster-whisper"])?;
    ensure_packages_best_effort(&python, "import pyopenjtalk", &["pyopenjtalk"]);
    ensure_packages_best_effort(&python, "from alkana import get_kana", &["alkana"]);
    ensure_packages_best_effort(&python, "import soundfile", &["soundfile"]);
    Ok(())
}
