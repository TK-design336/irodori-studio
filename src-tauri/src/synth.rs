//! Shared TTS synthesize path used by Tauri commands and the local HTTP API.

use crate::dictionary::prepare_synth_text;
use crate::settings::{studio_python_dir, AppSettings};
use crate::speakers::SpeakerInfo;
use crate::split_text::{normalize_max_chars_from_settings, prepare_chunks};
use crate::worker::{load_failure_message, OptWorkerSimple};
use crate::{
    export_wav_adjusted_inner, export_wavs_concatenated_inner, studio_cache_dir, ExportAudioFormat,
    WavExportSeg,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct UtteranceSynthOpts {
    pub split: bool,
    pub max_chars: usize,
    pub speed: f64,
    pub volume: f64,
    pub silence_ms: u32,
}

impl UtteranceSynthOpts {
    pub fn from_settings(settings: &AppSettings, split: bool) -> Self {
        Self {
            split,
            max_chars: normalize_max_chars_from_settings(settings.http_max_chars),
            speed: 1.0,
            volume: 1.0,
            silence_ms: settings.chunk_silence_ms,
        }
    }

    pub fn clamped(mut self) -> Self {
        self.speed = self.speed.clamp(0.5, 2.0);
        self.volume = self.volume.clamp(0.0, 4.0);
        self
    }
}

/// Dictionary replace → optional pack split → synthesize chunk(s) → concat with FX.
pub fn synthesize_utterance_to_path(
    settings: &AppSettings,
    worker: &Mutex<OptWorkerSimple>,
    text: &str,
    speaker: &SpeakerInfo,
    dest_wav: &Path,
    opts: UtteranceSynthOpts,
) -> Result<(), String> {
    let opts = opts.clamped();
    let prepared = prepare_synth_text(settings, text, &[])?;
    let chunks = prepare_chunks(&prepared, opts.split, opts.max_chars);
    if chunks.is_empty() {
        return Err("text が空です".into());
    }

    let work_dir = studio_cache_dir()
        .join("http_synth")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;

    let result = synthesize_chunks_inner(settings, worker, &chunks, speaker, &work_dir, opts, dest_wav);
    let _ = std::fs::remove_dir_all(&work_dir);
    result
}

fn synthesize_chunks_inner(
    settings: &AppSettings,
    worker: &Mutex<OptWorkerSimple>,
    chunks: &[String],
    speaker: &SpeakerInfo,
    work_dir: &Path,
    opts: UtteranceSynthOpts,
    dest_wav: &Path,
) -> Result<(), String> {
    let silence_secs = opts.silence_ms as f64 / 1000.0;
    let dest_str = dest_wav.display().to_string();
    let num_steps = http_default_steps(settings, worker)?;

    if chunks.len() == 1 {
        let chunk_path = work_dir.join("0000.wav");
        let chunk_str = chunk_path.display().to_string();
        let args = args_for_speaker(&chunks[0], speaker, chunk_str, num_steps)?;
        synthesize_with_worker(settings, worker, args)?;
        let vol_ok = (opts.volume - 1.0).abs() < 0.001;
        let spd_ok = (opts.speed - 1.0).abs() < 0.001;
        if vol_ok && spd_ok {
            std::fs::copy(&chunk_path, dest_wav).map_err(|e| e.to_string())?;
            return Ok(());
        }
        return export_wav_adjusted_inner(
            settings,
            chunk_path.display().to_string(),
            dest_str,
            opts.volume,
            opts.speed,
            0.0,
            &Default::default(),
            ExportAudioFormat::Wav,
            None,
            None,
        );
    }

    let mut seg_paths: Vec<String> = Vec::with_capacity(chunks.len());
    for (i, chunk) in chunks.iter().enumerate() {
        let chunk_path = work_dir.join(format!("{i:04}.wav"));
        let chunk_str = chunk_path.display().to_string();
        let args = args_for_speaker(chunk, speaker, chunk_str, num_steps)?;
        synthesize_with_worker(settings, worker, args)?;
        seg_paths.push(chunk_path.display().to_string());
    }

    let segments: Vec<WavExportSeg> = seg_paths
        .iter()
        .map(|p| WavExportSeg {
            src: p.clone(),
            volume: opts.volume,
            speed: opts.speed,
            pitch: 0.0,
            audio_fx: Default::default(),
            clip_edit: None,
        })
        .collect();

    export_wavs_concatenated_inner(
        settings,
        segments,
        silence_secs,
        dest_str,
        Some("wav".to_string()),
        None,
    )
}

/// Synthesize pre-split chunks (no further pack split). Applies speed/volume on concat.
pub fn synthesize_chunk_list_to_path(
    settings: &AppSettings,
    worker: &Mutex<OptWorkerSimple>,
    chunks: &[String],
    speaker: &SpeakerInfo,
    dest_wav: &Path,
    opts: UtteranceSynthOpts,
) -> Result<(), String> {
    let opts = opts.clamped();
    let non_empty: Vec<String> = chunks
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if non_empty.is_empty() {
        return Err("text が空です".into());
    }
    let work_dir = studio_cache_dir()
        .join("http_synth")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
    let result =
        synthesize_chunks_inner(settings, worker, &non_empty, speaker, &work_dir, opts, dest_wav);
    let _ = std::fs::remove_dir_all(&work_dir);
    result
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeArgs {
    pub text: String,
    #[serde(default)]
    pub ref_embed: Option<String>,
    #[serde(default)]
    pub ref_wav: Option<String>,
    /// Multiple reference WAV paths (v4.1+). Takes precedence over ref_wav when set.
    #[serde(default)]
    pub ref_wavs: Option<Vec<String>>,
    #[serde(default)]
    pub caption: Option<String>,
    #[serde(default)]
    pub no_ref: Option<bool>,
    pub output_wav: String,
    /// One path per candidate. When set, length should match num_candidates.
    #[serde(default)]
    pub output_wavs: Option<Vec<String>>,
    pub num_steps: u32,
    pub num_candidates: u32,
    pub seed: Option<i64>,
    pub seconds: Option<f64>,
    pub duration_scale: f64,
    pub t_schedule_mode: String,
    pub sway_coeff: f64,
    pub cfg_guidance_mode: String,
    pub cfg_scale_text: f64,
    #[serde(default)]
    pub cfg_scale_caption: Option<f64>,
    pub cfg_scale_speaker: f64,
}

/// Default sampling used by the HTTP API. Step count follows the loaded model.
pub fn default_http_sampling(num_steps: u32) -> (u32, f64, String, f64, String, f64, f64, f64) {
    (
        num_steps,
        1.0,                // duration_scale
        "linear".into(),    // t_schedule_mode
        -1.0,               // sway_coeff
        "independent".into(), // cfg_guidance_mode
        3.0,                // cfg_scale_text
        3.0,                // cfg_scale_caption
        5.0,                // cfg_scale_speaker
    )
}

/// Build synthesize args from speaker profile + text (HTTP / batch jobs).
fn http_default_steps(
    settings: &AppSettings,
    worker: &Mutex<OptWorkerSimple>,
) -> Result<u32, String> {
    let python_dir = studio_python_dir()?;
    let mut worker = worker.lock();
    let _ = worker.ensure_alive();
    worker.start(settings, &python_dir)?;
    if !worker.is_loaded() {
        let resp = worker.load(settings)?;
        if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(load_failure_message(&resp));
        }
    }
    Ok(worker.default_num_steps())
}

pub fn args_for_speaker(
    text: &str,
    speaker: &SpeakerInfo,
    output_wav: String,
    num_steps: u32,
) -> Result<SynthesizeArgs, String> {
    let (
        num_steps,
        duration_scale,
        t_schedule_mode,
        sway_coeff,
        cfg_guidance_mode,
        cfg_scale_text,
        cfg_scale_caption,
        cfg_scale_speaker,
    ) = default_http_sampling(num_steps);

    let mut args = SynthesizeArgs {
        text: text.to_string(),
        ref_embed: None,
        ref_wav: None,
        ref_wavs: None,
        caption: None,
        no_ref: None,
        output_wav,
        output_wavs: None,
        num_steps,
        num_candidates: 1,
        seed: None,
        seconds: None,
        duration_scale,
        t_schedule_mode,
        sway_coeff,
        cfg_guidance_mode,
        cfg_scale_text,
        cfg_scale_caption: Some(cfg_scale_caption),
        cfg_scale_speaker,
    };

    match speaker.kind.as_str() {
        "ref" => {
            let wavs = speaker
                .ref_wavs
                .clone()
                .filter(|v| !v.is_empty())
                .or_else(|| {
                    speaker
                        .ref_wav
                        .as_ref()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .map(|s| vec![s])
                });
            if wavs.is_none() {
                return Err(format!(
                    "参照音源話者「{}」に WAV がありません",
                    speaker.name
                ));
            }
            args.ref_wavs = wavs;
            if let Some(cap) = speaker.caption.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty())
            {
                args.caption = Some(cap.to_string());
            }
        }
        "caption" => {
            let cap = speaker
                .caption
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    format!("キャプション話者「{}」に caption がありません", speaker.name)
                })?;
            args.caption = Some(cap);
            args.no_ref = Some(true);
        }
        _ => {
            // trained / blend
            let embed = speaker.embed_path.trim();
            if embed.is_empty() {
                return Err(format!("話者「{}」に埋め込みパスがありません", speaker.name));
            }
            args.ref_embed = Some(embed.to_string());
            if let Some(cap) = speaker.caption.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty())
            {
                args.caption = Some(cap.to_string());
            }
        }
    }

    Ok(args)
}

