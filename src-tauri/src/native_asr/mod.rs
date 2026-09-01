//! Local ASR (ReazonSpeech K2 v2 + Silero VAD) — adapted from Parapper-ASR, trimmed for Moirai.

use tauri::Manager;

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
