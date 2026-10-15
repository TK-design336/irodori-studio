//! Local ASR (ReazonSpeech K2 or parakeet, plus Silero VAD).

use tauri::{AppHandle, Manager};

pub(crate) mod audio;
pub mod commands;
mod config;
#[macro_use]
mod dispatch;
mod model;
mod postprocess;
mod recognition;
mod state;

pub use model::{OnnxRuntimeSileroVadEngine, VadEngine, vad_model_path};
pub use recognition::ImportAsrBreak;
pub use state::NativeAsrAppState;

pub fn shutdown_native_asr(state: &NativeAsrAppState) {
    if let Ok(mut guard) = state.audio_input.lock() {
        if let Some(running) = guard.take() {
            std::thread::spawn(move || running.stop());
        }
    }
    if let Ok(mut status) = state.recognition_status.lock() {
        *status = recognition::RecognitionStatus::Idle;
    }
}

/// ローカル ASR が入力デバイスを掴んでいるか（ウェイクワードのマイク再開を遅延するときに使用）
pub fn microphone_in_use_by_asr(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<NativeAsrAppState>() else {
        return false;
    };
    state
        .audio_input
        .lock()
        .ok()
        .is_some_and(|guard| guard.is_some())
}

/// Copy the saved recognizer choice onto the runtime config used by live and import.
fn apply_saved_asr_model(app: &AppHandle) -> Result<config::NativeAsrConfig, String> {
    let model = {
        let settings = app.state::<crate::AppState>().settings.lock().clone();
        config::AsrModel::parse(&settings.asr_model)
    };
    let state = app.state::<NativeAsrAppState>();
    let mut guard = state
        .runtime_config
        .write()
        .map_err(|_| "設定ロック書込に失敗しました".to_string())?;
    guard.asr_model = model;
    Ok(guard.clone())
}

/// Make sure the VAD + ASR models used by live dictation are on disk (downloads if not).
pub async fn ensure_file_asr_models(app: &AppHandle) -> Result<(), String> {
    let cfg = apply_saved_asr_model(app)?;
    let st = model::model_status(app, &cfg).map_err(|e| e.to_string())?;
    if st.asr.installed && st.vad.installed {
        return Ok(());
    }
    eprintln!("[import-asr] downloading native ASR models…");
    model::ensure_models_downloaded(app, &cfg)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Transcribe decoded 16 kHz mono PCM with the live-dictation pipeline
/// (VAD → segments → ASR → Japanese post-processing).
pub fn transcribe_pcm_offline(
    app: &AppHandle,
    samples: &[f32],
    break_style: ImportAsrBreak,
) -> Result<String, String> {
    if samples.is_empty() {
        return Err("音声が空です".into());
    }
    let cfg = apply_saved_asr_model(app)?;
    let cache = app.state::<NativeAsrAppState>().asr_engine_cache.clone();

    let vad_path = model::vad_model_path(app, &cfg).map_err(|e| e.to_string())?;
    let mut vad = model::OnnxRuntimeSileroVadEngine::new(&vad_path, cfg.vad_threshold)
        .map_err(|e| format!("VAD の起動に失敗しました: {e}"))?;
    let mut engine = cache
        .take_or_build(app, &cfg)
        .map_err(|e| format!("音声認識エンジンの起動に失敗しました: {e}"))?
        .ok_or_else(|| "音声認識モデルが未導入です。ライブ音声入力のモデル取得を先に行ってください。".to_string())?;

    let result = recognition::transcribe_pcm_with_pipeline(
        &cfg,
        &mut vad,
        engine.as_mut(),
        samples,
        break_style,
    );
    // Same hand-back the live worker does when the microphone stops.
    cache.store(cfg.asr_model, engine);

    let utterances = result.map_err(|e| format!("文字起こしに失敗しました: {e}"))?;
    Ok(utterances.join("\n"))
}
