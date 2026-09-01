//! VOICEVOX-compatible HTTP surface (speakers / audio_query / synthesis).

use crate::dictionary::{apply_dict_replacements, prepare_synth_text};
use crate::settings::AppSettings;
use crate::speakers::{self, SpeakerInfo};
use crate::split_text::{normalize_max_chars_from_settings, prepare_chunks};
use crate::synth::{self, UtteranceSynthOpts};
use crate::{studio_cache_dir, AppState};
use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const MAP_FILE: &str = "http_speaker_map.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerIdMap {
    next_id: u32,
    #[serde(default)]
    pub(crate) by_embed_path: HashMap<String, u32>,
}

impl SpeakerIdMap {
    fn path(outputs_root: &str) -> PathBuf {
        PathBuf::from(outputs_root).join(".irodori").join(MAP_FILE)
    }

    fn load(outputs_root: &str) -> Self {
        let path = Self::path(outputs_root);
        if path.is_file() {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(m) = serde_json::from_str(&text) {
                    return m;
                }
            }
        }
        Self::default()
    }

    fn save(&self, outputs_root: &str) -> Result<(), String> {
        let path = Self::path(outputs_root);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(&path, text).map_err(|e| e.to_string())
    }

    fn style_id_for(&mut self, embed_path: &str) -> u32 {
        if let Some(&id) = self.by_embed_path.get(embed_path) {
            return id;
        }
        let id = self.next_id.max(1);
        self.next_id = id.saturating_add(1);
        self.by_embed_path.insert(embed_path.to_string(), id);
        id
    }
}

pub fn ensure_speaker_maps(
    outputs_root: &str,
    speakers: &[SpeakerInfo],
) -> Result<SpeakerIdMap, String> {
    let mut map = SpeakerIdMap::load(outputs_root);
    let mut changed = false;
    for sp in speakers {
        if !map.by_embed_path.contains_key(&sp.embed_path) {
            map.style_id_for(&sp.embed_path);
            changed = true;
        }
    }
    if changed {
        map.save(outputs_root)?;
    }
    Ok(map)
}

pub fn speaker_by_style_id<'a>(
    speakers: &'a [SpeakerInfo],
    map: &SpeakerIdMap,
    style_id: u32,
) -> Option<&'a SpeakerInfo> {
    let embed = map
        .by_embed_path
        .iter()
        .find(|(_, &id)| id == style_id)
        .map(|(k, _)| k.as_str())?;
    speakers.iter().find(|s| s.embed_path == embed)
}

pub fn is_voicevox_compat_path(path: &str) -> bool {
    path == "/version"
        || path == "/engine_manifest"
        || path == "/speakers"
        || path.starts_with("/speaker_info")
        || path.starts_with("/audio_query")
        || path.starts_with("/synthesis")
        || path.starts_with("/initialize_speaker")
        || path.starts_with("/is_initialized_speaker")
}

fn with_app_state<F, R>(app: &AppHandle, f: F) -> R
where
    F: FnOnce(&AppState) -> R,
{
    let state = app.state::<AppState>();
    f(&state)
}

