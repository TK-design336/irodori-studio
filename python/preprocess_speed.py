#!/usr/bin/env python3
"""Pitch-preserving speed adjust (ffmpeg atempo) for WAVs, in place."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def emit_fraction(i: int, n: int, detail: str = "") -> None:
    frac = (i / n) if n else 1.0
    payload: dict = {"fraction": frac, "current": i, "total": n}
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def atempo_filter(speed: float) -> str:
    """Build atempo chain; each factor must be in [0.5, 2.0]."""
    factors: list[float] = []
    remaining = speed
    while remaining > 2.0 + 1e-9:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5 - 1e-9:
        factors.append(0.5)
        remaining /= 0.5
    factors.append(remaining)
    return ",".join(f"atempo={f:.6g}" for f in factors)


def speed_one(path: Path, speed: float) -> None:
    filt = atempo_filter(speed)
    with tempfile.NamedTemporaryFile(
        prefix=path.stem + "_",
        suffix=".wav",
        dir=path.parent,
        delete=False,
    ) as tmp:
        tmp_path = Path(tmp.name)
    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(path),
            "-af",
            filt,
            "-c:a",
            "pcm_s16le",
            str(tmp_path),
        ]
        print(f"SPEED {path.name} x{speed:.3g} ({filt})", flush=True)
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        tmp_path.replace(path)
    except Exception:
        if tmp_path.is_file():
            tmp_path.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Apply pitch-preserving speed to WAVs in a folder (in place)"
    )
    parser.add_argument("--sliced-dir", required=True)
    parser.add_argument("--speed", type=float, required=True)
    args = parser.parse_args()

    sliced_dir = Path(args.sliced_dir)
    speed = float(args.speed)
    if not sliced_dir.is_dir():
        print(f"ERROR: sliced dir not found: {sliced_dir}", file=sys.stderr)
        return 1
    if speed <= 0:
        print(f"ERROR: speed must be > 0, got {speed}", file=sys.stderr)
        return 1
    if abs(speed - 1.0) < 0.001:
        print("SKIP speed: already 1.0", flush=True)
        return 0

    speed = max(0.5, min(2.0, speed))
    wavs = sorted(p for p in sliced_dir.iterdir() if p.suffix.lower() == ".wav")
    if not wavs:
        print(f"ERROR: no wav files in {sliced_dir}", file=sys.stderr)
        return 1

    n = len(wavs)
    print(f"Applying speed x{speed:.3g} to {n} wav(s) in {sliced_dir}", flush=True)
    emit_fraction(0, n)
    for i, wav in enumerate(wavs, start=1):
        speed_one(wav, speed)
        emit_fraction(i, n, wav.name)

    print(f"DONE: speed-adjusted {n} wav(s)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
