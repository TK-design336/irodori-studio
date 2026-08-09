use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplingParams {
    pub num_steps: u32,
    pub num_candidates: u32,
    pub seed: Option<i64>,
    pub seconds: Option<f64>,
    pub duration_scale: f64,
    pub t_schedule_mode: String,
    pub sway_coeff: f64,
    pub cfg_guidance_mode: String,
    pub cfg_scale_text: f64,
    pub cfg_scale_speaker: f64,
}

impl Default for SamplingParams {
    fn default() -> Self {
        Self {
            num_steps: 40,
            num_candidates: 1,
            seed: None,
            seconds: None,
            duration_scale: 1.0,
            t_schedule_mode: "linear".into(),
            sway_coeff: -1.0,
            cfg_guidance_mode: "independent".into(),
            cfg_scale_text: 3.0,
            cfg_scale_speaker: 5.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLine {
    pub id: String,
    pub text: String,
    pub speaker_name: String,
    pub speaker_embed_path: String,
    pub sampling: SamplingParams,
    pub wav_path: Option<String>,
    #[serde(default)]
    pub generated_text: Option<String>,
    #[serde(default)]
    pub generated_speaker_embed_path: Option<String>,
    /// Snapshot of sampling used for the current wav_path.
    #[serde(default)]
    pub generated_sampling: Option<SamplingParams>,
    /// v4: style caption paired with a non-caption speaker (embedding / ref).
    #[serde(default)]
    pub caption: Option<String>,
    #[serde(default)]
    pub generated_caption: Option<String>,
    /// v4: CFG scale for line caption (default 0.75 when absent).
    #[serde(default)]
    pub cfg_scale_caption: Option<f64>,
    #[serde(default)]
    pub generated_cfg_scale_caption: Option<f64>,
    pub volume: f64,
    pub speed: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub created_at: String,
    pub lines: Vec<ProjectLine>,
    pub default_sampling: SamplingParams,
}

pub fn project_dir(projects_root: &str, name: &str) -> PathBuf {
    Path::new(projects_root).join(sanitize_name(name))
}

pub fn project_json_path(projects_root: &str, name: &str) -> PathBuf {
    project_dir(projects_root, name).join("project.json")
}

pub fn sanitize_name(name: &str) -> String {
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
        "untitled".into()
    } else {
        trimmed
    }
}

pub fn save_project(projects_root: &str, project: &Project) -> Result<String, String> {
    let dir = project_dir(projects_root, &project.name);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("project.json");
    let text = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

/// Move the on-disk project folder when the sanitized directory name changes.
/// Caller should then `save_project` with the updated `Project.name`.
pub fn rename_project_dir(
    projects_root: &str,
    old_name: &str,
    new_name: &str,
) -> Result<(), String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("プロジェクト名を入力してください".into());
    }

    let old_dir = project_dir(projects_root, old_name);
    let new_dir = project_dir(projects_root, new_name);
    if old_dir == new_dir {
        return Ok(());
    }
    if new_dir.exists() {
        return Err("同名のプロジェクトが既に存在します".into());
    }
    if old_dir.is_dir() {
        fs::rename(&old_dir, &new_dir).map_err(|e| format!("リネーム失敗: {e}"))?;
    }
    Ok(())
}

pub fn load_project(projects_root: &str, name: &str) -> Result<Project, String> {
    let path = project_json_path(projects_root, name);
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub fn list_projects(projects_root: &str) -> Result<Vec<String>, String> {
    let root = Path::new(projects_root);
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() && path.join("project.json").is_file() {
            names.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    names.sort();
    Ok(names)
}
