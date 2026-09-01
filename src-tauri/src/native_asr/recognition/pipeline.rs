use std::sync::{Arc, RwLock};

use anyhow::Result;
use tauri::{AppHandle, Emitter};

use super::events::{VadState, VadStateEvent};
use super::segment_builder::{SegmentBuilder, SegmentBuilderEvent};
use super::worker::AsrWorker;
use crate::native_asr::{
    config::NativeAsrConfig,
    model::{AsrEngineCache, OnnxRuntimeSileroVadEngine, VadEngine, vad_model_path},
};

pub struct RecognitionPipeline {
    handle: AppHandle,
    segment_builder: SegmentBuilder,
    vad: Box<dyn VadEngine>,
    asr_worker: AsrWorker,
}

impl RecognitionPipeline {
    pub fn new(
        handle: AppHandle,
        config: &NativeAsrConfig,
        runtime_config: &Arc<RwLock<NativeAsrConfig>>,
        asr_engine_cache: Arc<AsrEngineCache>,
    ) -> Result<Self> {
        let vad_path = vad_model_path(&handle, config)?;
        let vad = OnnxRuntimeSileroVadEngine::new(&vad_path, config.vad_threshold)?;
        let asr_worker = AsrWorker::start(
            handle.clone(),
            config.clone(),
            runtime_config,
            asr_engine_cache,
        )?;

        Ok(Self {
            handle,
            segment_builder: SegmentBuilder::new(config),
            vad: Box::new(vad),
            asr_worker,
        })
    }

    pub fn process_chunk(&mut self, samples: &[f32]) -> Result<()> {
        let vad_result = self.vad.process(samples)?;
        let state = if vad_result.is_speech {
            VadState::Speech
        } else {
            VadState::Silence
        };
        let _ = self.handle.emit(
            "irodori-asr-vad-state",
            VadStateEvent {
                state,
                probability: vad_result.probability,
            },
        );
        let events = self.segment_builder.push(samples, vad_result);
        for event in events {
            match event {
                SegmentBuilderEvent::SegmentStarted { .. } | SegmentBuilderEvent::SegmentExtended { .. } => {}
                SegmentBuilderEvent::SegmentClosed {
                    full_audio,
                    reason,
                    segment_id: _,
                    previous_segment_id: _,
                    vad_results: _,
                } => {
                    self.asr_worker.send_segment_closed(full_audio, reason);
                }
                SegmentBuilderEvent::TurnCheckSilenceReached {
                    previous_segment_id: _,
                } => {
                    self.asr_worker.send_turn_check_silence_reached();
                }
            }
        }

        Ok(())
    }

    pub fn update_config(&mut self, config: &NativeAsrConfig) {
        self.segment_builder.update_config(config);
        self.vad.set_threshold(config.vad_threshold);
    }

    pub fn reset_turn(&mut self) {
        self.segment_builder.reset();
        self.vad.reset();
    }

    pub fn stop(mut self) {
        self.stop_inner();
    }

    fn stop_inner(&mut self) {
        self.asr_worker.stop_inner();
    }
}

impl Drop for RecognitionPipeline {
    fn drop(&mut self) {
        self.stop_inner();
    }
}
