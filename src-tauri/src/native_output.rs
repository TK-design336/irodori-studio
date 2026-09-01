//! WASAPI/cpal playback so the live tab can pick an output device in WebView2.

use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
};
use std::time::Duration;

use anyhow::{Context, Result};
use cpal::{
    Sample, SampleFormat, SizedSample, Stream, StreamConfig,
    traits::{DeviceTrait, StreamTrait},
};
use dasp_sample::FromSample;
use hound::WavReader;

use crate::native_asr::audio::{collect_output_devices, resolve_output_device};

pub struct NativeOutputState {
    inner: Arc<PlayerInner>,
}

struct PlayerInner {
    volume: AtomicU32,
    stop: AtomicBool,
    gen: AtomicU64,
    current: Mutex<Option<ActivePlayback>>,
}

struct ActivePlayback {
    _stream: Stream,
    done: Arc<(Mutex<bool>, Condvar)>,
}

struct OutputShared {
    samples: Vec<f32>,
    pos: AtomicUsize,
    player: Arc<PlayerInner>,
    done: Arc<(Mutex<bool>, Condvar)>,
    gen: u64,
}

impl Default for NativeOutputState {
    fn default() -> Self {
        Self {
            inner: Arc::new(PlayerInner {
                volume: AtomicU32::new(1.0f32.to_bits()),
                stop: AtomicBool::new(false),
                gen: AtomicU64::new(0),
                current: Mutex::new(None),
            }),
        }
    }
}

impl NativeOutputState {
    fn set_volume(&self, volume: f32) {
        self.inner
            .volume
            .store(volume.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
    }

    fn request_stop(&self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        self.inner.gen.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut current) = self.inner.current.lock() {
            if let Some(active) = current.take() {
                mark_done(&active.done);
            }
        }
    }

    fn play_path(&self, path: &str, device_key: &str, volume: f32) -> Result<()> {
        self.request_stop();
        self.inner.stop.store(false, Ordering::SeqCst);
        self.set_volume(volume);
        let my_gen = self.inner.gen.load(Ordering::SeqCst);

        let selection = resolve_output_device(device_key)?;
        let (src_rate, mono) = wav_to_mono_f32(path)?;
        let dst_rate = selection.device_info.sample_rate.max(1);
        let resampled = resample_linear(&mono, src_rate.max(1), dst_rate);
        let interleaved = expand_channels(&resampled, selection.stream_config.channels.max(1));

        let done = Arc::new((Mutex::new(false), Condvar::new()));
        let shared = Arc::new(OutputShared {
            samples: interleaved,
            pos: AtomicUsize::new(0),
            player: Arc::clone(&self.inner),
            done: done.clone(),
            gen: my_gen,
        });
        let stream = build_output_stream(
            &selection.device,
            &selection.stream_config,
            selection.sample_format,
            shared,
        )?;
        stream.play().context("出力ストリームの開始に失敗しました")?;

        {
            let mut current = self
                .inner
                .current
                .lock()
                .map_err(|_| anyhow::anyhow!("出力ロック取得に失敗しました"))?;
            *current = Some(ActivePlayback {
                _stream: stream,
                done: done.clone(),
            });
        }

        loop {
            if self.inner.stop.load(Ordering::SeqCst)
                || self.inner.gen.load(Ordering::SeqCst) != my_gen
            {
                break;
            }
            let (lock, cv) = &*done;
            let Ok(finished) = lock.lock() else {
                break;
            };
            if *finished {
                break;
            }
            let Ok((guard, _)) = cv.wait_timeout(finished, Duration::from_millis(40)) else {
                break;
            };
            drop(guard);
        }

        if self.inner.gen.load(Ordering::SeqCst) == my_gen {
            if let Ok(mut current) = self.inner.current.lock() {
                *current = None;
            }
        }
        Ok(())
    }
}

fn mark_done(done: &Arc<(Mutex<bool>, Condvar)>) {
    if let Ok(mut guard) = done.0.lock() {
        if !*guard {
            *guard = true;
            done.1.notify_all();
        }
    }
}

