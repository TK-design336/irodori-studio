fn main() {
    // Icon files are compiled into the Windows resource and generate_context!().
    // Cargo does not watch them by default, so `tauri dev` can keep the old icon.
    for icon in [
        "icons/icon.ico",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }

    sync_python_scripts();
    sync_windows_runtime_dlls();

    let icon_mtime = std::fs::metadata("icons/icon.ico")
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=IRODORI_APP_ICON_MTIME={icon_mtime}");

    tauri_build::build()
}

fn sync_python_scripts() {
    use std::fs;
    use std::path::PathBuf;

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let src = manifest.join("..").join("python");
    if !src.is_dir() {
        return;
    }

    if let Ok(entries) = fs::read_dir(&src) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("py") {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }

    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    let dest = manifest.join("..").join("target").join(profile).join("python");
    if let Err(e) = fs::create_dir_all(&dest) {
        eprintln!("[build] python sync skipped: {e}");
        return;
    }

    if let Err(e) = copy_python_tree(&src, &dest) {
        eprintln!("[build] python sync failed: {e}");
    }
}

/// Copy sherpa-onnx / ONNX Runtime DLLs so the Windows installer can place them
/// next to the exe. `sherpa-onnx-sys` already copies them into `target/{profile}`
/// for `cargo run`, but Tauri's bundler does not pick those extras up.
fn sync_windows_runtime_dlls() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("windows") {
        return;
    }

    use std::fs;
    use std::path::PathBuf;

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dest = manifest.join("runtime-dlls");
    if let Err(e) = fs::create_dir_all(&dest) {
        eprintln!("[build] runtime-dlls mkdir skipped: {e}");
        return;
    }

    let mut copied = 0usize;
    let prebuilt = manifest.join("target").join("sherpa-onnx-prebuilt");
    if prebuilt.is_dir() {
        if let Ok(entries) = fs::read_dir(&prebuilt) {
            for entry in entries.flatten() {
                let lib = entry.path().join("lib");
                if !lib.is_dir() {
                    continue;
                }
                if let Ok(files) = fs::read_dir(&lib) {
                    for file in files.flatten() {
                        let path = file.path();
                        if path.extension().and_then(|e| e.to_str()) != Some("dll") {
                            continue;
                        }
                        let Some(name) = path.file_name() else {
                            continue;
                        };
                        match fs::copy(&path, dest.join(name)) {
                            Ok(_) => copied += 1,
                            Err(e) => eprintln!(
                                "[build] runtime DLL copy failed {} → {}: {e}",
                                path.display(),
                                dest.join(name).display()
                            ),
                        }
                    }
                }
            }
        }
    }

    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    let profile_dir = manifest.join("target").join(profile);
    for name in [
        "sherpa-onnx-c-api.dll",
        "sherpa-onnx-cxx-api.dll",
        "onnxruntime.dll",
        "onnxruntime_providers_shared.dll",
    ] {
        let src = profile_dir.join(name);
        let dst = dest.join(name);
        if src.is_file() {
            match fs::copy(&src, &dst) {
                Ok(_) => copied += 1,
                Err(e) => {
                    eprintln!("[build] runtime DLL copy failed {} → {}: {e}", src.display(), dst.display())
                }
            }
        }
    }

    if !dest.join("sherpa-onnx-c-api.dll").is_file() {
        println!(
            "cargo:warning=sherpa-onnx-c-api.dll missing in {} (copied {copied}). Windows installer will not include native ASR DLLs.",
            dest.display()
        );
    }
}

fn copy_python_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    use std::fs;
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_python_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else if from.extension().and_then(|e| e.to_str()) == Some("py") {
        fs::copy(from, to)?;
        Ok(())
    } else {
        Ok(())
    }
}
