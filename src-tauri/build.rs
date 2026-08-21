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

    let icon_mtime = std::fs::metadata("icons/icon.ico")
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=IRODORI_APP_ICON_MTIME={icon_mtime}");

    tauri_build::build()
}
