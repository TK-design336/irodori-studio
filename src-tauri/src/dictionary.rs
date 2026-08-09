use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceEntry {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 入力時に自動置換（デフォルト OFF）
    #[serde(default)]
    pub auto_replace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomographEntry {
    pub id: String,
    pub surface: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Dictionaries {
    #[serde(default)]
    pub replace: Vec<ReplaceEntry>,
    #[serde(default)]
    pub homograph: Vec<HomographEntry>,
}

pub fn dictionaries_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("irodori-studio")
        .join("dictionaries.json")
}

pub fn load_dictionaries() -> Dictionaries {
    let path = dictionaries_path();
    if path.is_file() {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(d) = serde_json::from_str::<Dictionaries>(&text) {
                return d;
            }
        }
    }
    Dictionaries::default()
}

pub fn save_dictionaries(dicts: &Dictionaries) -> Result<(), String> {
    let path = dictionaries_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(dicts).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}
