use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerInfo {
    pub name: String,
    /// Unique id: `.speaker.safetensors` path, or `_profiles/*.json` path.
    pub embed_path: String,
    /// `"trained" | "blend" | "ref" | "caption"`
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_wav: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerProfile {
    pub name: String,
    /// `"ref" | "caption"`
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_wav: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSpeakerProfileArgs {
    /// Existing profile path when renaming/editing; empty = create.
    #[serde(default)]
    pub profile_path: Option<String>,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub ref_wav: Option<String>,
    #[serde(default)]
    pub caption: Option<String>,
}

fn sanitize_speaker_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if r#"<>:"/\|?*"#.contains(ch) || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().to_string();
    if trimmed.is_empty() {
        "speaker".into()
    } else {
        trimmed
    }
}

fn profiles_dir(outputs_root: &str) -> PathBuf {
    PathBuf::from(outputs_root).join("_profiles")
}

fn profile_path_for(outputs_root: &str, name: &str) -> PathBuf {
    profiles_dir(outputs_root).join(format!("{}.json", sanitize_speaker_name(name)))
}

/// Speaker folders only: `checkpoint_final.speaker.safetensors` (+ `_blends/*.speaker.safetensors`)
/// plus `_profiles/*.json` for zero-shot ref / VoiceDesign caption speakers.
pub fn scan_speakers(outputs_root: &str) -> Result<Vec<SpeakerInfo>, String> {
    let root = Path::new(outputs_root);
    if !root.is_dir() {
        return Ok(vec![]);
    }

    let mut speakers = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "_blends" || name == "_profiles" {
            continue;
        }
        let final_embed = path.join("checkpoint_final.speaker.safetensors");
        if final_embed.is_file() {
            speakers.push(SpeakerInfo {
                name,
                embed_path: final_embed.display().to_string(),
                kind: "trained".into(),
                ref_wav: None,
                caption: None,
            });
        }
    }

    let blends = PathBuf::from(outputs_root).join("_blends");
    if blends.is_dir() {
        if let Ok(files) = fs::read_dir(&blends) {
            for f in files.flatten() {
                let fp = f.path();
                let fname = fp.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if fname.ends_with(".speaker.safetensors") {
                    let label = fname
                        .trim_end_matches(".speaker.safetensors")
                        .to_string();
                    speakers.push(SpeakerInfo {
                        name: label,
                        embed_path: fp.display().to_string(),
                        kind: "blend".into(),
                        ref_wav: None,
                        caption: None,
                    });
                }
            }
        }
    }

    let profiles = profiles_dir(outputs_root);
    if profiles.is_dir() {
        if let Ok(files) = fs::read_dir(&profiles) {
            for f in files.flatten() {
                let fp = f.path();
                let fname = fp.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if !fname.ends_with(".json") {
                    continue;
                }
                let text = match fs::read_to_string(&fp) {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let profile: SpeakerProfile = match serde_json::from_str(&text) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let kind = profile.kind.trim().to_lowercase();
                if kind != "ref" && kind != "caption" {
                    continue;
                }
                speakers.push(SpeakerInfo {
                    name: profile.name,
                    embed_path: fp.display().to_string(),
                    kind,
                    ref_wav: profile.ref_wav,
                    caption: profile.caption,
                });
            }
        }
    }

    speakers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(speakers)
}

pub fn upsert_speaker_profile(
    outputs_root: &str,
    args: UpsertSpeakerProfileArgs,
) -> Result<SpeakerInfo, String> {
    let name = args.name.trim();
    if name.is_empty() {
        return Err("話者名を入力してください".into());
    }
    let kind = args.kind.trim().to_lowercase();
    if kind != "ref" && kind != "caption" {
        return Err("kind は ref または caption です".into());
    }

    let ref_wav = args
        .ref_wav
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let caption = args
        .caption
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if kind == "ref" {
        let Some(ref wav) = ref_wav else {
            return Err("参照音源のパスを指定してください".into());
        };
        if !Path::new(wav).is_file() {
            return Err(format!("参照音源が見つかりません: {wav}"));
        }
    }
    if kind == "caption" && caption.is_none() {
        return Err("キャプションを入力してください".into());
    }

    let dir = profiles_dir(outputs_root);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let new_path = profile_path_for(outputs_root, name);
    let old_path = args
        .profile_path
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    // Prevent clobbering a different profile when creating / renaming.
    if new_path.is_file() {
        let same_as_old = old_path
            .as_ref()
            .map(|p| {
                fs::canonicalize(p).ok() == fs::canonicalize(&new_path).ok()
                    || p == &new_path
            })
            .unwrap_or(false);
        if !same_as_old {
            return Err(format!(
                "同名のプロファイルが既に存在します: {}",
                sanitize_speaker_name(name)
            ));
        }
    }

    let profile = SpeakerProfile {
        name: name.to_string(),
        kind: kind.clone(),
        ref_wav: if kind == "ref" { ref_wav } else { None },
        caption: if kind == "caption" { caption } else { None },
    };
    let text = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    fs::write(&new_path, text).map_err(|e| e.to_string())?;

    if let Some(old) = old_path {
        if old != new_path && old.is_file() {
            let _ = fs::remove_file(&old);
        }
    }

    Ok(SpeakerInfo {
        name: profile.name,
        embed_path: new_path.display().to_string(),
        kind: profile.kind,
        ref_wav: profile.ref_wav,
        caption: profile.caption,
    })
}

pub fn delete_speaker_profile(profile_path: &str) -> Result<(), String> {
    let path = Path::new(profile_path);
    if !path.is_file() {
        return Err(format!("プロファイルが見つかりません: {profile_path}"));
    }
    // Safety: only delete under a `_profiles` folder.
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if parent != "_profiles" {
        return Err("プロファイル以外のファイルは削除できません".into());
    }
    if path.extension().and_then(|s| s.to_str()) != Some("json") {
        return Err("プロファイル以外のファイルは削除できません".into());
    }
    fs::remove_file(path).map_err(|e| e.to_string())
}
