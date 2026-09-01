use std::sync::{Arc, Mutex, RwLock};

use crate::native_asr::{
    audio::RunningAudioInput,
    config::NativeAsrConfig,
    model::AsrEngineCache,
    recognition::RecognitionStatus,
};

pub struct NativeAsrAppState {
    pub recognition_status: Mutex<RecognitionStatus>,
    pub audio_input: Mutex<Option<RunningAudioInput>>,
    pub runtime_config: Arc<RwLock<NativeAsrConfig>>,
    pub asr_engine_cache: Arc<AsrEngineCache>,
}

impl Default for NativeAsrAppState {
    fn default() -> Self {
        Self {
            recognition_status: Mutex::new(RecognitionStatus::Idle),
            audio_input: Mutex::new(None),
            runtime_config: Arc::new(RwLock::new(NativeAsrConfig::default())),
            asr_engine_cache: Arc::new(AsrEngineCache::default()),
        }
    }
}
