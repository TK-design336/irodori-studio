use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
    /// Primary (or only) reference WAV — kept for back-compat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_wav: Option<String>,
    /// All reference WAV paths (multiple allowed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_wavs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    /// `"female" | "male" | "other"`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    /// `"child" | "teen" | "adult" | "middle" | "senior"`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub age_range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Actor / voice-actor name. Empty on create → same as `name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub real_name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub age_range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub real_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerProfile {
    pub name: String,
    /// `"ref" | "caption"`
    pub kind: String,
    /// Primary (or only) reference WAV — kept for back-compat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_wav: Option<String>,
    /// All reference WAV paths (multiple allowed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_wavs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub age_range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub real_name: Option<String>,
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
    /// All reference WAV paths (multiple allowed).
    #[serde(default)]
    pub ref_wavs: Option<Vec<String>>,
    #[serde(default)]
    pub caption: Option<String>,
    #[serde(default)]
    pub gender: Option<String>,
    #[serde(default)]
    pub age_range: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub real_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSpeakerMetaArgs {
    pub embed_path: String,
    pub kind: String,
    #[serde(default)]
    pub gender: Option<String>,
    #[serde(default)]
    pub age_range: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub real_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSpeakerArgs {
    pub embed_path: String,
    pub kind: String,
    pub name: String,
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

fn same_path_ci(a: &Path, b: &Path) -> bool {
    match (a.to_str(), b.to_str()) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(y),
        _ => a == b,
    }
}

/// Rename a file or directory. Handles Windows case-only changes via a temp name.
fn rename_fs(from: &Path, to: &Path) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    if same_path_ci(from, to) {
        let fname = from
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("rename");
        let tmp = from.with_file_name(format!(".{fname}.__rename_tmp__"));
        if tmp.exists() {
            return Err("一時リネーム先が既に存在します".into());
        }
        fs::rename(from, &tmp).map_err(|e| format!("リネーム失敗: {e}"))?;
        if let Err(e) = fs::rename(&tmp, to) {
            let _ = fs::rename(&tmp, from);
            return Err(format!("リネーム失敗: {e}"));
        }
        return Ok(());
    }
    if to.exists() {
        return Err("同名の話者が既に存在します".into());
    }
    fs::rename(from, to).map_err(|e| format!("リネーム失敗: {e}"))
}

fn find_speaker_by_embed(outputs_root: &str, embed_path: &str) -> Result<SpeakerInfo, String> {
    let want = embed_path.replace('\\', "/").to_lowercase();
    scan_speakers(outputs_root)?
        .into_iter()
        .find(|s| s.embed_path.replace('\\', "/").to_lowercase() == want)
        .ok_or_else(|| "更新後の話者が見つかりません".into())
}

fn profiles_dir(outputs_root: &str) -> PathBuf {
    PathBuf::from(outputs_root).join("_profiles")
}

fn profile_path_for(outputs_root: &str, name: &str) -> PathBuf {
    profiles_dir(outputs_root).join(format!("{}.json", sanitize_speaker_name(name)))
}

fn empty_to_none(s: Option<String>) -> Option<String> {
    s.map(|x| x.trim().to_string()).filter(|x| !x.is_empty())
}

fn normalize_tags(tags: Option<Vec<String>>) -> Option<Vec<String>> {
    let mut seen = HashSet::new();
    let out: Vec<String> = tags
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|s| seen.insert(s.clone()))
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn resolve_real_name(real_name: Option<String>, speaker_name: &str) -> String {
    empty_to_none(real_name).unwrap_or_else(|| speaker_name.trim().to_string())
}

fn normalize_meta(
    gender: Option<String>,
    age_range: Option<String>,
    tags: Option<Vec<String>>,
    real_name: Option<String>,
) -> SpeakerMeta {
    SpeakerMeta {
        gender: empty_to_none(gender),
        age_range: empty_to_none(age_range),
        tags: normalize_tags(tags),
        real_name: empty_to_none(real_name),
    }
}

