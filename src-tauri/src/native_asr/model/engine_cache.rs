use std::sync::Mutex;

use anyhow::Result;
use tauri::AppHandle;

use super::{AsrEngine, SherpaOnnxAsrEngine, asr_model_dir};
use crate::native_asr::config::{AsrModel, NativeAsrConfig};

struct CachedEngine {
    model: AsrModel,
    engine: Box<dyn AsrEngine>,
}

/// Keeps the selected recognizer loaded across microphone start/stop.
#[derive(Default)]
pub struct AsrEngineCache {
    engine: Mutex<Option<CachedEngine>>,
}

impl AsrEngineCache {
    pub fn take_or_build(
        &self,
        handle: &AppHandle,
        config: &NativeAsrConfig,
    ) -> Result<Option<Box<dyn AsrEngine>>> {
        if let Ok(mut guard) = self.engine.lock() {
            if let Some(cached) = guard.take() {
                if cached.model == config.asr_model {
                    log::info!("Native ASR: using preloaded engine");
                    return Ok(Some(cached.engine));
                }
                log::info!("Native ASR: dropping cached engine for a different model");
            }
        }
        build_asr_engine(handle, config)
    }

    pub fn store(&self, model: AsrModel, engine: Box<dyn AsrEngine>) {
        if let Ok(mut guard) = self.engine.lock() {
            if guard.is_none() {
                *guard = Some(CachedEngine { model, engine });
                log::debug!("Native ASR: engine stored in cache");
            }
        }
    }

    pub fn is_ready_for(&self, model: AsrModel) -> bool {
        self.engine
            .lock()
            .ok()
            .is_some_and(|guard| guard.as_ref().is_some_and(|cached| cached.model == model))
    }

    fn discard_unless(&self, model: AsrModel) {
        if let Ok(mut guard) = self.engine.lock() {
            if guard.as_ref().is_some_and(|cached| cached.model != model) {
                *guard = None;
            }
        }
    }
}

pub fn build_asr_engine(
    handle: &AppHandle,
    config: &NativeAsrConfig,
) -> Result<Option<Box<dyn AsrEngine>>> {
    let model_dir = asr_model_dir(handle, config)?;
    let engine = SherpaOnnxAsrEngine::new(
        &model_dir,
        config.asr_model,
        config.asr_precision,
        config.asr_num_threads,
    )?;
    Ok(Some(Box::new(engine)))
}

/// Load the selected recognizer ahead of the first utterance.
pub fn preload_asr_engine_blocking(
    handle: &AppHandle,
    config: &NativeAsrConfig,
    cache: &AsrEngineCache,
) {
    cache.discard_unless(config.asr_model);
    if cache.is_ready_for(config.asr_model) {
        return;
    }
    let started = std::time::Instant::now();
    match build_asr_engine(handle, config) {
        Ok(Some(engine)) => {
            cache.store(config.asr_model, engine);
            log::info!(
                "Native ASR: engine preloaded in {} ms",
                started.elapsed().as_millis()
            );
        }
        Ok(None) => log::warn!("Native ASR preload: model dir missing"),
        Err(err) => log::warn!("Native ASR preload failed: {err:#}"),
    }
}
