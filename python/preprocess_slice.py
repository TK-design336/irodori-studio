#!/usr/bin/env python3
"""Audio slicing: silence (pydub) or Silero VAD (ONNX CPU)."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from pydub import AudioSegment
from pydub.silence import split_on_silence

VAD_SR = 16000


def emit_fraction(i: int, n: int, detail: str = "") -> None:
    frac = (i / n) if n else 1.0
    payload = {"fraction": frac, "current": i, "total": n}
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def normalize_method(raw: str) -> str:
    v = (raw or "").strip().lower()
    if v in ("silero", "vad", "silero-vad", "silero_vad"):
        return "silero"
    return "silence"


def slice_on_silence(
    audio: AudioSegment,
    *,
    min_silence_len: int,
    silence_thresh: int,
    keep_silence: int,
    min_chunk_ms: int,
) -> list[AudioSegment]:
    chunks = split_on_silence(
        audio,
        min_silence_len=int(min_silence_len),
        silence_thresh=int(silence_thresh),
        keep_silence=int(keep_silence),
    )
    return [c for c in chunks if len(c) >= int(min_chunk_ms)]


def _pydub_to_16k_mono_float(audio: AudioSegment):
    import numpy as np

    mono16 = audio.set_channels(1).set_frame_rate(VAD_SR)
    samples = np.array(mono16.get_array_of_samples())
    sw = int(mono16.sample_width)
    if sw == 1:
        x = (samples.astype(np.float32) - 128.0) / 128.0
    elif sw == 2:
        x = samples.astype(np.float32) / 32768.0
    elif sw == 4:
        x = samples.astype(np.float32) / 2147483648.0
    else:
        x = samples.astype(np.float32)
        peak = float(np.max(np.abs(x))) or 1.0
        x = x / peak
    return np.clip(x, -1.0, 1.0).astype(np.float32)


def _merge_segments(
    segments: list[dict[str, float]],
    *,
    max_gap_s: float,
    max_len_s: float,
) -> list[dict[str, float]]:
    if not segments:
        return []
    out = [{"start": float(segments[0]["start"]), "end": float(segments[0]["end"])}]
    for seg in segments[1:]:
        start = float(seg["start"])
        end = float(seg["end"])
        gap = start - out[-1]["end"]
        combined = end - out[-1]["start"]
        if gap <= max_gap_s and combined <= max_len_s:
            out[-1]["end"] = end
        else:
            out.append({"start": start, "end": end})
    return out


def load_silero_model() -> Any:
    # VAD is CPU/ONNX; keep this subprocess off the GPU.
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    os.environ.setdefault("ORT_DISABLE_CUDA", "1")
    from silero_vad import load_silero_vad

    print("Loading Silero VAD (ONNX CPU)", flush=True)
    return load_silero_vad(onnx=True)


def slice_on_silero(
    audio: AudioSegment,
    model: Any,
    *,
    min_silence_ms: int,
    speech_pad_ms: int,
    min_chunk_ms: int,
    max_chunk_s: float,
    merge_gap_ms: int,
    threshold: float,
) -> list[AudioSegment]:
    import torch
    from silero_vad import get_speech_timestamps

    wav = torch.from_numpy(_pydub_to_16k_mono_float(audio))
    if wav.numel() < 512:
        return []

    timestamps = get_speech_timestamps(
        wav,
        model,
        sampling_rate=VAD_SR,
        threshold=float(threshold),
        min_speech_duration_ms=250,
        max_speech_duration_s=float(max_chunk_s),
        min_silence_duration_ms=int(min_silence_ms),
        speech_pad_ms=int(speech_pad_ms),
        return_seconds=True,
    )
    merged = _merge_segments(
        timestamps,
        max_gap_s=max(0, int(merge_gap_ms)) / 1000.0,
        max_len_s=float(max_chunk_s),
    )
    duration_ms = len(audio)
    chunks: list[AudioSegment] = []
    for seg in merged:
        start_ms = int(max(0.0, float(seg["start"]) * 1000.0))
        end_ms = int(min(float(duration_ms), float(seg["end"]) * 1000.0))
        if end_ms - start_ms < int(min_chunk_ms):
            continue
        chunks.append(audio[start_ms:end_ms])
    return chunks


def main() -> int:
    parser = argparse.ArgumentParser(description="Slice WAVs on silence or Silero VAD")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--method",
        default="silence",
        help="silence (pydub dBFS) or silero (Silero VAD ONNX CPU)",
    )
    parser.add_argument("--min-silence-len", type=int, default=500)
    parser.add_argument("--silence-thresh", type=int, default=-40)
    parser.add_argument("--keep-silence", type=int, default=200)
    parser.add_argument("--min-chunk-ms", type=int, default=1000)
    parser.add_argument("--max-chunk-s", type=float, default=12.0)
    parser.add_argument("--merge-gap-ms", type=int, default=400)
    parser.add_argument("--vad-threshold", type=float, default=0.5)
    args = parser.parse_args()

    method = normalize_method(args.method)
    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    if not input_dir.is_dir():
        print(f"ERROR: input dir not found: {input_dir}", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    wav_files = sorted(p for p in input_dir.iterdir() if p.suffix.lower() == ".wav")
    print(f"SLICE_METHOD={method}", flush=True)
    print(f"Processing {len(wav_files)} wav file(s)", flush=True)

    model = None
    if method == "silero":
        try:
            model = load_silero_model()
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR: Silero VAD の読み込みに失敗しました: {exc}", file=sys.stderr)
            return 1

    n = len(wav_files)
    emit_fraction(0, n)
    slice_index = 0
    for i, wav_file in enumerate(wav_files, start=1):
        print(f"Slicing {wav_file.name}", flush=True)
        audio = AudioSegment.from_wav(str(wav_file))
        used = method
        if method == "silero":
            chunks = slice_on_silero(
                audio,
                model,
                min_silence_ms=int(args.min_silence_len),
                speech_pad_ms=int(args.keep_silence),
                min_chunk_ms=int(args.min_chunk_ms),
                max_chunk_s=float(args.max_chunk_s),
                merge_gap_ms=int(args.merge_gap_ms),
                threshold=float(args.vad_threshold),
            )
            if not chunks:
                print(
                    f"  WARN: Silero VAD found no speech; falling back to silence split",
                    flush=True,
                )
                used = "silence-fallback"
                chunks = slice_on_silence(
                    audio,
                    min_silence_len=int(args.min_silence_len),
                    silence_thresh=int(args.silence_thresh),
                    keep_silence=int(args.keep_silence),
                    min_chunk_ms=int(args.min_chunk_ms),
                )
        else:
            chunks = slice_on_silence(
                audio,
                min_silence_len=int(args.min_silence_len),
                silence_thresh=int(args.silence_thresh),
                keep_silence=int(args.keep_silence),
                min_chunk_ms=int(args.min_chunk_ms),
            )

        saved = 0
        for chunk in chunks:
            out_path = output_dir / f"slice_{slice_index:03d}.wav"
            chunk.export(str(out_path), format="wav")
            slice_index += 1
            saved += 1
        print(f"  -> {saved} slice(s) [{used}]", flush=True)
        emit_fraction(i, n, f"{wav_file.name}")

    print(f"DONE: {slice_index} slice(s) in {output_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