pub fn find_speaker<'a>(
    speakers: &'a [SpeakerInfo],
    id: &str,
) -> Result<&'a SpeakerInfo, String> {
    let id = id.trim();
    speakers
        .iter()
        .find(|s| s.embed_path == id)
        .ok_or_else(|| format!("話者が見つかりません: {id}"))
}

/// Run one synthesize request against the shared OPT worker mutex.
pub fn synthesize_with_worker(
    settings: &AppSettings,
    worker: &Mutex<OptWorkerSimple>,
    args: SynthesizeArgs,
) -> Result<Value, String> {
    let python_dir = studio_python_dir()?;
    let mut worker = worker.lock();
    let _ = worker.ensure_alive();
    worker.start(settings, &python_dir)?;
    if !worker.is_loaded() {
        let resp = worker.load(settings)?;
        if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(load_failure_message(&resp));
        }
    }

    let ref_embed = args
        .ref_embed
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let ref_wavs: Option<Vec<String>> = args
        .ref_wavs
        .as_ref()
        .map(|v| {
            v.iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty())
        .or_else(|| {
            args.ref_wav
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .map(|s| vec![s])
        });
    let ref_latents = if ref_embed.is_none() {
        ref_wavs.as_ref().and_then(|wavs| resolve_ref_latents(settings, &mut worker, wavs))
    } else {
        None
    };
    let ref_wavs = if ref_latents.is_some() { None } else { ref_wavs };

    let ref_wav = if ref_wavs.is_none() {
        args.ref_wav
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    };

    let caption = args
        .caption
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let has_ref = ref_embed.is_some()
        || ref_wav.is_some()
        || ref_wavs.is_some()
        || ref_latents.is_some();
    let no_ref = args.no_ref.unwrap_or(false) || (caption.is_some() && !has_ref);

    if !has_ref && !no_ref {
        return Err(
            "話者の埋め込み・参照音源・キャプションのいずれかを指定してください".into(),
        );
    }

    let mut payload = json!({
        "text": args.text,
        "output_wav": args.output_wav,
        "num_steps": args.num_steps,
        "num_candidates": args.num_candidates,
        "duration_scale": args.duration_scale,
        "t_schedule_mode": args.t_schedule_mode,
        "sway_coeff": args.sway_coeff,
        "cfg_guidance_mode": args.cfg_guidance_mode,
        "cfg_scale_text": args.cfg_scale_text,
        "cfg_scale_caption": args.cfg_scale_caption.unwrap_or(3.0),
        "cfg_scale_speaker": args.cfg_scale_speaker,
        "no_ref": no_ref,
        "context_kv_cache": true,
    });
    if let Some(ref embed) = ref_embed {
        payload["ref_embed"] = json!(embed);
    }
    if let Some(ref lats) = ref_latents {
        if lats.len() == 1 {
            payload["ref_latent"] = json!(lats[0]);
        }
        payload["ref_latents"] = json!(lats);
    } else if let Some(ref wavs) = ref_wavs {
        payload["ref_wavs"] = json!(wavs);
        payload["ref_wav"] = json!(wavs[0]);
    } else if let Some(ref wav) = ref_wav {
        payload["ref_wav"] = json!(wav);
    }
    if let Some(ref cap) = caption {
        payload["caption"] = json!(cap);
    }
    if let Some(seed) = args.seed {
        payload["seed"] = json!(seed);
    }
    if let Some(seconds) = args.seconds {
        payload["seconds"] = json!(seconds);
    }
    let extra_wavs: Vec<String> = args
        .output_wavs
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if !extra_wavs.is_empty() {
        payload["output_wavs"] = json!(extra_wavs);
        payload["num_candidates"] = json!(extra_wavs.len() as u32);
    }

    let try_once = |w: &mut OptWorkerSimple, p: Value| -> Result<Value, String> {
        let resp = w.synthesize(p)?;
        if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("synthesize failed")
                .to_string());
        }
        Ok(resp)
    };

    match try_once(&mut worker, payload.clone()) {
        Ok(resp) => Ok(resp),
        Err(first_err) => {
            let _ = worker.shutdown();
            worker.start(settings, &python_dir)?;
            let load_resp = worker.load(settings)?;
            if load_resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                return Err(format!(
                    "再起動後のロードに失敗: {}（初回エラー: {first_err}）",
                    load_failure_message(&load_resp)
                ));
            }
            try_once(&mut worker, payload)
                .map_err(|e| format!("再試行も失敗: {e}（初回エラー: {first_err}）"))
        }
    }
}

