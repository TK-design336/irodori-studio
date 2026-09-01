import { invoke } from "@tauri-apps/api/core";

export type NativeAsrPrecision = "int8" | "int8_float32" | "float32";

export type NativeAsrConfigWire = {
  input_device_id: string | null;
  input_device_host: string | null;
  input_device_name: string | null;
  asr_precision: NativeAsrPrecision;
  asr_num_threads: number;
  model_dir: string | null;
  vad_threshold: number;
  vad_interval_ms: number;
  pause_threshold: number;
  phrase_threshold: number;
  segment_start_speech_ms: number;
  interim_result_enabled: boolean;
  interim_result_silence_ms: number;
  turn_check_silence_ms: number;
};

const DEFAULT_TUNING = {
  turnCheckSilenceMs: 320,
  segmentStartMs: 96,
  interimSilenceMs: 200,
  vadThreshold: 0.5,
  numThreads: 4,
};

export function buildNativeAsrConfig(deviceId = ""): NativeAsrConfigWire {
  return {
    input_device_id: deviceId || null,
    input_device_host: null,
    input_device_name: null,
    asr_precision: "int8_float32",
    asr_num_threads: DEFAULT_TUNING.numThreads,
    model_dir: null,
    vad_threshold: DEFAULT_TUNING.vadThreshold,
    vad_interval_ms: 32,
    pause_threshold: 10,
    phrase_threshold: 10,
    segment_start_speech_ms: DEFAULT_TUNING.segmentStartMs,
    interim_result_enabled: true,
    interim_result_silence_ms: DEFAULT_TUNING.interimSilenceMs,
    turn_check_silence_ms: DEFAULT_TUNING.turnCheckSilenceMs,
  };
}

export async function syncNativeAsrConfig(deviceId = ""): Promise<void> {
  await invoke("native_asr_set_config", { config: buildNativeAsrConfig(deviceId) });
}

export async function ensureNativeAsrModels(): Promise<void> {
  const status = await invoke<{
    vad: { installed: boolean };
    asr: { installed: boolean };
  }>("native_asr_get_model_status");
  if (status.vad.installed && status.asr.installed) return;
  await invoke("native_asr_download_models");
}

export async function preloadNativeAsr(): Promise<void> {
  await syncNativeAsrConfig();
  const status = await invoke<{
    vad: { installed: boolean };
    asr: { installed: boolean };
  }>("native_asr_get_model_status");
  if (!status.vad.installed || !status.asr.installed) return;
  await invoke("native_asr_preload");
}
