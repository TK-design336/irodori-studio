#!/usr/bin/env python3
"""Vocal stem separation via audio-separator (UVR models).

Used as an optional training preprocess. Instrumental is never written
(output_single_stem=\"Vocals\").

UI に出すモデルは「学習向けショートリスト」のみ。
UVR 全モデル一覧は数百件あり、ONNX / Instrumental 専用 / Karaoke /
Denoise / DeReverb など学習に不向き・環境依存の高いものが大半のため。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

DEFAULT_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"

# audio-separator MDXC/Roformer overlap_add crashes when the clip is shorter
# than one STFT chunk (~2.5–3s). Pad those only; 10s matches the library's
# own "short audio" threshold so we skip that buggy path entirely.
_SHORT_CLIP_SECONDS = 4.0
_PAD_TO_SECONDS = 10.0

# 学習前処理向けの固定ショートリスト（順序 = UI 表示順）。
# 選定基準:
# - torch .ckpt の Roformer / MDXC（onnxruntime-gpu 不要）
# - Vocals 抽出向け（Instrumental / Karaoke / Denoise / DeReverb 除外）
# - 品質・配布安定・VRAM が極端でないもの
# - コミュニティで実運用実績があるもの
CURATED_VOCAL_MODELS: list[dict[str, str]] = [
    {
        "filename": DEFAULT_MODEL,
        "name": "BS-Roformer（推奨・既定）",
        "arch": "MDXC",
        "hint": "品質と安定性のバランス。audio-separator 既定",
    },
    {
        "filename": "model_bs_roformer_ep_368_sdr_12.9628.ckpt",
        "name": "BS-Roformer ep368",
        "arch": "MDXC",
        "hint": "別エポックの BS-Roformer",
    },
    {
        "filename": "vocals_mel_band_roformer.ckpt",
        "name": "MelBand Roformer Kim（ボーカル特化）",
        "arch": "MDXC",
        "hint": "Mel 帯域・歌声向け。品質高め",
    },
    {
        "filename": "mel_band_roformer_kim_ft_unwa.ckpt",
        "name": "MelBand Kim FT (unwa)",
        "arch": "MDXC",
        "hint": "Kim 系の人気ファインチューン",
    },
    {
        "filename": "mel_band_roformer_vocals_becruily.ckpt",
        "name": "MelBand Vocals (becruily)",
        "arch": "MDXC",
        "hint": "ボーカル特化の別系統",
    },
]

_CURATED_FILENAMES = {m["filename"] for m in CURATED_VOCAL_MODELS}


def ensure_bundled_ffmpeg_on_path() -> None:
    """Prepend FFMPEG_BINARY's parent so audio-separator can find `ffmpeg`."""
    ff = (os.environ.get("FFMPEG_BINARY") or "").strip()
    if not ff:
        return
    parent = str(Path(ff).resolve().parent)
    path = os.environ.get("PATH") or ""
    parts = path.split(os.pathsep) if path else []
    if parent not in parts:
        os.environ["PATH"] = parent + (os.pathsep + path if path else "")


def _curated_entry(meta: dict[str, str]) -> dict[str, Any]:
    return {
        "arch": meta["arch"],
        "name": meta["name"],
        "filename": meta["filename"],
        "stems": ["Vocals", "Instrumental"],
        "targetStem": "Vocals",
        "hint": meta.get("hint") or "",
    }


def list_vocal_models() -> list[dict[str, Any]]:
    """Return the curated vocal-separation shortlist only.

    Does not dump UVR's full catalog (ONNX / instrumental / karaoke / etc.).
    Optionally cross-checks that audio-separator still knows each filename;
    unknown entries stay listed (download may still succeed via model repo).
    """
    out = [_curated_entry(m) for m in CURATED_VOCAL_MODELS]

    # Best-effort: annotate if package is available (does not expand the list).
    try:
        ensure_bundled_ffmpeg_on_path()
        from audio_separator.separator import Separator

        sep = Separator(info_only=True)
        grouped = sep.list_supported_model_files() or {}
        known: set[str] = set()
        for models in grouped.values():
            if not isinstance(models, dict):
                continue
            for info in models.values():
                if isinstance(info, dict):
                    fn = str(info.get("filename") or "").strip()
                    if fn:
                        known.add(fn)
        if known:
            for entry in out:
                entry["available"] = entry["filename"] in known
    except Exception:  # noqa: BLE001
        for entry in out:
            entry["available"] = None

    return out


def is_curated_model(filename: str) -> bool:
    return (filename or "").strip() in _CURATED_FILENAMES


