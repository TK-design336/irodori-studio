use std::collections::VecDeque;

use anyhow::{Context, Result};
use rubato::{
    Async, FixedAsync, PolynomialDegree, Resampler,
    audioadapter::{Adapter, AdapterMut},
};

const DEFAULT_VAD_INTERVAL_MS: u32 = 32;

pub(crate) struct MonoFastFixedInResampler {
    inner: MonoFastFixedInResamplerInner,
    pending: VecDeque<f32>,
    input_chunk_size: usize,
}

enum MonoFastFixedInResamplerInner {
    Identity,
    FastFixedIn {
        resampler: Async<f32>,
        output: Vec<f32>,
    },
}

impl MonoFastFixedInResampler {
    pub(crate) fn new(
        source_sample_rate: u32,
        target_sample_rate: u32,
        chunk_millis: u32,
    ) -> Result<Self> {
        let input_chunk_size = frames_for_millis(source_sample_rate, chunk_millis);
        if source_sample_rate == target_sample_rate {
            return Ok(Self {
                inner: MonoFastFixedInResamplerInner::Identity,
                pending: VecDeque::new(),
                input_chunk_size,
            });
        }

        let resampler = Async::<f32>::new_poly(
            f64::from(target_sample_rate) / f64::from(source_sample_rate),
            1.0,
            PolynomialDegree::Cubic,
            input_chunk_size,
            1,
            FixedAsync::Input,
        )
        .context("Failed to create FastFixedIn resampler")?;
        let output = vec![0.0; resampler.output_frames_max()];

        Ok(Self {
            inner: MonoFastFixedInResamplerInner::FastFixedIn { resampler, output },
            pending: VecDeque::new(),
            input_chunk_size,
        })
    }

    pub(crate) fn push(&mut self, samples: &[f32]) -> Result<Vec<Vec<f32>>> {
        self.pending.extend(samples.iter().copied());
        let mut chunks = Vec::new();

        while self.pending.len() >= self.input_chunk_size {
            let input: Vec<f32> = self.pending.drain(..self.input_chunk_size).collect();
            match &mut self.inner {
                MonoFastFixedInResamplerInner::Identity => chunks.push(input),
                MonoFastFixedInResamplerInner::FastFixedIn { resampler, output } => {
                    let input_adapter = SingleChannelInputAdapter::new(&input);
                    let mut output_adapter = SingleChannelOutputAdapter::new(output);
                    let (_, written) =
                        resampler.process_into_buffer(&input_adapter, &mut output_adapter, None)?;
                    chunks.push(output[..written].to_vec());
                }
            }
        }

        Ok(chunks)
    }
}

pub(crate) fn validated_vad_interval_ms(value: u32) -> u32 {
    match value {
        32 => value,
        _ => DEFAULT_VAD_INTERVAL_MS,
    }
}

fn frames_for_millis(sample_rate: u32, millis: u32) -> usize {
    ((u64::from(sample_rate) * u64::from(millis)) / 1000)
        .try_into()
        .unwrap_or(1)
}

struct SingleChannelInputAdapter<'a> {
    data: &'a [f32],
}

impl<'a> SingleChannelInputAdapter<'a> {
    fn new(data: &'a [f32]) -> Self {
        Self { data }
    }
}

impl<'a> Adapter<'a, f32> for SingleChannelInputAdapter<'a> {
    unsafe fn read_sample_unchecked(&self, channel: usize, frame: usize) -> f32 {
        debug_assert_eq!(channel, 0);
        unsafe { *self.data.get_unchecked(frame) }
    }

    fn channels(&self) -> usize {
        1
    }

    fn frames(&self) -> usize {
        self.data.len()
    }
}

struct SingleChannelOutputAdapter<'a> {
    data: &'a mut [f32],
}

impl<'a> SingleChannelOutputAdapter<'a> {
    fn new(data: &'a mut [f32]) -> Self {
        Self { data }
    }
}

impl<'a> Adapter<'a, f32> for SingleChannelOutputAdapter<'a> {
    unsafe fn read_sample_unchecked(&self, channel: usize, frame: usize) -> f32 {
        debug_assert_eq!(channel, 0);
        unsafe { *self.data.get_unchecked(frame) }
    }

    fn channels(&self) -> usize {
        1
    }

    fn frames(&self) -> usize {
        self.data.len()
    }
}

impl<'a> AdapterMut<'a, f32> for SingleChannelOutputAdapter<'a> {
    unsafe fn write_sample_unchecked(&mut self, channel: usize, frame: usize, value: &f32) -> bool {
        debug_assert_eq!(channel, 0);
        unsafe {
            *self.data.get_unchecked_mut(frame) = *value;
        }
        false
    }
}
