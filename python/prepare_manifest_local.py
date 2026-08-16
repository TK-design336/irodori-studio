#!/usr/bin/env python3
"""Encode local JSONL WAVs to DACVAE latents without datasets.Audio / torchcodec.

Windows Irodori venvs often fail to load libtorchcodec (FFmpeg shared DLLs).
This path uses soundfile, matching Studio inference (`opt_worker.py`).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

try:
    import soundfile as sf
except ImportError as exc:  # noqa: BLE001
    raise RuntimeError(
        "soundfile が見つかりません。Irodori の venv で pip install soundfile してください"
    ) from exc

import torch


def emit_fraction(i: int, n: int, detail: str = "") -> None:
    frac = (i / n) if n else 1.0
    payload: dict[str, Any] = {"fraction": frac, "current": i, "total": n}
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def _ensure_irodori_on_path() -> None:
    candidates: list[Path] = []
    env_root = (os.environ.get("IRODORI_ROOT") or "").strip()
    if env_root:
        candidates.append(Path(env_root))
    candidates.append(Path.cwd())
    for root in candidates:
        if (root / "irodori_tts").is_dir():
            s = str(root.resolve())
            if s not in sys.path:
                sys.path.insert(0, s)
            return


def _audio_path_from_row(row: dict[str, Any]) -> str | None:
    audio = row.get("audio")
    if isinstance(audio, str) and audio.strip():
        return audio.strip()
    if isinstance(audio, dict):
        path = audio.get("path")
        if isinstance(path, str) and path.strip():
            return path.strip()
    return None


def _load_audio(path: Path) -> tuple[torch.Tensor, int]:
    """Channel-first float32 (C, T), matching Irodori `_coerce_audio`."""
    data, sr = sf.read(str(path), dtype="float32")
    wav = torch.from_numpy(data)
    if wav.ndim == 1:
        wav = wav.unsqueeze(0)
    else:
        wav = wav.T.contiguous()
    if wav.numel() == 0:
        raise ValueError("Decoded audio is empty")
    return wav, int(sr)


def _load_codec(device: str):
    from irodori_tts.codec import DACVAECodec

    kwargs: dict[str, Any] = {
        "repo_id": "Aratako/Semantic-DACVAE-Japanese-32dim",
        "device": device,
        "deterministic_encode": True,
        "deterministic_decode": True,
    }
    try:
        import inspect

        params = inspect.signature(DACVAECodec.load).parameters
        if "normalize_db" in params:
            kwargs["normalize_db"] = -16.0
    except (TypeError, ValueError):
        pass
    return DACVAECodec.load(**kwargs)


def _normalize_text(text: str) -> str:
    try:
        from irodori_tts.text_normalization import normalize_text

        return normalize_text(text).strip()
    except Exception:
        return text.strip()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Local JSONL → DACVAE latents via soundfile (no torchcodec)"
    )
    parser.add_argument("--data-files", required=True)
    parser.add_argument("--output-manifest", required=True)
    parser.add_argument("--latent-dir", required=True)
    parser.add_argument("--device", default="cuda")
    args = parser.parse_args()

    _ensure_irodori_on_path()

    jsonl = Path(args.data_files)
    output_manifest = Path(args.output_manifest)
    latent_dir = Path(args.latent_dir)
    if not jsonl.is_file():
        print(f"ERROR: dataset jsonl not found: {jsonl}", file=sys.stderr)
        return 1

    rows: list[dict[str, Any]] = []
    with jsonl.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))

    n = len(rows)
    print(
        f"prepare_manifest_local: soundfile path (skip datasets.Audio / torchcodec) "
        f"rows={n}",
        flush=True,
    )
    if n == 0:
        print("ERROR: dataset jsonl has no rows", file=sys.stderr)
        return 1

    device = str(args.device)
    if device.startswith("cuda") and not torch.cuda.is_available():
        print("ERROR: CUDA requested but not available", file=sys.stderr)
        return 1

    codec = _load_codec(device)
    latent_dir.mkdir(parents=True, exist_ok=True)
    output_manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest_base = output_manifest.parent

    written = 0
    skip_counts: dict[str, int] = {}
    first_error: str | None = None
    emit_fraction(0, n)

    with output_manifest.open("w", encoding="utf-8") as out_f:
        for i, row in enumerate(rows, start=1):
            text = _normalize_text(str(row.get("text") or ""))
            if not text:
                skip_counts["empty_text"] = skip_counts.get("empty_text", 0) + 1
                emit_fraction(i, n)
                continue

            audio_path = _audio_path_from_row(row)
            if not audio_path:
                skip_counts["missing_audio"] = skip_counts.get("missing_audio", 0) + 1
                if first_error is None:
                    first_error = f"row {i}: audio path missing"
                emit_fraction(i, n)
                continue

            wav_path = Path(audio_path)
            try:
                wav, sr = _load_audio(wav_path)
            except Exception as exc:
                skip_counts["audio_decode"] = skip_counts.get("audio_decode", 0) + 1
                if first_error is None:
                    first_error = f"row {i} {wav_path}: {exc}"
                    traceback.print_exc()
                emit_fraction(i, n, wav_path.name)
                continue

            try:
                with torch.inference_mode():
                    latent = codec.encode_waveform(wav, sample_rate=sr)[0].cpu()
            except Exception as exc:
                skip_counts["encode_error"] = skip_counts.get("encode_error", 0) + 1
                if first_error is None:
                    first_error = f"row {i} {wav_path}: {exc}"
                    traceback.print_exc()
                emit_fraction(i, n, wav_path.name)
                continue

            latent_name = f"{written:08d}_{i - 1:08d}.pt"
            latent_path = (latent_dir / latent_name).resolve()
            torch.save(latent, latent_path)
            payload = {
                "text": text,
                "latent_path": Path(
                    os.path.relpath(latent_path, start=manifest_base)
                ).as_posix(),
                "num_frames": int(latent.shape[0]),
            }
            out_f.write(json.dumps(payload, ensure_ascii=False) + "\n")
            written += 1
            emit_fraction(i, n, wav_path.name)

    skipped_audio = sum(
        skip_counts.get(k, 0)
        for k in ("audio_decode", "encode_error", "missing_audio")
    )
    print(
        f"done. seen={n} written={written} "
        f"skipped_empty={skip_counts.get('empty_text', 0)} "
        f"skipped_speaker=0 skipped_audio={skipped_audio} "
        f"skipped_low_sr=0 skipped_max=0 manifest={output_manifest}",
        flush=True,
    )
    if skip_counts:
        print("skip breakdown:", flush=True)
        for reason, count in sorted(skip_counts.items(), key=lambda x: (-x[1], x[0])):
            print(f"  {reason}: {count}", flush=True)
    if first_error:
        print(f"first_error: {first_error}", flush=True)

    if written <= 0:
        print(
            "ERROR: no latents written. WAV は読めてもエンコードに失敗しているか、"
            "入力 JSONL が空です。",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
