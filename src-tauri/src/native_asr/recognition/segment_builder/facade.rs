// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Parakeet Inc.
// SegmentBuilder logic adapted from Parapper (https://github.com/parakeet-inc/Parapper).

use std::collections::VecDeque;

use crate::native_asr::{config::NativeAsrConfig, model::VadResult};

use super::{
    buffer::{PreSegmentBuffer, SegmentChunk},
    config::SegmentBuilderConfig,
};

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SegmentBuilderEvent {
    SegmentStarted {
        segment_id: u64,
        previous_segment_id: Option<u64>,
        audio_so_far: Vec<f32>,
        vad_results: Vec<VadResult>,
    },
    SegmentExtended {
        segment_id: u64,
        previous_segment_id: Option<u64>,
        new_audio: Vec<f32>,
        vad_result: VadResult,
    },
    SegmentClosed {
        segment_id: u64,
        previous_segment_id: Option<u64>,
        full_audio: Vec<f32>,
        vad_results: Vec<VadResult>,
        reason: SegmentCloseReason,
    },
    TurnCheckSilenceReached {
        previous_segment_id: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SegmentCloseReason {
    InterimResultSilenceReached,
    EndSilenceReached,
    SegmentMaxChunksReached,
}

pub(crate) struct SegmentBuilder {
    config: SegmentBuilderConfig,
    state: SegmentBuilderState,
    next_segment_id: u64,
    pending_previous_segment_id: Option<u64>,
}

enum SegmentBuilderState {
    Idle {
        pre_speech: PreSegmentBuffer,
        pending_speech_chunks: VecDeque<SegmentChunk>,
    },
    AfterInterimSilence {
        pre_speech: PreSegmentBuffer,
        pending_speech_chunks: VecDeque<SegmentChunk>,
        previous_segment_id: u64,
        silence_chunks: u32,
    },
    Active(SegmentInProgress),
}

#[derive(Debug, Clone)]
struct SegmentInProgress {
    id: u64,
    previous_segment_id: Option<u64>,
    audio: Vec<f32>,
    chunks: Vec<SegmentChunk>,
    audio_chunks: u32,
    silence_chunks: u32,
}

impl SegmentBuilder {
    pub(crate) fn new(config: &NativeAsrConfig) -> Self {
        let config = SegmentBuilderConfig::from_config(config);
        Self {
            state: SegmentBuilderState::new(&config),
            config,
            next_segment_id: 1,
            pending_previous_segment_id: None,
        }
    }

    pub(crate) fn push(&mut self, samples: &[f32], vad_result: VadResult) -> Vec<SegmentBuilderEvent> {
        let mut events = Vec::new();
        let state = std::mem::replace(&mut self.state, SegmentBuilderState::new(&self.config));
        self.state = match state {
            SegmentBuilderState::Idle {
                mut pre_speech,
                mut pending_speech_chunks,
            } => {
                if vad_result.is_speech {
                    pending_speech_chunks.push_back(SegmentChunk {
                        audio: samples.to_vec(),
                        vad: vad_result,
                    });
                    if pending_speech_chunks.len() >= self.config.segment_start_threshold as usize {
                        let segment_id = self.take_next_segment_id();
                        let previous_segment_id = self.pending_previous_segment_id.take();
                        let mut audio_so_far = Vec::new();
                        let mut chunks = pre_speech.drain_into(&mut audio_so_far);
                        let mut vad_results = chunks.iter().map(|chunk| chunk.vad).collect::<Vec<_>>();
                        for chunk in pending_speech_chunks.drain(..) {
                            audio_so_far.extend_from_slice(&chunk.audio);
                            vad_results.push(chunk.vad);
                            chunks.push(chunk);
                        }
                        events.push(SegmentBuilderEvent::SegmentStarted {
                            segment_id,
                            previous_segment_id,
                            audio_so_far: audio_so_far.clone(),
                            vad_results,
                        });
                        SegmentBuilderState::Active(SegmentInProgress {
                            id: segment_id,
                            previous_segment_id,
                            audio: audio_so_far,
                            chunks,
                            audio_chunks: self.config.segment_start_threshold,
                            silence_chunks: 0,
                        })
                    } else {
                        SegmentBuilderState::Idle {
                            pre_speech,
                            pending_speech_chunks,
                        }
                    }
                } else {
                    self.pending_previous_segment_id = None;
                    pending_speech_chunks.clear();
                    pre_speech.push(samples, vad_result);
                    SegmentBuilderState::Idle {
                        pre_speech,
                        pending_speech_chunks,
                    }
                }
            }
            SegmentBuilderState::AfterInterimSilence {
                mut pre_speech,
                mut pending_speech_chunks,
                previous_segment_id,
                mut silence_chunks,
            } => {
                if vad_result.is_speech {
                    pending_speech_chunks.push_back(SegmentChunk {
                        audio: samples.to_vec(),
                        vad: vad_result,
                    });
                    if pending_speech_chunks.len() >= self.config.segment_start_threshold as usize {
                        let segment_id = self.take_next_segment_id();
                        let mut audio_so_far = Vec::new();
                        let mut chunks = pre_speech.drain_into(&mut audio_so_far);
                        let mut vad_results = chunks.iter().map(|chunk| chunk.vad).collect::<Vec<_>>();
                        for chunk in pending_speech_chunks.drain(..) {
                            audio_so_far.extend_from_slice(&chunk.audio);
                            vad_results.push(chunk.vad);
                            chunks.push(chunk);
                        }
                        events.push(SegmentBuilderEvent::SegmentStarted {
                            segment_id,
                            previous_segment_id: Some(previous_segment_id),
                            audio_so_far: audio_so_far.clone(),
                            vad_results,
                        });
                        SegmentBuilderState::Active(SegmentInProgress {
                            id: segment_id,
                            previous_segment_id: Some(previous_segment_id),
                            audio: audio_so_far,
                            chunks,
                            audio_chunks: self.config.segment_start_threshold,
                            silence_chunks: 0,
                        })
                    } else {
                        SegmentBuilderState::AfterInterimSilence {
                            pre_speech,
                            pending_speech_chunks,
                            previous_segment_id,
                            silence_chunks,
                        }
                    }
                } else {
                    pending_speech_chunks.clear();
                    pre_speech.push(samples, vad_result);
                    silence_chunks = silence_chunks.saturating_add(1);
                    if silence_chunks >= self.config.turn_check_threshold {
                        events.push(SegmentBuilderEvent::TurnCheckSilenceReached {
                            previous_segment_id,
                        });
                        SegmentBuilderState::Idle {
                            pre_speech,
                            pending_speech_chunks,
                        }
                    } else {
                        SegmentBuilderState::AfterInterimSilence {
                            pre_speech,
                            pending_speech_chunks,
                            previous_segment_id,
                            silence_chunks,
                        }
                    }
                }
            }
            SegmentBuilderState::Active(mut active) => {
                active.audio_chunks = active.audio_chunks.saturating_add(1);
                active.audio.extend_from_slice(samples);
                active.chunks.push(SegmentChunk {
                    audio: samples.to_vec(),
                    vad: vad_result,
                });
                events.push(SegmentBuilderEvent::SegmentExtended {
                    segment_id: active.id,
                    previous_segment_id: active.previous_segment_id,
                    new_audio: samples.to_vec(),
                    vad_result,
                });

                if vad_result.is_speech {
                    active.silence_chunks = 0;
                } else {
                    active.silence_chunks = active.silence_chunks.saturating_add(1);
                }

                let close_reason = if active.audio_chunks >= self.config.max_chunks {
                    Some(SegmentCloseReason::SegmentMaxChunksReached)
                } else if active.silence_chunks >= self.config.turn_check_threshold {
                    Some(SegmentCloseReason::EndSilenceReached)
                } else if self
                    .config
                    .interim_result_threshold
                    .is_some_and(|threshold| active.silence_chunks >= threshold)
                {
                    Some(SegmentCloseReason::InterimResultSilenceReached)
                } else {
                    None
                };

                if let Some(reason) = close_reason {
                    let next_state = state_after_close(&active, reason, &self.config);
                    self.pending_previous_segment_id =
                        if reason == SegmentCloseReason::SegmentMaxChunksReached {
                            Some(active.id)
                        } else {
                            None
                        };
                    events.push(SegmentBuilderEvent::SegmentClosed {
                        segment_id: active.id,
                        previous_segment_id: active.previous_segment_id,
                        full_audio: active.audio,
                        vad_results: active.chunks.iter().map(|chunk| chunk.vad).collect(),
                        reason,
                    });
                    next_state
                } else {
                    SegmentBuilderState::Active(active)
                }
            }
        };
        events
    }

    pub(crate) fn update_config(&mut self, config: &NativeAsrConfig) {
        let next_config = SegmentBuilderConfig::from_config(config);
        self.state.update_config(&next_config);
        self.config = next_config;
    }

    fn take_next_segment_id(&mut self) -> u64 {
        let segment_id = self.next_segment_id;
        self.next_segment_id = self.next_segment_id.saturating_add(1);
        segment_id
    }
}

fn state_after_close(
    active: &SegmentInProgress,
    reason: SegmentCloseReason,
    config: &SegmentBuilderConfig,
) -> SegmentBuilderState {
    match reason {
        SegmentCloseReason::InterimResultSilenceReached => {
            let trailing_silence = trailing_silence_chunks(active);
            let silence_chunks = trailing_silence.len().try_into().unwrap_or(u32::MAX);
            let mut pre_speech = PreSegmentBuffer::new(config.pre_speech_max_chunks);
            for chunk in trailing_silence {
                pre_speech.push_chunk(chunk);
            }
            SegmentBuilderState::AfterInterimSilence {
                pre_speech,
                pending_speech_chunks: VecDeque::new(),
                previous_segment_id: active.id,
                silence_chunks,
            }
        }
        SegmentCloseReason::EndSilenceReached => {
            SegmentBuilderState::new_with_pre_speech_chunks(config, trailing_silence_chunks(active))
        }
        SegmentCloseReason::SegmentMaxChunksReached => SegmentBuilderState::new(config),
    }
}

fn trailing_silence_chunks(active: &SegmentInProgress) -> Vec<SegmentChunk> {
    let mut trailing_silence = active
        .chunks
        .iter()
        .rev()
        .take_while(|chunk| !chunk.vad.is_speech)
        .cloned()
        .collect::<Vec<_>>();
    trailing_silence.reverse();
    trailing_silence
}

impl SegmentBuilderState {
    fn new(config: &SegmentBuilderConfig) -> Self {
        Self::Idle {
            pre_speech: PreSegmentBuffer::new(config.pre_speech_max_chunks),
            pending_speech_chunks: VecDeque::new(),
        }
    }

    fn new_with_pre_speech_chunks(config: &SegmentBuilderConfig, chunks: Vec<SegmentChunk>) -> Self {
        let mut pre_speech = PreSegmentBuffer::new(config.pre_speech_max_chunks);
        for chunk in chunks {
            pre_speech.push_chunk(chunk);
        }
        Self::Idle {
            pre_speech,
            pending_speech_chunks: VecDeque::new(),
        }
    }

    fn update_config(&mut self, config: &SegmentBuilderConfig) {
        match self {
            Self::Idle { pre_speech, .. } | Self::AfterInterimSilence { pre_speech, .. } => {
                pre_speech.update_max_chunks(config.pre_speech_max_chunks);
            }
            Self::Active(_) => {}
        }
    }
}
