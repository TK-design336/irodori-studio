use std::sync::Mutex;

use anyhow::Result;
use tauri::AppHandle;

use super::{AsrEngine, SherpaOnnxAsrEngine, asr_model_dir};
use crate::native_asr::config::NativeAsrConfig;

/// K2 モデルをメモリに保持し、マイク ON/OFF のたびに再ロードしない。
#[derive(Default)]
pub struct AsrEngineCache {
    engine: Mutex<Option<Box<dyn AsrEngine>>>,
}

impl AsrEngineCache {
    pub fn take_or_build(
        &self,
        handle: &AppHandle,
        config: &NativeAsrConfig,
    ) -> Result<Option<Box<dyn AsrEngine>>> {
        if let Ok(mut guard) = self.engine.lock() {
            if let Some(engine) = guard.take() {
                log::info!("Native ASR: using preloaded engine");
                return Ok(Some(engine));
            }
        }
        build_asr_engine(handle, config)
    }

    pub fn store(&self, engine: Box<dyn AsrEngine>) {
        if let Ok(mut guard) = self.engine.lock() {
            if guard.is_none() {
                *guard = Some(engine);
                log::debug!("Native ASR: engine stored in cache");
            }
        }
    }

    pub fn is_ready(&self) -> bool {
        self.engine
            .lock()
            .ok()
            .is_some_and(|g| g.is_some())
    }
}

pub fn build_asr_engine(
    handle: &AppHandle,
    config: &NativeAsrConfig,
) -> Result<Option<Box<dyn AsrEngine>>> {
    let model_dir = asr_model_dir(handle, config)?;
    let engine = SherpaOnnxAsrEngine::new(
        &model_dir,
        config.asr_precision,
        config.asr_num_threads,
    )?;
    Ok(Some(Box::new(engine)))
}

/// バックグラウンドで K2 をロード（ウェイクワード待機中に完了させる）。
pub fn preload_asr_engine_blocking(
    handle: &AppHandle,
    config: &NativeAsrConfig,
    cache: &AsrEngineCache,
) {
    if cache.is_ready() {
        return;
    }
    let started = std::time::Instant::now();
    match build_asr_engine(handle, config) {
        Ok(Some(engine)) => {
            cache.store(engine);
            log::info!(
                "Native ASR: engine preloaded in {} ms",
                started.elapsed().as_millis()
            );
        }
        Ok(None) => log::warn!("Native ASR preload: model dir missing"),
        Err(err) => log::warn!("Native ASR preload failed: {err:#}"),
    }
}
