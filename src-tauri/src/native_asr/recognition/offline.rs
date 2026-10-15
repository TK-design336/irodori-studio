//! File import transcription.
//!
//! Runs the exact chain the live microphone path uses — Silero VAD →
//! `SegmentBuilder` → sherpa-onnx ASR → Japanese post-processing — but
//! synchronously over already-decoded 16 kHz mono PCM instead of a cpal stream.

use anyhow::Result;

use super::segment_builder::{SegmentBuilder, SegmentBuilderEvent, SegmentCloseReason};
use crate::native_asr::{
    audio::ASR_SAMPLE_RATE,
    config::NativeAsrConfig,
    model::{AsrEngine, VadEngine},
    postprocess::{
        append_japanese_asr_segment, append_japanese_asr_segment_with_comma,
        finalize_japanese_utterance_text, postprocess_asr_segment_for_join,
    },
};

/// Same VAD hop as the live input path (32 ms @ 16 kHz).
const VAD_CHUNK_SAMPLES: usize = 512;
const LEAD_SILENCE_MS: usize = 400;
const TAIL_SILENCE_MS: usize = 1600;
/// Phrase mode: breaths stay on the same line with `、`.
const PHRASE_COMMA_SILENCE_MS: u32 = 320;
/// Phrase mode: only a pause at or above this becomes `。` + newline.
const PHRASE_NEWLINE_SILENCE_MS: u32 = 800;
/// Sentence mode (legacy): every pause is `。` + newline.
const SENTENCE_PAUSE_MS: u32 = 320;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportAsrBreak {
    /// Short pause → `、` on the same line; long pause → `。` and a newline.
    Phrase,
    /// Every pause → `。` and a newline.
    Sentence,
}

impl ImportAsrBreak {
    pub fn parse(value: &str) -> Self {
        if value.eq_ignore_ascii_case("sentence") {
            Self::Sentence
        } else {
            Self::Phrase
        }
    }
}

fn import_segment_config(config: &NativeAsrConfig, style: ImportAsrBreak) -> NativeAsrConfig {
    let mut cfg = config.clone();
    match style {
        ImportAsrBreak::Phrase => {
            cfg.interim_result_enabled = true;
            cfg.interim_result_silence_ms = PHRASE_COMMA_SILENCE_MS;
            cfg.turn_check_silence_ms = PHRASE_NEWLINE_SILENCE_MS;
        }
        ImportAsrBreak::Sentence => {
            cfg.interim_result_enabled = false;
            cfg.turn_check_silence_ms = SENTENCE_PAUSE_MS;
        }
    }
    cfg.normalized()
}

/// Transcribe `samples` (16 kHz mono, [-1, 1]) into finalized utterances.
pub fn transcribe_pcm_with_pipeline(
    config: &NativeAsrConfig,
    vad: &mut dyn VadEngine,
    asr: &mut dyn AsrEngine,
    samples: &[f32],
    style: ImportAsrBreak,
) -> Result<Vec<String>> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let lead = ASR_SAMPLE_RATE as usize * LEAD_SILENCE_MS / 1000;
    let tail = ASR_SAMPLE_RATE as usize * TAIL_SILENCE_MS / 1000;
    let mut pcm = Vec::with_capacity(lead + samples.len() + tail);
    pcm.resize(lead, 0.0);
    pcm.extend_from_slice(samples);
    pcm.resize(pcm.len() + tail, 0.0);

    let cfg = import_segment_config(config, style);
    let mut builder = SegmentBuilder::new(&cfg);
    vad.reset();

    let mut draft = String::new();
    let mut utterances: Vec<String> = Vec::new();
    let mut segments = 0usize;

    for chunk in pcm.chunks(VAD_CHUNK_SAMPLES) {
        let vad_result = vad.process(chunk)?;
        for event in builder.push(chunk, vad_result) {
            match event {
                SegmentBuilderEvent::SegmentClosed {
                    full_audio, reason, ..
                } => {
                    segments += 1;
                    let raw = asr.transcribe(&full_audio)?;
                    let segment = postprocess_asr_segment_for_join(&raw);
                    eprintln!(
                        "[import-asr] segment {segments} samples={} close={reason:?} text={:?}",
                        full_audio.len(),
                        segment.chars().take(40).collect::<String>()
                    );
                    if segment.is_empty() {
                        continue;
                    }
                    match style {
                        ImportAsrBreak::Sentence => {
                            append_japanese_asr_segment(&mut draft, &segment);
                            flush_utterance(&mut draft, &mut utterances);
                        }
                        ImportAsrBreak::Phrase => {
                            append_japanese_asr_segment_with_comma(&mut draft, &segment);
                            if reason == SegmentCloseReason::EndSilenceReached {
                                flush_utterance(&mut draft, &mut utterances);
                            }
                        }
                    }
                }
                SegmentBuilderEvent::TurnCheckSilenceReached { .. } => {
                    flush_utterance(&mut draft, &mut utterances);
                }
                SegmentBuilderEvent::SegmentStarted { .. }
                | SegmentBuilderEvent::SegmentExtended { .. } => {}
            }
        }
    }
    flush_utterance(&mut draft, &mut utterances);

    if segments == 0 && pcm.len() <= ASR_SAMPLE_RATE as usize * 30 {
        eprintln!("[import-asr] no speech segments detected; decoding whole clip once");
        let raw = asr.transcribe(&pcm)?;
        let segment = postprocess_asr_segment_for_join(&raw);
        if !segment.is_empty() {
            append_japanese_asr_segment(&mut draft, &segment);
            flush_utterance(&mut draft, &mut utterances);
        }
    }

    eprintln!(
        "[import-asr] done style={style:?} segments={segments} utterances={} chars={}",
        utterances.len(),
        utterances.iter().map(|u| u.chars().count()).sum::<usize>()
    );
    Ok(utterances)
}

fn flush_utterance(draft: &mut String, out: &mut Vec<String>) {
    if draft.trim().is_empty() {
        draft.clear();
        return;
    }
    let finalized = finalize_japanese_utterance_text(draft);
    if !finalized.is_empty() {
        out.push(finalized);
    }
    draft.clear();
}