def make_separator(
    *,
    output_dir: str | Path,
    model_file_dir: str | Path,
) -> Any:
    ensure_bundled_ffmpeg_on_path()
    from audio_separator.separator import Separator

    model_dir = Path(model_file_dir)
    model_dir.mkdir(parents=True, exist_ok=True)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    return Separator(
        model_file_dir=str(model_dir),
        output_dir=str(out),
        output_format="WAV",
        output_single_stem="Vocals",
        sample_rate=44100,
    )


def _as_output_path(p: str | Path, output_dir: str | Path) -> Path:
    """Resolve a path returned by audio-separator.separate().

    That API often returns a basename only (cwd-relative), while the file
    is written under output_dir. Join relative names to output_dir so
    callers never look in the process working directory.
    """
    out = Path(output_dir)
    path = Path(p)
    if not path.is_absolute():
        path = out / path.name
    return path


def _probe_duration_sec(path: Path) -> float | None:
    try:
        import soundfile as sf

        info = sf.info(str(path))
        if info.samplerate > 0 and info.frames >= 0:
            return float(info.frames) / float(info.samplerate)
    except Exception:  # noqa: BLE001
        pass
    try:
        import librosa

        d = librosa.get_duration(path=str(path))
        return float(d) if d is not None else None
    except Exception:  # noqa: BLE001
        return None


def _write_silence_padded(src: Path, pad_to_sec: float, dest: Path) -> None:
    from pydub import AudioSegment

    audio = AudioSegment.from_file(src)
    need_ms = int(round(pad_to_sec * 1000))
    if len(audio) < need_ms:
        audio = audio + AudioSegment.silent(
            duration=need_ms - len(audio),
            frame_rate=audio.frame_rate,
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    audio.export(str(dest), format="wav")


def _trim_wav(path: Path, duration_sec: float) -> None:
    import soundfile as sf

    data, sr = sf.read(str(path), always_2d=True)
    n = max(1, int(round(float(duration_sec) * float(sr))))
    if data.shape[0] <= n:
        return
    subtype = "PCM_16"
    try:
        subtype = sf.info(str(path)).subtype or subtype
    except Exception:  # noqa: BLE001
        pass
    sf.write(str(path), data[:n], sr, subtype=subtype)


def separate_vocals(
    input_path: str | Path,
    output_dir: str | Path,
    model_name: str | None = None,
    model_file_dir: str | Path | None = None,
    separator: Any | None = None,
) -> list[Path]:
    """Separate Vocals only from one audio/video file. Does not modify the source.

    Clips shorter than ~4s are silence-padded before inference (Roformer
    overlap_add bug), then outputs are trimmed back to the original duration.
    """
    src = Path(input_path)
    if not src.is_file():
        raise FileNotFoundError(f"input not found: {src}")

    model = (model_name or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    out = Path(output_dir)
    if separator is None:
        if not model_file_dir:
            raise ValueError("model_file_dir is required when separator is not provided")
        separator = make_separator(
            output_dir=out,
            model_file_dir=model_file_dir,
        )
        separator.load_model(model)
    else:
        # Ensure output_dir matches caller's intent
        separator.output_dir = str(out)
        out.mkdir(parents=True, exist_ok=True)

    feed = src
    orig_sec: float | None = None
    tmp_pad: Path | None = None
    duration = _probe_duration_sec(src)
    if duration is not None and duration < _SHORT_CLIP_SECONDS:
        orig_sec = duration
        fd, tmp_name = tempfile.mkstemp(prefix="irodori_sep_pad_", suffix=".wav")
        os.close(fd)
        tmp_pad = Path(tmp_name)
        try:
            _write_silence_padded(src, _PAD_TO_SECONDS, tmp_pad)
        except Exception:
            try:
                tmp_pad.unlink(missing_ok=True)
            except OSError:
                pass
            tmp_pad = None
            orig_sec = None
            raise
        feed = tmp_pad
        print(
            f"PAD {src.name} {duration:.2f}s -> {_PAD_TO_SECONDS:.0f}s (Roformer short-clip)",
            flush=True,
        )

    try:
        files = separator.separate(str(feed))
    finally:
        if tmp_pad is not None:
            try:
                tmp_pad.unlink(missing_ok=True)
            except OSError:
                pass

    resolved = [_as_output_path(p, out) for p in (files or [])]
    if orig_sec is not None:
        for p in resolved:
            if p.is_file():
                _trim_wav(p, orig_sec)
    return resolved


def list_models_json() -> str:
    return json.dumps(list_vocal_models(), ensure_ascii=False)


if __name__ == "__main__":
    # CLI: list models as JSON for Tauri
    if len(sys.argv) > 1 and sys.argv[1] in ("--list-models", "list-models"):
        print(list_models_json())
        raise SystemExit(0)
    print(
        "Usage: vocal_separator.py --list-models",
        file=sys.stderr,
    )
    raise SystemExit(2)
