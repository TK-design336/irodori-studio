import { invoke } from "@tauri-apps/api/core";
import { isSupportedAudioName } from "./docImport/index";

const APPEND_CHUNK = 64 * 1024;

function filePathHint(file: File): string {
  const hinted = (file as File & { path?: string }).path;
  return typeof hinted === "string" ? hinted.trim() : "";
}

export function audioFileName(file: File): string {
  if (isSupportedAudioName(file.name)) return file.name;
  const type = (file.type || "").toLowerCase();
  const ext = type.includes("mpeg") || type === "audio/mp3" ? "mp3" : "wav";
  const base = file.name.replace(/\.[^.]+$/, "").trim() || "audio";
  return `${base}.${ext}`;
}

/** Runs the live-dictation ASR pipeline over an audio file; resolves with one utterance per line. */
async function transcribePath(path: string, fileName: string): Promise<string> {
  const text = await invoke<string>("transcribe_audio_file_cmd", { path, fileName });
  if (!text.trim()) {
    throw new Error("文字起こし結果が空です");
  }
  return text;
}

/** Write audio to the native cache in small chunks (WAV as one JSON number[] freezes the UI). */
async function writeTempFromBytes(fileName: string, data: Uint8Array): Promise<string> {
  const path = await invoke<string>("create_import_audio_temp_cmd", { fileName });
  for (let off = 0; off < data.length; off += APPEND_CHUNK) {
    const end = Math.min(off + APPEND_CHUNK, data.length);
    const chunk = Array.from(data.subarray(off, end));
    await invoke("append_import_audio_temp_cmd", { path, chunk });
  }
  return path;
}

export async function transcribeImportAudioPath(path: string): Promise<string> {
  const fileName = path.split(/[/\\]/).pop() || "audio.wav";
  return transcribePath(path, fileName);
}

/** Transcribe an imported mp3/wav and return script text. */
export async function transcribeImportAudio(file: File): Promise<string> {
  const name = audioFileName(file);
  const hinted = filePathHint(file);
  if (hinted) {
    try {
      return await transcribePath(hinted, name);
    } catch (e) {
      console.warn("[import-asr] path failed, retry with bytes", e);
    }
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const tempPath = await writeTempFromBytes(name, data);
  try {
    return await transcribePath(tempPath, name);
  } finally {
    await invoke("delete_file", { path: tempPath }).catch(() => undefined);
  }
}