fn ref_latent_cache_dir(settings: &AppSettings) -> PathBuf {
    PathBuf::from(settings.outputs_root())
        .join("_profiles")
        .join("ref_latents")
}

fn latent_path_for(dir: &Path, wav: &str) -> Option<PathBuf> {
    let path = Path::new(wav);
    if !path.is_file() {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let len = meta.len();
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in wav.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(dir.join(format!("{hash:016x}-{mtime}-{len}.pt")))
}

/// Reuse encoded reference files beside speaker data. `None` keeps the WAV path.
fn resolve_ref_latents(
    settings: &AppSettings,
    worker: &mut OptWorkerSimple,
    wavs: &[String],
) -> Option<Vec<String>> {
    if wavs.is_empty() {
        return None;
    }
    let dir = ref_latent_cache_dir(settings);
    let mut planned = Vec::with_capacity(wavs.len());
    for wav in wavs {
        planned.push(latent_path_for(&dir, wav)?);
    }
    let mut need_wavs = Vec::new();
    let mut need_outs = Vec::new();
    for (wav, out) in wavs.iter().zip(planned.iter()) {
        if !out.is_file() {
            need_wavs.push(wav.clone());
            need_outs.push(out.display().to_string());
        }
    }
    if !need_wavs.is_empty() {
        let encoded = worker.encode_refs(&need_wavs, &need_outs).unwrap_or(false);
        if !encoded {
            return None;
        }
    }
    if planned.iter().all(|p| p.is_file()) {
        Some(planned.into_iter().map(|p| p.display().to_string()).collect())
    } else {
        None
    }
}