fn sidecar_meta_path(embed_path: &str, kind: &str) -> Option<PathBuf> {
    let path = Path::new(embed_path);
    match kind {
        "trained" => path.parent().map(|p| p.join("speaker.meta.json")),
        "blend" => {
            let fname = path.file_name()?.to_str()?;
            let label = fname.strip_suffix(".speaker.safetensors")?;
            Some(path.parent()?.join(format!("{label}.meta.json")))
        }
        _ => None,
    }
}

fn load_sidecar_meta(embed_path: &str, kind: &str) -> SpeakerMeta {
    let Some(p) = sidecar_meta_path(embed_path, kind) else {
        return SpeakerMeta::default();
    };
    let Ok(text) = fs::read_to_string(p) else {
        return SpeakerMeta::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_sidecar_meta(embed_path: &str, kind: &str, meta: &SpeakerMeta) -> Result<(), String> {
    let path = sidecar_meta_path(embed_path, kind)
        .ok_or_else(|| format!("メタデータの保存先が特定できません: {kind}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if meta.gender.is_none()
        && meta.age_range.is_none()
        && meta.tags.is_none()
        && meta.real_name.is_none()
    {
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let text = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

fn speaker_info(
    name: String,
    embed_path: String,
    kind: String,
    ref_wav: Option<String>,
    ref_wavs: Option<Vec<String>>,
    caption: Option<String>,
    meta: SpeakerMeta,
) -> SpeakerInfo {
    let real_name = resolve_real_name(meta.real_name, &name);
    let meta = normalize_meta(
        meta.gender,
        meta.age_range,
        meta.tags,
        Some(real_name.clone()),
    );
    SpeakerInfo {
        name,
        embed_path,
        kind,
        ref_wav,
        ref_wavs,
        caption,
        gender: meta.gender,
        age_range: meta.age_range,
        tags: meta.tags,
        real_name: meta.real_name,
    }
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
            let embed_path = final_embed.display().to_string();
            let meta = load_sidecar_meta(&embed_path, "trained");
            speakers.push(speaker_info(
                name,
                embed_path,
                "trained".into(),
                None,
                None,
                None,
                meta,
            ));
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
                    let embed_path = fp.display().to_string();
                    let meta = load_sidecar_meta(&embed_path, "blend");
                    speakers.push(speaker_info(
                        label,
                        embed_path,
                        "blend".into(),
                        None,
                        None,
                        None,
                        meta,
                    ));
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
                // Normalise: build ref_wavs from ref_wav + existing ref_wavs.
                let ref_wavs = {
                    let mut all: Vec<String> = profile
                        .ref_wavs
                        .clone()
                        .unwrap_or_default();
                    if let Some(rw) = &profile.ref_wav {
                        if !rw.is_empty() && !all.contains(rw) {
                            all.insert(0, rw.clone());
                        }
                    }
                    if all.is_empty() { None } else { Some(all) }
                };
                let primary_ref = ref_wavs.as_ref().and_then(|v| v.first().cloned());
                speakers.push(speaker_info(
                    profile.name,
                    fp.display().to_string(),
                    kind,
                    primary_ref,
                    ref_wavs,
                    profile.caption,
                    SpeakerMeta {
                        gender: profile.gender,
                        age_range: profile.age_range,
                        tags: profile.tags,
                        real_name: profile.real_name,
                    },
                ));
            }
        }
    }

    speakers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(speakers)
}

pub fn upsert_speaker_profile(
    outputs_root: &str,
    args: UpsertSpeakerProfileArgs,
    _ffmpeg: Option<PathBuf>,
) -> Result<SpeakerInfo, String> {
    let name = args.name.trim();
    if name.is_empty() {
        return Err("話者名を入力してください".into());
    }
    let kind = args.kind.trim().to_lowercase();
    if kind != "ref" && kind != "caption" {
        return Err("kind は ref または caption です".into());
    }

    let caption = args
        .caption
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Collect all ref wav paths (from ref_wavs list, falling back to single ref_wav).
    let raw_wavs: Vec<String> = {
        let mut list: Vec<String> = args
            .ref_wavs
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        // If ref_wavs is empty, fall back to single ref_wav field.
        if list.is_empty() {
            if let Some(rw) = args.ref_wav.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                list.push(rw);
            }
        }
        list
    };

    if kind == "ref" {
        if raw_wavs.is_empty() {
            return Err("参照音源のパスを指定してください".into());
        }
        for wav in &raw_wavs {
            if !Path::new(wav).is_file() {
                return Err(format!("参照音源が見つかりません: {wav}"));
            }
        }
    }

    // Store paths as-is; opt_worker.py handles format conversion at inference time.
    let prepared_wavs: Option<Vec<String>> = if kind == "ref" && !raw_wavs.is_empty() {
        Some(raw_wavs.clone())
    } else {
        None
    };

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

    let primary_ref = prepared_wavs.as_ref().and_then(|v| v.first().cloned());
    let real_name = resolve_real_name(args.real_name, name);
    let meta = normalize_meta(
        args.gender,
        args.age_range,
        args.tags,
        Some(real_name),
    );
    let profile = SpeakerProfile {
        name: name.to_string(),
        kind: kind.clone(),
        ref_wav: primary_ref.clone(),
        ref_wavs: prepared_wavs.clone(),
        caption: if kind == "caption" { caption.clone() } else { None },
        gender: meta.gender.clone(),
        age_range: meta.age_range.clone(),
        tags: meta.tags.clone(),
        real_name: meta.real_name.clone(),
    };
    let text = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    fs::write(&new_path, text).map_err(|e| e.to_string())?;

    if let Some(old) = old_path {
        if old != new_path && old.is_file() {
            let _ = fs::remove_file(&old);
        }
    }

    Ok(speaker_info(
        profile.name,
        new_path.display().to_string(),
        profile.kind,
        primary_ref,
        prepared_wavs,
        profile.caption,
        meta,
    ))
}

pub fn update_speaker_meta(
    outputs_root: &str,
    args: UpdateSpeakerMetaArgs,
) -> Result<SpeakerInfo, String> {
    let embed_path = args.embed_path.trim();
    if embed_path.is_empty() {
        return Err("話者パスが空です".into());
    }
    let kind = args.kind.trim().to_lowercase();

    match kind.as_str() {
        "ref" | "caption" => {
            let path = Path::new(embed_path);
            if !path.is_file() {
                return Err(format!("プロファイルが見つかりません: {embed_path}"));
            }
            let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
            let mut profile: SpeakerProfile =
                serde_json::from_str(&text).map_err(|e| e.to_string())?;
            let real_name = resolve_real_name(args.real_name, &profile.name);
            let meta = normalize_meta(
                args.gender,
                args.age_range,
                args.tags,
                Some(real_name),
            );
            profile.gender = meta.gender.clone();
            profile.age_range = meta.age_range.clone();
            profile.tags = meta.tags.clone();
            profile.real_name = meta.real_name.clone();
            let out = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
            fs::write(path, out).map_err(|e| e.to_string())?;
        }
        "trained" | "blend" => {
            if !Path::new(embed_path).exists() {
                return Err(format!("話者が見つかりません: {embed_path}"));
            }
            let speaker_name = match kind.as_str() {
                "trained" => Path::new(embed_path)
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string(),
                _ => Path::new(embed_path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .trim_end_matches(".speaker.safetensors")
                    .to_string(),
            };
            let real_name = resolve_real_name(args.real_name, &speaker_name);
            let meta = normalize_meta(
                args.gender,
                args.age_range,
                args.tags,
                Some(real_name),
            );
            save_sidecar_meta(embed_path, &kind, &meta)?;
        }
        _ => return Err(format!("未対応の話者種別: {kind}")),
    }

    find_speaker_by_embed(outputs_root, embed_path)
}

/// Rename a speaker on disk (folder / blend file / profile). Display name follows the path.
pub fn rename_speaker(
    outputs_root: &str,
    args: RenameSpeakerArgs,
) -> Result<SpeakerInfo, String> {
    let embed_path = args.embed_path.trim();
    if embed_path.is_empty() {
        return Err("話者パスが空です".into());
    }
    let kind = args.kind.trim().to_lowercase();
    if args.name.trim().is_empty() {
        return Err("話者名を入力してください".into());
    }
    let safe = sanitize_speaker_name(&args.name);
    if safe == "_blends" || safe == "_profiles" {
        return Err("その名前は予約されています".into());
    }

    match kind.as_str() {
        "ref" | "caption" => {
            let path = Path::new(embed_path);
            if !path.is_file() {
                return Err(format!("プロファイルが見つかりません: {embed_path}"));
            }
            let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
            let profile: SpeakerProfile =
                serde_json::from_str(&text).map_err(|e| e.to_string())?;
            upsert_speaker_profile(
                outputs_root,
                UpsertSpeakerProfileArgs {
                    profile_path: Some(embed_path.to_string()),
                    name: args.name,
                    kind: profile.kind,
                    ref_wav: profile.ref_wav,
                    ref_wavs: profile.ref_wavs,
                    caption: profile.caption,
                    gender: profile.gender,
                    age_range: profile.age_range,
                    tags: profile.tags,
                    real_name: profile.real_name,
                },
                None,
            )
        }
        "trained" => {
            let src_file = Path::new(embed_path);
            if !src_file.is_file() {
                return Err(format!("話者が見つかりません: {embed_path}"));
            }
            if src_file.file_name().and_then(|s| s.to_str())
                != Some("checkpoint_final.speaker.safetensors")
            {
                return Err("埋め込み話者のパスが不正です".into());
            }
            let src_dir = src_file
                .parent()
                .ok_or_else(|| "話者フォルダが特定できません".to_string())?;
            let parent = src_dir
                .parent()
                .ok_or_else(|| "話者フォルダが特定できません".to_string())?;
            let dest_dir = parent.join(&safe);
            if src_dir == dest_dir.as_path() {
                return find_speaker_by_embed(outputs_root, embed_path);
            }
            rename_fs(src_dir, &dest_dir)?;
            let new_embed = dest_dir
                .join("checkpoint_final.speaker.safetensors")
                .display()
                .to_string();
            find_speaker_by_embed(outputs_root, &new_embed)
        }
        "blend" => {
            let src = Path::new(embed_path);
            if !src.is_file() {
                return Err(format!("話者が見つかりません: {embed_path}"));
            }
            let parent = src
                .parent()
                .ok_or_else(|| "ブレンド話者のパスが不正です".to_string())?;
            if parent
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                != "_blends"
            {
                return Err("ブレンド話者のパスが不正です".into());
            }
            let dest = parent.join(format!("{safe}.speaker.safetensors"));
            if src == dest.as_path() {
                return find_speaker_by_embed(outputs_root, embed_path);
            }
            let old_meta = sidecar_meta_path(embed_path, "blend");
            rename_fs(src, &dest)?;
            let new_embed = dest.display().to_string();
            if let Some(old_meta) = old_meta {
                if old_meta.is_file() {
                    if let Some(new_meta) = sidecar_meta_path(&new_embed, "blend") {
                        if let Err(e) = rename_fs(&old_meta, &new_meta) {
                            let _ = rename_fs(&dest, src);
                            return Err(e);
                        }
                    }
                }
            }
            find_speaker_by_embed(outputs_root, &new_embed)
        }
        _ => Err(format!("未対応の話者種別: {kind}")),
    }
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
    trash::delete(path).map_err(|e| e.to_string())
}

/// Delete a speaker by kind — moves to the OS recycle bin/trash.
pub fn delete_speaker(embed_path: &str, kind: &str) -> Result<(), String> {
    let path = Path::new(embed_path);
    if !path.exists() {
        return Err(format!("話者が見つかりません: {embed_path}"));
    }
    match kind {
        "blend" => {
            let parent = path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if parent != "_blends" {
                return Err("ブレンド話者のパスが不正です".into());
            }
            if let Some(meta) = sidecar_meta_path(embed_path, "blend") {
                if meta.is_file() {
                    let _ = trash::delete(&meta);
                }
            }
            trash::delete(path).map_err(|e| e.to_string())
        }
        "trained" => {
            let speaker_dir = path
                .parent()
                .ok_or_else(|| "話者フォルダが特定できません".to_string())?;
            if !speaker_dir.is_dir() {
                return Err("話者フォルダが見つかりません".into());
            }
            trash::delete(speaker_dir).map_err(|e| e.to_string())
        }
        "ref" | "caption" => delete_speaker_profile(embed_path),
        _ => Err(format!("未対応の話者種別: {kind}")),
    }
}
