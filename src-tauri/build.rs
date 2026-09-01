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