fn with_speakers_and_map(
    app: &AppHandle,
) -> Result<(AppSettings, Vec<SpeakerInfo>, SpeakerIdMap), (StatusCode, String)> {
    with_app_state(app, |s| {
        let settings = s.settings.lock().clone();
        let speakers = speakers::scan_speakers(settings.outputs_root())?;
        let map = ensure_speaker_maps(settings.outputs_root(), &speakers)?;
        Ok((settings, speakers, map))
    })
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

pub async fn version() -> Json<Value> {
    Json(json!({
        "name": "Irodori Studio",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

pub async fn engine_manifest() -> Json<Value> {
    Json(json!({
        "supportedFeatures": {
            "adjustSpeedScale": true,
            "adjustPitchScale": false,
            "adjustIntonationScale": false,
            "adjustVolumeScale": true,
            "adjustPauseLength": true,
            "interrogativeUpspeak": false,
            "synthesisMorphing": false,
        }
    }))
}

#[derive(Serialize)]
struct VvStyle {
    name: String,
    id: u32,
    #[serde(rename = "type")]
    style_type: String,
}

#[derive(Serialize)]
pub(crate) struct VvSpeaker {
    name: String,
    speaker_uuid: String,
    styles: Vec<VvStyle>,
}

pub async fn list_speakers_vv(
    app: &AppHandle,
) -> Result<Json<Vec<VvSpeaker>>, (StatusCode, String)> {
    let (_, speakers, map) = with_speakers_and_map(app)?;
    let list: Vec<VvSpeaker> = speakers
        .iter()
        .filter_map(|sp| {
            let id = *map.by_embed_path.get(&sp.embed_path)?;
            Some(VvSpeaker {
                name: sp.name.clone(),
                speaker_uuid: sp.embed_path.clone(),
                styles: vec![VvStyle {
                    name: "ノーマル".into(),
                    id,
                    style_type: "talk".into(),
                }],
            })
        })
        .collect();
    Ok(Json(list))
}

#[derive(Deserialize)]
pub struct SpeakerInfoQuery {
    pub speaker_uuid: String,
}

pub async fn speaker_info_vv(
    app: &AppHandle,
    Query(q): Query<SpeakerInfoQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (_, speakers, map) = with_speakers_and_map(app)?;
    let sp = speakers
        .iter()
        .find(|s| s.embed_path == q.speaker_uuid)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "話者が見つかりません".into()))?;
    let style_id = map
        .by_embed_path
        .get(&sp.embed_path)
        .copied()
        .unwrap_or(0);
    Ok(Json(json!({
        "policy": "",
        "portrait": "",
        "styleInfos": [{
            "id": style_id,
            "icon": "",
            "name": "ノーマル",
            "voiceSample": ""
        }]
    })))
}

#[derive(Deserialize)]
pub struct AudioQueryParams {
    pub text: String,
    pub speaker: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct VvMora {
    text: String,
    consonant: Option<String>,
    consonant_length: Option<f64>,
    vowel: String,
    vowel_length: f64,
    pitch: f64,
}

#[derive(Serialize, Deserialize, Clone)]
struct VvAccentPhrase {
    moras: Vec<VvMora>,
    accent: u32,
    pause_mora: Option<VvMora>,
    #[serde(rename = "is_interrogative")]
    is_interrogative: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioQuery {
    pub accent_phrases: Vec<VvAccentPhrase>,
    pub speed_scale: f64,
    pub pitch_scale: f64,
    pub intonation_scale: f64,
    pub volume_scale: f64,
    pub pre_phoneme_length: f64,
    pub post_phoneme_length: f64,
    pub pause_length: Option<f64>,
    pub pause_length_scale: f64,
    pub output_sampling_rate: u32,
    pub output_stereo: bool,
    pub kana: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub irodori: Option<IrodoriMeta>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct IrodoriMeta {
    pub text: String,
    pub chunks: Vec<String>,
}

pub async fn audio_query_vv(
    app: &AppHandle,
    Query(params): Query<AudioQueryParams>,
) -> Result<Json<AudioQuery>, (StatusCode, String)> {
    let (settings, speakers, map) = with_speakers_and_map(app)?;
    let _speaker = speaker_by_style_id(&speakers, &map, params.speaker)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "話者が見つかりません".into()))?;
    let prepared = prepare_synth_text(&settings, &params.text, &[]).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, e)
    })?;
    let max_chars = normalize_max_chars_from_settings(settings.http_max_chars);
    let chunks = prepare_chunks(&prepared, true, max_chars);
    if chunks.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "text が空です".into()));
    }
    Ok(Json(build_audio_query(&params.text, &prepared, &chunks, &settings)))
}

fn build_audio_query(
    display_text: &str,
    prepared_text: &str,
    chunks: &[String],
    _settings: &AppSettings,
) -> AudioQuery {
    let accent_phrases: Vec<VvAccentPhrase> = chunks
        .iter()
        .map(|c| VvAccentPhrase {
            moras: vec![VvMora {
                text: c.clone(),
                consonant: None,
                consonant_length: None,
                vowel: "a".into(),
                vowel_length: 0.2,
                pitch: 0.0,
            }],
            accent: 1,
            pause_mora: None,
            is_interrogative: false,
        })
        .collect();
    AudioQuery {
        accent_phrases,
        speed_scale: 1.0,
        pitch_scale: 0.0,
        intonation_scale: 1.0,
        volume_scale: 1.0,
        pre_phoneme_length: 0.0,
        post_phoneme_length: 0.0,
        pause_length: None,
        pause_length_scale: 1.0,
        output_sampling_rate: 44100,
        output_stereo: false,
        kana: prepared_text.to_string(),
        irodori: Some(IrodoriMeta {
            text: display_text.to_string(),
            chunks: chunks.to_vec(),
        }),
    }
}

