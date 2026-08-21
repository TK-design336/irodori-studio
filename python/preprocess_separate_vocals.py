#!/usr/bin/env python3
"""Batch vocal separation for Irodori Studio training preprocess.

Writes Vocals-only WAV files under --output-dir. Never modifies source files.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

# Allow `from vocal_separator import …` when launched as a script path.
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from vocal_separator import DEFAULT_MODEL, make_separator, separate_vocals

AUDIO_EXTS = {
    ".wav",
    ".mp3",
    ".mp4",
    ".m4a",
    ".flac",
    ".ogg",
    ".webm",
    ".aac",
    ".wma",
    ".mkv",
    ".opus",
    ".aiff",
    ".ac3",
}


def emit_fraction(i: int, n: int, detail: str = "") -> None:
    frac = (i / n) if n else 1.0
    payload: dict = {"fraction": frac, "current": i, "total": n}
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Separate vocals from media folder")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-name", default=DEFAULT_MODEL)
    parser.add_argument("--model-file-dir", required=True)
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    if not input_dir.is_dir():
        print(f"ERROR: input dir not found: {input_dir}", file=sys.stderr)
        return 1

    files = sorted(
        p
        for p in input_dir.iterdir()
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS
    )
    if not files:
        print(f"ERROR: no audio files in {input_dir}", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    model = (args.model_name or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    print(f"SEPARATE_VOCALS model={model} files={len(files)}", flush=True)

    separator = None

    def ensure_separator():
        nonlocal separator
        if separator is not None:
            return separator
        sep = make_separator(
            output_dir=output_dir,
            model_file_dir=args.model_file_dir,
        )
        print(f"Loading model {model}…", flush=True)
        sep.load_model(model)
        print("Model loaded", flush=True)
        separator = sep
        return sep

    n = len(files)
    emit_fraction(0, n)
    for i, src in enumerate(files, start=1):
        # Normalize name to {stem}.wav for stable downstream slicing
        preferred = output_dir / f"{src.stem}.wav"
        if not preferred.is_file():
            leftovers = sorted(output_dir.glob(f"{src.stem}_(Vocals)_*.wav"))
            if leftovers:
                shutil.move(str(leftovers[0]), str(preferred))
                for extra in leftovers[1:]:
                    try:
                        extra.unlink()
                    except OSError:
                        pass
        if preferred.is_file():
            for junk in output_dir.glob(f"{src.stem}*Instrumental*"):
                try:
                    junk.unlink()
                except OSError:
                    pass
            print(f"  -> {preferred.name} (existing)", flush=True)
            emit_fraction(i, n, src.name)
            continue

        print(f"Separating {src.name}", flush=True)
        try:
            outs = separate_vocals(
                src,
                output_dir,
                model_name=model,
                separator=ensure_separator(),
            )
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR: failed on {src.name}: {exc}", file=sys.stderr)
            return 1
        if not outs:
            print(f"ERROR: no vocals output for {src.name}", file=sys.stderr)
            return 1
        primary = Path(outs[0])
        if not primary.is_absolute():
            primary = output_dir / primary.name
        if not primary.is_file():
            print(
                f"ERROR: vocals output missing for {src.name}: {primary}",
                file=sys.stderr,
            )
            return 1
        if primary.resolve() != preferred.resolve():
            if preferred.exists():
                preferred.unlink()
            shutil.move(str(primary), str(preferred))
            primary = preferred
        # Drop any extra stems if the model ignored single-stem (safety)
        for extra in outs[1:]:
            ep = Path(extra)
            if not ep.is_absolute():
                ep = output_dir / ep.name
            if ep.is_file() and ep.resolve() != primary.resolve():
                try:
                    ep.unlink()
                except OSError:
                    pass
        # Remove accidental Instrumental leftovers matching stem
        for junk in output_dir.glob(f"{src.stem}*Instrumental*"):
            try:
                junk.unlink()
            except OSError:
                pass
        print(f"  -> {primary.name}", flush=True)
        emit_fraction(i, n, src.name)

    print(f"DONE: {n} vocals wav(s) in {output_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
