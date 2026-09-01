use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecognitionStatus {
    Idle,
    Listening,
    Stopped,
}

impl Default for RecognitionStatus {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VadState {
    Speech,
    Silence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadStateEvent {
    pub state: VadState,
    pub probability: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecognizedPhrasePayload {
    pub text: String,
    /// `false` while the utterance is still open (interim segment); `true` when the turn is finalized.
    pub is_final: bool,
}
