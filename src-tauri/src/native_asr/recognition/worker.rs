use std::{
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, SyncSender, TrySendError, sync_channel},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter};

use super::events::RecognizedPhrasePayload;
use super::segment_builder::SegmentCloseReason;
use crate::native_asr::{
    config::NativeAsrConfig,
    model::{AsrEngine, AsrEngineCache},
    postprocess::{
        append_japanese_asr_segment, finalize_japanese_utterance_text,
        interim_japanese_utterance_text, postprocess_asr_segment_for_join,
    },
};

pub(crate) enum AsrJob {
    SegmentClosed {
        full_audio: Vec<f32>,
        reason: SegmentCloseReason,
    },
    TurnCheckSilenceReached,
}

pub(crate) struct AsrWorker {
    sender: Option<SyncSender<AsrJob>>,
    stop_requested: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl AsrWorker {
    pub(crate) fn start(
        handle: AppHandle,
        config: NativeAsrConfig,
        runtime_config: &Arc<RwLock<NativeAsrConfig>>,
        asr_engine_cache: Arc<AsrEngineCache>,
    ) -> Result<Self> {
        let (sender, receiver) = sync_channel(4);
        let stop_requested = Arc::new(AtomicBool::new(false));
        let worker_stop = stop_requested.clone();
        let worker_config = runtime_config.clone();
        let join_handle = thread::Builder::new()
            .name("moirai-native-asr".to_string())
            .spawn(move || {
                run_asr_worker(
                    &handle,
                    &config,
                    &worker_config,
                    &receiver,
                    &worker_stop,
                    asr_engine_cache,
                );
            })
            .context("Failed to spawn ASR worker")?;

        Ok(Self {
            sender: Some(sender),
            stop_requested,
            join_handle: Some(join_handle),
        })
    }

    pub(crate) fn send_segment_closed(&self, full_audio: Vec<f32>, reason: SegmentCloseReason) {
        self.send_required(AsrJob::SegmentClosed { full_audio, reason });
    }

    pub(crate) fn send_turn_check_silence_reached(&self) {
        self.send_required(AsrJob::TurnCheckSilenceReached);
    }

    fn send_required(&self, job: AsrJob) {
        let Some(sender) = self.sender.as_ref() else {
            return;
        };
        match sender.try_send(job) {
            Ok(()) => {}
            Err(TrySendError::Full(job)) => {
                let sender = sender.clone();
                if let Err(err) = thread::Builder::new()
                    .name("moirai-native-asr-required-send".to_string())
                    .spawn(move || {
                        if let Err(err) = sender.send(job) {
                            log::warn!("Native ASR: dropping required job because worker stopped: {err}");
                        }
                    })
                {
                    log::warn!("Native ASR: failed to queue required job on helper thread: {err}");
                }
            }
            Err(TrySendError::Disconnected(_)) => {
                log::warn!("Native ASR: dropping required job because worker stopped");
            }
        }
    }

    pub(crate) fn stop_inner(&mut self) {
        self.stop_requested.store(true, Ordering::Release);
        self.sender.take();
        if let Some(join_handle) = self.join_handle.take() {
            if let Err(err) = join_handle.join() {
                log::warn!("ASR worker thread panicked: {err:?}");
            }
        }
    }
}

impl Drop for AsrWorker {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

fn run_asr_worker(
    handle: &AppHandle,
    config: &NativeAsrConfig,
    runtime_config: &Arc<RwLock<NativeAsrConfig>>,
    receiver: &Receiver<AsrJob>,
    stop_requested: &AtomicBool,
    asr_engine_cache: Arc<AsrEngineCache>,
) {
    let mut asr = match asr_engine_cache.take_or_build(handle, config) {
        Ok(Some(asr)) => Some(asr),
        Ok(None) => {
            log::error!("Native ASR: model dir not configured");
            None
        }
        Err(err) => {
            log::error!("Native ASR engine init failed: {err}");
            None
        }
    };

    let mut draft_text = String::new();

    while !stop_requested.load(Ordering::Acquire) {
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(job) => {
                handle_asr_job(handle, asr.as_mut(), &mut draft_text, job);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let _ = runtime_config;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if let Some(engine) = asr {
        asr_engine_cache.store(engine);
    }
}

fn handle_asr_job(
    handle: &AppHandle,
    asr: Option<&mut Box<dyn AsrEngine>>,
    draft_text: &mut String,
    job: AsrJob,
) {
    match job {
        AsrJob::SegmentClosed {
            full_audio,
            reason,
        } => {
            if full_audio.is_empty() {
                return;
            }
            let Some(asr) = asr else {
                return;
            };
            let started_at = Instant::now();
            let raw = match asr.transcribe(&full_audio) {
                Ok(text) if !text.is_empty() => text,
                Ok(_) => return,
                Err(err) => {
                    log::warn!("Native ASR transcribe: {err}");
                    return;
                }
            };
            let segment = postprocess_asr_segment_for_join(&raw);
            if segment.is_empty() {
                return;
            }
            append_japanese_asr_segment(draft_text, &segment);

            let elapsed_millis = started_at.elapsed().as_millis();
            let is_end_silence = matches!(reason, SegmentCloseReason::EndSilenceReached);
            let is_interim_close = matches!(
                reason,
                SegmentCloseReason::InterimResultSilenceReached | SegmentCloseReason::SegmentMaxChunksReached
            );

            log::info!(
                "Native ASR segment inference_ms={} audio_samples={} close={:?} emit={} draft_chars={} seg_preview={}",
                elapsed_millis,
                full_audio.len(),
                reason,
                if is_interim_close {
                    "interim"
                } else if is_end_silence {
                    "final"
                } else {
                    "none"
                },
                draft_text.chars().count(),
                segment.chars().take(80).collect::<String>()
            );

            if is_interim_close {
                let snapshot = interim_japanese_utterance_text(draft_text);
                emit_recognized_phrase(handle, snapshot, false);
                return;
            }
            if is_end_silence {
                let finalized = finalize_japanese_utterance_text(draft_text);
                emit_recognized_phrase(handle, finalized, true);
                draft_text.clear();
            }
        }
        AsrJob::TurnCheckSilenceReached => {
            if draft_text.is_empty() {
                return;
            }
            let finalized = finalize_japanese_utterance_text(draft_text);
            emit_recognized_phrase(handle, finalized, true);
            draft_text.clear();
        }
    }
}

fn emit_recognized_phrase(handle: &AppHandle, text: String, is_final: bool) {
    if text.is_empty() {
        return;
    }
    let _ = handle.emit(
        "irodori-asr-phrase",
        RecognizedPhrasePayload { text, is_final },
    );
}

