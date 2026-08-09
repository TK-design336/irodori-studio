#!/usr/bin/env python3
"""Silence-based audio slicing (matches IrodoriTTS/slice_audio.py defaults)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pydub import AudioSegment
from pydub.silence import split_on_silence


def emit_fraction(i: int, n: int, detail: str = "") -> None:
    frac = (i / n) if n else 1.0
    payload = {"fraction": frac, "current": i, "total": n}
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Slice WAVs on silence")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--min-silence-len", type=int, default=500)
    parser.add_argument("--silence-thresh", type=int, default=-40)
    parser.add_argument("--keep-silence", type=int, default=200)
    parser.add_argument("--min-chunk-ms", type=int, default=1000)
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    if not input_dir.is_dir():
        print(f"ERROR: input dir not found: {input_dir}", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    wav_files = sorted(p for p in input_dir.iterdir() if p.suffix.lower() == ".wav")
    print(f"Processing {len(wav_files)} wav file(s)", flush=True)

    n = len(wav_files)
    emit_fraction(0, n)
    slice_index = 0
    for i, wav_file in enumerate(wav_files, start=1):
        print(f"Slicing {wav_file.name}", flush=True)
        audio = AudioSegment.from_wav(str(wav_file))
        chunks = split_on_silence(
            audio,
            min_silence_len=int(args.min_silence_len),
            silence_thresh=int(args.silence_thresh),
            keep_silence=int(args.keep_silence),
        )
        saved = 0
        for chunk in chunks:
            if len(chunk) >= int(args.min_chunk_ms):
                out_path = output_dir / f"slice_{slice_index:03d}.wav"
                chunk.export(str(out_path), format="wav")
                slice_index += 1
                saved += 1
        print(f"  -> {saved} slice(s)", flush=True)
        emit_fraction(i, n, f"{wav_file.name}")

    print(f"DONE: {slice_index} slice(s) in {output_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