fn wav_to_mono_f32(path: &str) -> Result<(u32, Vec<f32>)> {
    let reader = WavReader::open(path).map_err(|e| anyhow::anyhow!("WAV を開けません: {e}"))?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .filter_map(Result::ok)
            .collect(),
        hound::SampleFormat::Int => {
            let shift = spec.bits_per_sample.min(31).saturating_sub(1);
            let max = (1i64 << shift) as f32;
            let max = if max < 1.0 { 32768.0 } else { max };
            reader
                .into_samples::<i32>()
                .filter_map(Result::ok)
                .map(|s| (s as f32 / max).clamp(-1.0, 1.0))
                .collect()
        }
    };
    let mono = if channels <= 1 {
        samples
    } else {
        samples
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
            .collect()
    };
    Ok((spec.sample_rate, mono))
}

fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if input.is_empty() || from == 0 || to == 0 || from == to {
        return input.to_vec();
    }
    let ratio = f64::from(to) / f64::from(from);
    let out_len = ((input.len() as f64) * ratio).round().max(1.0) as usize;
    let last = input.len() - 1;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let i0 = (src.floor() as usize).min(last);
        let i1 = (i0 + 1).min(last);
        let frac = (src - i0 as f64) as f32;
        out.push(input[i0] + (input[i1] - input[i0]) * frac);
    }
    out
}

fn expand_channels(mono: &[f32], channels: u16) -> Vec<f32> {
    let ch = usize::from(channels.max(1));
    if ch == 1 {
        return mono.to_vec();
    }
    let mut out = Vec::with_capacity(mono.len() * ch);
    for &sample in mono {
        for _ in 0..ch {
            out.push(sample);
        }
    }
    out
}

fn build_output_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<OutputShared>,
) -> Result<Stream> {
    crate::dispatch_cpal_sample_format!(
        sample_format,
        build_output_stream_inner,
        device,
        config,
        shared;
        unsupported => anyhow::bail!("未対応の出力サンプル形式です: {sample_format:?}")
    )
}

fn build_output_stream_inner<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    shared: Arc<OutputShared>,
) -> Result<Stream>
where
    T: Sample + SizedSample + FromSample<f32>,
{
    let err_fn = |err| log::warn!("Audio output stream error: {err}");
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                let player = &shared.player;
                let stale = player.gen.load(Ordering::Relaxed) != shared.gen
                    || player.stop.load(Ordering::Relaxed);
                if stale {
                    for sample in data.iter_mut() {
                        *sample = T::from_sample_(0.0);
                    }
                    mark_done(&shared.done);
                    return;
                }
                let vol = f32::from_bits(player.volume.load(Ordering::Relaxed));
                let mut pos = shared.pos.load(Ordering::Relaxed);
                let samples = &shared.samples;
                for out in data.iter_mut() {
                    if pos >= samples.len() {
                        *out = T::from_sample_(0.0);
                    } else {
                        *out = T::from_sample_((samples[pos] * vol).clamp(-1.0, 1.0));
                        pos += 1;
                    }
                }
                shared.pos.store(pos, Ordering::Relaxed);
                if pos >= samples.len() {
                    mark_done(&shared.done);
                }
            },
            err_fn,
            None,
        )
        .context("出力ストリームの作成に失敗しました")
}

#[tauri::command]
pub fn native_audio_list_outputs() -> Vec<crate::native_asr::audio::DeviceInfo> {
    collect_output_devices()
}

#[tauri::command]
pub fn native_audio_set_volume(state: tauri::State<'_, NativeOutputState>, volume: f32) {
    state.set_volume(volume);
}

#[tauri::command]
pub fn native_audio_stop(state: tauri::State<'_, NativeOutputState>) {
    state.request_stop();
}

#[tauri::command]
pub async fn native_audio_play_path(
    state: tauri::State<'_, NativeOutputState>,
    path: String,
    device_id: String,
    volume: f32,
) -> Result<(), String> {
    let inner = Arc::clone(&state.inner);
    let wrapper = NativeOutputState { inner };
    tauri::async_runtime::spawn_blocking(move || wrapper.play_path(&path, &device_id, volume))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
