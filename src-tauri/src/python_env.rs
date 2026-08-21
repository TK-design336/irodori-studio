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

fn python_stdout(python: &PathBuf, code: &str) -> Option<String> {
    let mut cmd = Command::new(python);
    cmd.args(["-c", code])
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
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

fn pip_install(python: &PathBuf, packages: &[&str], extra_args: &[&str]) -> Result<(), String> {
    ensure_pip(python)?;
    let mut args = vec![
        "-m",
        "pip",
        "install",
        "--upgrade-strategy",
        "only-if-needed",
    ];
    args.extend(extra_args.iter().copied());
    args.extend(packages.iter().copied());

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
            packages.join(", "),
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

    pip_install(python, pip_packages, &["--upgrade"])?;

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

fn read_torch_identity(python: &PathBuf) -> Option<(String, String)> {
    // version\tcuda (cuda may be empty / None)
    let raw = python_stdout(
        python,
        "import torch; c=getattr(torch.version,'cuda',None); print(f'{torch.__version__}\\t{c or \"\"}')",
    )?;
    let mut parts = raw.splitn(2, '\t');
    let ver = parts.next()?.trim().to_string();
    let cuda = parts.next().unwrap_or("").trim().to_string();
    if ver.is_empty() {
        None
    } else {
        Some((ver, cuda))
    }
}

fn restore_torch(python: &PathBuf, version: &str, cuda: &str) -> Result<(), String> {
    let pin = format!("torch=={version}");
    eprintln!(
        "[irodori-studio] restoring torch to {version} (cuda={cuda:?}) after audio-separator install"
    );
    if !cuda.is_empty() && cuda != "None" {
        let index = if cuda.starts_with("12") {
            "https://download.pytorch.org/whl/cu121"
        } else if cuda.starts_with("11") {
            "https://download.pytorch.org/whl/cu118"
        } else {
            ""
        };
        if !index.is_empty() {
            let r = pip_install(python, &[&pin], &["--index-url", index]);
            if r.is_ok() {
                return r;
            }
            eprintln!(
                "[irodori-studio] torch restore via {index} failed, trying default index: {r:?}"
            );
        }
    }
    pip_install(python, &[&pin], &[])
}

/// Install `audio-separator` without clobbering the existing torch CUDA build.
/// Tries `[gpu]` first, then plain package. Records torch version before/after.
pub fn ensure_audio_separator(python: &PathBuf) -> Result<(), String> {
    if python_ok(python, "import audio_separator; print('ok')") {
        return Ok(());
    }

    let before = read_torch_identity(python);
    if let Some((ver, cuda)) = &before {
        eprintln!("[irodori-studio] torch before audio-separator: {ver} (cuda={cuda})");
    }

    // Pin torch if known so pip does not upgrade it away.
    let mut install_pkgs: Vec<String> = vec!["audio-separator[gpu]".into()];
    if let Some((ver, _)) = &before {
        install_pkgs.push(format!("torch=={ver}"));
    }
    let pkgs_ref: Vec<&str> = install_pkgs.iter().map(|s| s.as_str()).collect();

    let gpu_result = pip_install(python, &pkgs_ref, &[]);
    if gpu_result.is_err() {
        eprintln!(
            "[irodori-studio] audio-separator[gpu] install failed, falling back to audio-separator: {gpu_result:?}"
        );
        let mut plain: Vec<String> = vec!["audio-separator".into()];
        if let Some((ver, _)) = &before {
            plain.push(format!("torch=={ver}"));
        }
        let plain_ref: Vec<&str> = plain.iter().map(|s| s.as_str()).collect();
        pip_install(python, &plain_ref, &[])?;
    }

    if !python_ok(python, "import audio_separator; print('ok')") {
        return Err(format!(
            "audio-separator の import に失敗しました（{}）",
            python.display()
        ));
    }

    if let Some((before_ver, before_cuda)) = before {
        if let Some((after_ver, after_cuda)) = read_torch_identity(python) {
            if after_ver != before_ver || after_cuda != before_cuda {
                eprintln!(
                    "[irodori-studio] WARNING: torch changed {before_ver}/{before_cuda} → {after_ver}/{after_cuda}; restoring"
                );
                if let Err(e) = restore_torch(python, &before_ver, &before_cuda) {
                    eprintln!("[irodori-studio] WARNING: torch restore failed: {e}");
                    return Err(format!(
                        "audio-separator 導入後に torch が変わり、復元にも失敗しました: {e}"
                    ));
                }
                if let Some((restored, _)) = read_torch_identity(python) {
                    if restored != before_ver {
                        return Err(format!(
                            "torch の復元に失敗しました（期待 {before_ver}、実際 {restored}）"
                        ));
                    }
                }
            }
        }
    }

    Ok(())
}

pub fn ensure_audio_separator_best_effort(python: &PathBuf) {
    if let Err(e) = ensure_audio_separator(python) {
        eprintln!("[irodori-studio] ensure_audio_separator: {e}");
    }
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
