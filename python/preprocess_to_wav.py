#!/usr/bin/env python3
"""Convert audio files in a folder to 44.1kHz mono PCM WAV via ffmpeg."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

CONVERT_EXTS = {".mp3", ".mp4", ".m4a", ".flac", ".ogg", ".webm", ".aac", ".wma", ".mkv"}
WAV_EXT = ".wav"


def _ffmpeg_bin() -> str:
    import os

    env = (os.environ.get("FFMPEG_BINARY") or "").strip()
    if not env:
        raise RuntimeError("同梱の ffmpeg が見つかりません（FFMPEG_BINARY が未設定です）")
    return env


def emit_fraction(i: int, n: int, detail: str = "") -> None:
    frac = (i / n) if n else 1.0
    payload = {"fraction": frac, "current": i, "total": n}
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def convert_one(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() == WAV_EXT:
        if src.resolve() != dst.resolve():
            shutil.copy2(src, dst)
        print(f"COPY {src.name} -> {dst.name}", flush=True)
        return

    cmd = [
        _ffmpeg_bin(),
        "-y",
        "-i",
        str(src),
        "-vn",
        "-ar",
        "44100",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(dst),
    ]
    print(f"CONVERT {src.name} -> {dst.name}", flush=True)
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert media folder to WAV")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    if not input_dir.is_dir():
        print(f"ERROR: input dir not found: {input_dir}", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(
        p
        for p in input_dir.iterdir()
        if p.is_file() and p.suffix.lower() in CONVERT_EXTS | {WAV_EXT}
    )
    print(f"Found {len(files)} audio file(s)", flush=True)
    n = len(files)
    emit_fraction(0, n)
    for i, src in enumerate(files, start=1):
        dst = output_dir / f"{src.stem}.wav"
        convert_one(src, dst)
        emit_fraction(i, n, f"{src.name}")

    print(f"DONE: wrote {len(files)} wav(s) to {output_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
