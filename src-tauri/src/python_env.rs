//! Ensure the configured Irodori Python has pip + optional packages.

use crate::settings::{resolve_python_exe, AppSettings};
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub fn resolve_python(settings: &AppSettings) -> Result<PathBuf, String> {
    resolve_python_exe(settings).ok_or_else(|| {
        format!("Python が見つかりません: {}", settings.python_exe())
    })
}

fn python_ok(python: &PathBuf, code: &str) -> bool {
    Command::new(python)
        .args(["-c", code])
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Bootstrap pip via ensurepip when `python -m pip` is missing (common on bare venvs).
pub fn ensure_pip(python: &PathBuf) -> Result<(), String> {
    if python_ok(python, "import pip; print('ok')") {
        return Ok(());
    }

    let output = Command::new(python)
        .args(["-m", "ensurepip", "--upgrade"])
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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

    let output = Command::new(python)
        .args(&args)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
