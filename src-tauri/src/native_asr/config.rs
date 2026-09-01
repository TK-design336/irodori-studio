use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AsrPrecision {
    Int8,
    Int8Float32,
    Float32,
}

impl Default for AsrPrecision {
    fn default() -> Self {
        Self::Int8Float32
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct NativeAsrConfig {
    pub input_device_id: Option<String>,
    pub input_device_host: Option<String>,
    pub input_device_name: Option<String>,
    pub asr_precision: AsrPrecision,
    pub asr_num_threads: i32,
    pub model_dir: Option<String>,
    pub vad_threshold: f32,
    pub vad_interval_ms: u32,
    // Legacy chunk thresholds (serde compat). SegmentBuilder uses segment_start_speech_ms / turn_check_silence_ms.
    pub pause_threshold: u32,
    pub phrase_threshold: u32,
    pub segment_start_speech_ms: u32,
    pub interim_result_enabled: bool,
    pub interim_result_silence_ms: u32,
    pub turn_check_silence_ms: u32,
}

impl Default for NativeAsrConfig {
    fn default() -> Self {
        Self {
            input_device_id: None,
            input_device_host: None,
            input_device_name: None,
            asr_precision: AsrPrecision::Int8Float32,
            asr_num_threads: 4,
            model_dir: None,
            vad_threshold: 0.5,
            vad_interval_ms: 32,
            pause_threshold: 10,
            phrase_threshold: 10,
            segment_start_speech_ms: 96,
            interim_result_enabled: true,
            interim_result_silence_ms: 200,
            turn_check_silence_ms: 320,
        }
        .normalized()
    }
}

impl NativeAsrConfig {
    pub fn normalized(mut self) -> Self {
        if self.vad_interval_ms != 32 {
            let previous_interval_ms = self.vad_interval_ms.max(1);
            self.pause_threshold = chunks_for_millis(
                self.pause_threshold.saturating_mul(previous_interval_ms),
                32,
            );
            self.phrase_threshold = chunks_for_millis(
                self.phrase_threshold.saturating_mul(previous_interval_ms),
                32,
            );
            self.vad_interval_ms = 32;
        }
        self.asr_num_threads = self.asr_num_threads.max(0);

        let interval = self.vad_interval_ms.max(1);
        self.segment_start_speech_ms = self.segment_start_speech_ms.max(interval);
        self.interim_result_silence_ms = self
            .interim_result_silence_ms
            .max(interval);
        self.turn_check_silence_ms = self.turn_check_silence_ms.max(interval);
        if self.interim_result_enabled {
            self.turn_check_silence_ms = self
                .turn_check_silence_ms
                .max(self.interim_result_silence_ms);
        }

        self
    }
}

fn chunks_for_millis(threshold_ms: u32, interval_ms: u32) -> u32 {
    threshold_ms.div_ceil(interval_ms).max(1)
}
