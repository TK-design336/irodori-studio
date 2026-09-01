use tauri::{AppHandle, Manager};

use crate::native_asr::{
    audio::RunningAudioInput,
    config::NativeAsrConfig,
    model::{self, ModelStatus, preload_asr_engine_blocking},
    recognition::RecognitionStatus,
    state::NativeAsrAppState,
};

#[tauri::command]
pub async fn native_asr_get_model_status(
    handle: AppHandle,
    state: tauri::State<'_, NativeAsrAppState>,
) -> Result<ModelStatus, String> {
    let cfg = state
        .runtime_config
        .read()
        .map_err(|_| "設定ロック取得に失敗しました".to_string())?
        .clone();
    model::model_status(&handle, &cfg).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn native_asr_download_models(
    handle: AppHandle,
    state: tauri::State<'_, NativeAsrAppState>,
) -> Result<ModelStatus, String> {
    let cfg = state
        .runtime_config
        .read()
        .map_err(|_| "設定ロック取得に失敗しました".to_string())?
        .clone();
    model::ensure_models_downloaded(&handle, &cfg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn native_asr_preload(
    handle: AppHandle,
    state: tauri::State<'_, NativeAsrAppState>,
) -> Result<(), String> {
    let cfg = state
        .runtime_config
        .read()
        .map_err(|_| "設定ロック取得に失敗しました".to_string())?
        .clone();
    let st = model::model_status(&handle, &cfg).map_err(|e| e.to_string())?;
    if !st.vad.installed || !st.asr.installed {
        return Ok(());
    }
    let cache = state.asr_engine_cache.clone();
    let handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        preload_asr_engine_blocking(&handle, &cfg, cache.as_ref());
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn native_asr_list_devices() -> Vec<crate::native_asr::audio::DeviceInfo> {
    crate::native_asr::audio::collect_input_devices()
}

#[tauri::command]
pub fn native_asr_get_config(
    state: tauri::State<'_, NativeAsrAppState>,
) -> Result<NativeAsrConfig, String> {
    state
        .runtime_config
        .read()
        .map(|g| g.clone())
        .map_err(|_| "設定ロック取得に失敗しました".to_string())
}

#[tauri::command]
pub fn native_asr_set_config(
    state: tauri::State<'_, NativeAsrAppState>,
    config: NativeAsrConfig,
) -> Result<(), String> {
    let normalized = config.normalized();
    *state
        .runtime_config
        .write()
        .map_err(|_| "設定ロック書込に失敗しました".to_string())? = normalized;
    Ok(())
}

pub(crate) fn start_native_asr_listening(
    app: &AppHandle,
    state: &NativeAsrAppState,
) -> Result<RecognitionStatus, String> {
    let cfg = state
        .runtime_config
        .read()
        .map_err(|_| "設定ロック取得に失敗しました".to_string())?
        .clone();
    let st = model::model_status(app, &cfg).map_err(|e| e.to_string())?;
    if !st.vad.installed || !st.asr.installed {
        return Err(
            "ASR モデルが未インストールです。初回はモデルのダウンロードが必要です。"
                .to_string(),
        );
    }

    let mut audio_input = state.audio_input.lock().map_err(|e| e.to_string())?;
    if audio_input.is_some() {
        let stale = audio_input.take().unwrap();
        drop(audio_input);
        stale.stop();
        audio_input = state.audio_input.lock().map_err(|e| e.to_string())?;
    }

    let running = RunningAudioInput::start(
        app.clone(),
        &cfg,
        state.runtime_config.clone(),
        state.asr_engine_cache.clone(),
        None,
    )
    .map_err(|e| e.to_string())?;

    *audio_input = Some(running);
    *state
        .recognition_status
        .lock()
        .map_err(|e| e.to_string())? = RecognitionStatus::Listening;
    Ok(RecognitionStatus::Listening)
}

#[tauri::command]
pub async fn native_asr_start(
    handle: AppHandle,
) -> Result<RecognitionStatus, String> {
    let handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<NativeAsrAppState>();
        start_native_asr_listening(&handle, &state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn native_asr_stop(
    state: tauri::State<'_, NativeAsrAppState>,
) -> Result<RecognitionStatus, String> {
    let running = {
        let mut audio_input = state.audio_input.lock().map_err(|e| e.to_string())?;
        audio_input.take()
    };
    *state
        .recognition_status
        .lock()
        .map_err(|e| e.to_string())? = RecognitionStatus::Idle;
    if let Some(running) = running {
        tauri::async_runtime::spawn_blocking(move || running.stop())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(RecognitionStatus::Idle)
}
