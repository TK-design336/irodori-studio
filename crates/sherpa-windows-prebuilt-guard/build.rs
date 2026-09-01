//! Runs as a **build-dependency** of `app`, therefore **before** `sherpa-onnx-sys`'s build script.
//! Removes only incomplete prebuilt extract trees. Does **not** delete `sherpa-onnx-sys` Cargo build
//! dirs here — that raced with parallel `rustc` and caused os error 3 on `.d` writes.
//! For stale cache / LNK1181: `cargo clean -p sherpa-onnx-sys` or set `SHERPA_RESET_BUILD_CACHE=1`.
//!
//! Keep `SHERPA_VERSION` in sync with `sherpa-onnx` / `sherpa-onnx-sys` in `src-tauri/Cargo.toml`.

#[cfg(windows)]
const SHERPA_VERSION: &str = "1.12.39";

#[cfg(windows)]
fn target_dir_from_out_dir(out_dir: &std::path::Path) -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("CARGO_TARGET_DIR") {
        return std::path::PathBuf::from(dir);
    }
    out_dir
        .ancestors()
        .find(|p| p.file_name() == Some(std::ffi::OsStr::new("target")))
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| out_dir.to_path_buf())
}

#[cfg(windows)]
fn main() {
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let target_dir = target_dir_from_out_dir(&out_dir);
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".into());

    let archive_stem = format!("sherpa-onnx-v{SHERPA_VERSION}-win-x64-shared-MT-Release-lib");
    let extracted = target_dir.join("sherpa-onnx-prebuilt").join(&archive_stem);
    let import_lib = extracted.join("lib").join("sherpa-onnx-c-api.lib");

    if import_lib.is_file() {
        return;
    }

    if extracted.is_dir() {
        let _ = std::fs::remove_dir_all(&extracted);
    }

    if std::env::var_os("SHERPA_RESET_BUILD_CACHE").is_some() {
        let build_dir = target_dir.join(&profile).join("build");
        if build_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&build_dir) {
                for e in entries.flatten() {
                    if e
                        .file_name()
                        .to_string_lossy()
                        .starts_with("sherpa-onnx-sys-")
                    {
                        let _ = std::fs::remove_dir_all(e.path());
                    }
                }
            }
        }
    }

    // Leftover from experiments with `static` feature — drop extracted tree only (keep .tar.bz2).
    let static_extracted = target_dir.join("sherpa-onnx-prebuilt").join(format!(
        "sherpa-onnx-v{SHERPA_VERSION}-win-x64-static-MT-Release-lib"
    ));
    if static_extracted.is_dir() {
        let _ = std::fs::remove_dir_all(&static_extracted);
    }

    eprintln!(
        "cargo:warning=sherpa-windows-prebuilt-guard: missing {}. If linking fails (LNK1181), run `cargo clean -p sherpa-onnx-sys` from src-tauri, or rebuild with SHERPA_RESET_BUILD_CACHE=1.",
        import_lib.display()
    );
}

#[cfg(not(windows))]
fn main() {}
