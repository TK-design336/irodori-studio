use std::{
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, sync_channel},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use anyhow::{Context, Result};
use cpal::{Stream, traits::StreamTrait};
use tauri::{AppHandle, Emitter};

use crate::native_asr::{
    config::NativeAsrConfig,
    model::AsrEngineCache,
    recognition::RecognitionPipeline,
};

use super::{
    device::selected_input_device,
    resampler::{MonoFastFixedInResampler, validated_vad_interval_ms},
    stream::{InputChunk, build_input_stream, peak_level},
};

pub const ASR_SAMPLE_RATE: u32 = 16_000;
const INPUT_QUEUE_SIZE: usize = 8;

pub struct RunningAudioInput {
    stop_requested: Arc<AtomicBool>,
    pause_requested: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl RunningAudioInput {
    pub fn start(
        handle: AppHandle,
        config: &NativeAsrConfig,
        runtime_config: Arc<RwLock<NativeAsrConfig>>,
        asr_engine_cache: Arc<AsrEngineCache>,
        initial_pcm: Option<Vec<f32>>,
    ) -> Result<Self> {
        let selection = selected_input_device(config)?;
        let source_sample_rate = selection.stream_config.sample_rate;
        let (sender, receiver) = sync_channel(INPUT_QUEUE_SIZE);
        let stream = build_input_stream(
            &selection.device,
            &selection.stream_config,
            selection.sample_format,
            sender,
        )?;
        stream.play().context("Failed to start input stream")?;

        log::info!(
            "Native ASR audio input: {} [{}] {} Hz, {} channel(s){}",
            selection.device_info.display_name,
            selection.device_info.host,
            source_sample_rate,
            selection.stream_config.channels,
            if initial_pcm.as_ref().is_some_and(|p| !p.is_empty()) {
                format!(
                    " (+{} ms wake preroll)",
                    initial_pcm.as_ref().map(|p| p.len()).unwrap_or(0) * 1000
                        / ASR_SAMPLE_RATE as usize
                )
            } else {
                String::new()
            }
        );

        let stop_requested = Arc::new(AtomicBool::new(false));
        let pause_requested = Arc::new(AtomicBool::new(false));
        let worker_stop = stop_requested.clone();
        let worker_pause = pause_requested.clone();
        let recognition_config = config.clone();
        let join_handle = thread::Builder::new()
            .name("moirai-native-asr-audio".to_string())
            .spawn(move || {
                run_audio_worker(
                    &handle,
                    &recognition_config,
                    &runtime_config,
                    &receiver,
                    source_sample_rate,
                    &worker_stop,
                    &worker_pause,
                    asr_engine_cache,
                    initial_pcm,
                    stream,
                );
            })
            .context("Failed to spawn audio worker")?;

        Ok(Self {
            stop_requested,
            pause_requested,
            join_handle: Some(join_handle),
        })
    }

    pub fn stop(mut self) {
        self.stop_inner();
    }

    pub fn set_paused(&self, paused: bool) {
        self.pause_requested.store(paused, Ordering::SeqCst);
    }

    fn stop_inner(&mut self) {
        self.stop_requested.store(true, Ordering::Release);
        if let Some(join_handle) = self.join_handle.take() {
            if let Err(err) = join_handle.join() {
                log::warn!("Audio worker thread panicked: {err:?}");
            }
        }
    }
}

impl Drop for RunningAudioInput {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

fn run_audio_worker(
    handle: &AppHandle,
    config: &NativeAsrConfig,
    runtime_config: &Arc<RwLock<NativeAsrConfig>>,
    receiver: &Receiver<InputChunk>,
    source_sample_rate: u32,
    stop_requested: &AtomicBool,
    pause_requested: &AtomicBool,
    asr_engine_cache: Arc<AsrEngineCache>,
    initial_pcm: Option<Vec<f32>>,
    stream: Stream,
) {
    let mut vad_interval_ms = validated_vad_interval_ms(config.vad_interval_ms);
    let mut resampler =
        match MonoFastFixedInResampler::new(source_sample_rate, ASR_SAMPLE_RATE, vad_interval_ms) {
            Ok(resampler) => resampler,
            Err(err) => {
                log::error!("Native ASR resampler init failed: {err}");
                return;
            }
        };
    let mut recognition = match RecognitionPipeline::new(
        handle.clone(),
        config,
        runtime_config,
        asr_engine_cache,
    ) {
        Ok(recognition) => Some(recognition),
        Err(err) => {
            log::error!("Native ASR pipeline init failed: {err}");
            None
        }
    };

    if let Some(pcm) = initial_pcm.filter(|p| !p.is_empty()) {
        feed_resampled_pcm(handle, recognition.as_mut(), &pcm);
    }

    let mut pipeline_paused = false;
    while !stop_requested.load(Ordering::Acquire) {
        let paused = pause_requested.load(Ordering::Acquire);
        if paused != pipeline_paused {
            if let Some(recognition) = recognition.as_mut() {
                recognition.reset_turn();
            }
            pipeline_paused = paused;
        }
        let current_config = runtime_config
            .read()
            .map_or_else(|_| config.clone(), |c| c.clone());
        let current_vad_interval_ms = validated_vad_interval_ms(current_config.vad_interval_ms);
        if current_vad_interval_ms != vad_interval_ms {
            match MonoFastFixedInResampler::new(
                source_sample_rate,
                ASR_SAMPLE_RATE,
                current_vad_interval_ms,
            ) {
                Ok(next_resampler) => {
                    resampler = next_resampler;
                    vad_interval_ms = current_vad_interval_ms;
                }
                Err(err) => {
                    log::warn!("Native ASR resampler reinit failed: {err}");
                }
            }
        }
        if let Some(recognition) = recognition.as_mut() {
            recognition.update_config(&current_config);
        }

        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(chunk) => {
                if paused {
                    let _ = handle.emit("irodori-asr-input-level", 0.0f32);
                } else {
                    process_input_chunk(
                        handle,
                        &mut resampler,
                        recognition.as_mut(),
                        &chunk,
                    );
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // マイクを先に解放してから ASR ワーカーを止める（ウェイクワード再開・設定 UI のブロック回避）
    drop(stream);

    if let Some(recognition) = recognition {
        recognition.stop();
    }
}

fn feed_resampled_pcm(
    handle: &AppHandle,
    mut recognition: Option<&mut RecognitionPipeline>,
    pcm: &[f32],
) {
    // 検出直後の先頭はウェイクワード残響になりやすいので ASR 投入前にスキップ
    const SKIP_HEAD_SAMPLES: usize = ASR_SAMPLE_RATE as usize * 180 / 1000;
    let pcm = if pcm.len() > SKIP_HEAD_SAMPLES {
        &pcm[SKIP_HEAD_SAMPLES..]
    } else {
        return;
    };
    const CHUNK: usize = 512;
    for samples in pcm.chunks(CHUNK) {
        let level = peak_level(samples);
        let _ = handle.emit("irodori-asr-input-level", level);
        if let Some(recognition) = recognition.as_deref_mut() {
            if let Err(err) = recognition.process_chunk(samples) {
                log::warn!("Native ASR wake preroll: {err}");
            }
        }
    }
}

fn process_input_chunk(
    handle: &AppHandle,
    resampler: &mut MonoFastFixedInResampler,
    mut recognition: Option<&mut RecognitionPipeline>,
    chunk: &InputChunk,
) {
    let Ok(resampled_chunks) = resampler.push(&chunk.samples) else {
        log::warn!("Native ASR: resample failed");
        return;
    };
    for samples in resampled_chunks {
        let level = peak_level(&samples);
        let _ = handle.emit("irodori-asr-input-level", level);
        if let Some(recognition) = recognition.as_deref_mut() {
            if let Err(err) = recognition.process_chunk(&samples) {
                log::warn!("Native ASR VAD/pipeline: {err}");
            }
        }
    }
}