#[derive(Deserialize)]
pub struct SynthesisParams {
    pub speaker: u32,
}

pub async fn synthesis_vv(
    app: &AppHandle,
    Query(params): Query<SynthesisParams>,
    Json(query): Json<AudioQuery>,
) -> Result<Vec<u8>, (StatusCode, String)> {
    let (settings, speakers, map) = with_speakers_and_map(app)?;
    let speaker = speaker_by_style_id(&speakers, &map, params.speaker)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "話者が見つかりません".into()))?
        .clone();

    let (chunks, skip_dict): (Vec<String>, bool) = if !query.kana.trim().is_empty() {
        let max_chars = normalize_max_chars_from_settings(settings.http_max_chars);
        (prepare_chunks(query.kana.trim(), false, max_chars), true)
    } else if let Some(meta) = &query.irodori {
        (meta.chunks.clone(), false)
    } else {
        let joined: String = query
            .accent_phrases
            .iter()
            .flat_map(|p| p.moras.iter().map(|m| m.text.clone()))
            .collect();
        let replaced = apply_dict_replacements(&joined);
        let prepared = prepare_synth_text(&settings, &replaced, &[]).map_err(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, e)
        })?;
        let max_chars = normalize_max_chars_from_settings(settings.http_max_chars);
        (prepare_chunks(&prepared, true, max_chars), true)
    };

    if chunks.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "text が空です".into()));
    }

    let _ = skip_dict;

    let silence_ms = (settings.chunk_silence_ms as f64 * query.pause_length_scale.max(0.0)) as u32;
    let opts = UtteranceSynthOpts {
        split: false,
        max_chars: normalize_max_chars_from_settings(settings.http_max_chars),
        speed: query.speed_scale,
        volume: query.volume_scale,
        silence_ms,
    };

    let work_dir = studio_cache_dir().join("http_vv");
    fs::create_dir_all(&work_dir).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let wav_path = work_dir.join(format!("{}.wav", uuid::Uuid::new_v4()));
    let wav_read = wav_path.clone();

    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        with_app_state(&app2, |s| {
            let settings = s.settings.lock().clone();
            synth::synthesize_chunk_list_to_path(
                &settings,
                &s.worker,
                &chunks,
                &speaker,
                &wav_path,
                opts,
            )
        })
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let bytes = fs::read(&wav_read).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let _ = fs::remove_file(&wav_read);
    Ok(bytes)
}

#[derive(Deserialize)]
pub struct InitSpeakerParams {
    pub speaker: u32,
}

pub async fn initialize_speaker_vv(
    app: &AppHandle,
    Query(params): Query<InitSpeakerParams>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (_, speakers, map) = with_speakers_and_map(app)?;
    let _ = speaker_by_style_id(&speakers, &map, params.speaker)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "話者が見つかりません".into()))?;
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        with_app_state(&app2, |s| {
            let settings = s.settings.lock().clone();
            let python_dir = crate::settings::studio_python_dir()?;
            let mut worker = s.worker.lock();
            worker.start(&settings, &python_dir)?;
            if !worker.is_loaded() {
                let resp = worker.load(&settings)?;
                if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                    return Err(format!("load failed: {resp}"));
                }
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn is_initialized_speaker_vv(
    app: &AppHandle,
    Query(params): Query<InitSpeakerParams>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (_, speakers, map) = with_speakers_and_map(app)?;
    let _ = speaker_by_style_id(&speakers, &map, params.speaker)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "話者が見つかりません".into()))?;
    let initialized = with_app_state(app, |s| {
        let w = s.worker.lock();
        w.is_running() && w.is_loaded()
    });
    Ok(Json(json!({ "isInitialized": initialized })))
}
