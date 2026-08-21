#!/usr/bin/env python3
"""Long-lived OPT-equivalent inference worker (Flash SDP + empty_cache).

Protocol: one JSON object per stdin line, one JSON response per stdout line.
Commands:
  {"cmd":"ping"}
  {"cmd":"load","checkpoint":"...","model_device":"cuda","model_precision":"fp32",
   "codec_device":"cuda","codec_precision":"fp32"}
  {"cmd":"synthesize","text":"...","ref_embed"|"ref_wav"|caption+no_ref,"output_wav":"...","output_wavs":["..."], ...}
  {"cmd":"unload"}
  {"cmd":"shutdown"}
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

# soundfile 本線: torchaudio.load/save → torchcodec を避ける（WinError 87 対策）。
try:
    import soundfile as sf
except ImportError as exc:  # noqa: BLE001
    raise RuntimeError(
        "soundfile が見つかりません。Irodori の venv で pip install soundfile してください"
    ) from exc


def _ensure_irodori_on_path() -> None:
    """Make `irodori_tts` importable even if venv site-packages layout differs."""
    candidates: list[Path] = []
    env_root = os.environ.get("IRODORI_ROOT") or os.environ.get("PYTHONPATH", "")
    for part in env_root.split(os.pathsep):
        if part.strip():
            candidates.append(Path(part.strip()))
    cwd = Path.cwd()
    candidates.extend([cwd, cwd.parent])
    # Walk up from this script in case studio python/ is next to nothing useful
    here = Path(__file__).resolve().parent
    candidates.extend([here, here.parent])

    for root in candidates:
        pkg = root / "irodori_tts"
        if pkg.is_dir() and str(root) not in sys.path:
            sys.path.insert(0, str(root))
            break


_ensure_irodori_on_path()

# OPT parity: enable Flash / mem-efficient SDP before model import.
import torch

torch.backends.cuda.enable_flash_sdp(True)
torch.backends.cuda.enable_mem_efficient_sdp(True)

import irodori_tts.inference_runtime as ir  # noqa: E402
from irodori_tts.inference_runtime import (  # noqa: E402
    InferenceRuntime,
    RuntimeKey,
    SamplingRequest,
)

# wav / flac / ogg は soundfile が直接読める。それ以外は ffmpeg で WAV 化。
_SF_NATIVE_EXTS = {".wav", ".flac", ".ogg"}


def _ffmpeg_bin() -> str:
    env = (os.environ.get("FFMPEG_BINARY") or "").strip()
    if not env:
        raise RuntimeError("同梱の ffmpeg が見つかりません（FFMPEG_BINARY が未設定です）")
    return env


def _hide_console_kwargs() -> dict[str, Any]:
    if os.name != "nt":
        return {}
    # CREATE_NO_WINDOW — 生成中に CMD が点滅しないようにする
    return {"creationflags": 0x08000000}


def _ref_cache_dir() -> Path:
    local = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_CACHE_HOME")
    if local:
        d = Path(local) / "irodori-studio" / "ref_wav_cache"
    else:
        d = Path.home() / ".cache" / "irodori-studio" / "ref_wav_cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _needs_wav_convert(path: Path) -> bool:
    return path.suffix.lower() not in _SF_NATIVE_EXTS


def _convert_ref_to_wav(src: Path) -> Path:
    """ffmpeg で 44.1kHz mono PCM WAV に変換し、キャッシュパスを返す。"""
    if not src.is_file():
        raise FileNotFoundError(f"参照音源が見つかりません: {src}")
    try:
        resolved = src.resolve()
        stamp = f"{resolved}|{resolved.stat().st_mtime_ns}|{resolved.stat().st_size}"
    except OSError:
        stamp = f"{src}|{src.stat().st_mtime_ns}|{src.stat().st_size}"
    digest = hashlib.sha256(stamp.encode("utf-8", errors="replace")).hexdigest()[:16]
    dest = _ref_cache_dir() / f"{digest}.wav"
    if dest.is_file() and dest.stat().st_size > 0:
        return dest

    dest.parent.mkdir(parents=True, exist_ok=True)
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
        str(dest),
    ]
    try:
        proc = subprocess.run(
            cmd,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            **_hide_console_kwargs(),
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "参照音源が wav/flac/ogg 以外です。同梱の ffmpeg が見つかりません"
        ) from exc
    if proc.returncode != 0:
        err = proc.stdout.decode("utf-8", errors="replace")[-800:]
        raise RuntimeError(f"参照音源の WAV 化に失敗しました: {src.name}\n{err}")
    return dest


def _ensure_sf_readable(path: str | Path) -> Path:
    src = Path(path)
    if not _needs_wav_convert(src):
        return src
    return _convert_ref_to_wav(src)


def _load_audio(path: str | Path) -> tuple[torch.Tensor, int]:
    """Irodori `_load_audio` 互換（C, T）float32。torchcodec は使わない。"""
    readable = _ensure_sf_readable(path)
    data, sr = sf.read(str(readable), dtype="float32")
    wav = torch.from_numpy(data)
    if wav.ndim == 1:
        wav = wav.unsqueeze(0)
    else:
        wav = wav.T
    return wav, int(sr)


def save_wav(path: str | Path, audio: torch.Tensor, sample_rate: int) -> Path:
    """Irodori `save_wav` 互換。soundfile のみで書く。"""
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    audio_cpu = audio.detach().to(device="cpu", dtype=torch.float32)
    if audio_cpu.ndim == 1:
        audio_np = audio_cpu.numpy()
    elif audio_cpu.shape[0] == 1:
        audio_np = audio_cpu.squeeze(0).numpy()
    else:
        audio_np = audio_cpu.T.numpy()
    sf.write(str(out_path), audio_np, int(sample_rate))
    return out_path


# synthesize 内の参照読み込みも soundfile 本線にする
ir._load_audio = _load_audio


RUNTIME: InferenceRuntime | None = None


def respond(ok: bool, **payload: Any) -> None:
    msg = {"ok": ok, **payload}
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_load(req: dict[str, Any]) -> None:
    global RUNTIME
    key = RuntimeKey(
        checkpoint=str(req["checkpoint"]),
        model_device=str(req.get("model_device", "cuda")),
        codec_repo=str(req.get("codec_repo", "Aratako/Semantic-DACVAE-Japanese-32dim")),
        model_precision=str(req.get("model_precision", "fp32")),
        codec_device=str(req.get("codec_device", "cuda")),
        codec_precision=str(req.get("codec_precision", "fp32")),
        compile_model=False,
        compile_dynamic=False,
    )
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    RUNTIME = InferenceRuntime.from_key(key)
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    respond(True, status="loaded", checkpoint=key.checkpoint)


def handle_synthesize(req: dict[str, Any]) -> None:
    global RUNTIME
    if RUNTIME is None:
        respond(False, error="runtime not loaded; call load first")
        return

    seed_raw = req.get("seed")
    seed = None if seed_raw in (None, "", "null") else int(seed_raw)
    seconds_raw = req.get("seconds")
    seconds = None if seconds_raw in (None, "", "null") else float(seconds_raw)

    ref_embed_raw = req.get("ref_embed")
    ref_wav_raw = req.get("ref_wav")
    ref_wavs_raw = req.get("ref_wavs")  # list[str] | None
    caption_raw = req.get("caption")
    ref_embed = str(ref_embed_raw).strip() if ref_embed_raw not in (None, "", "null") else None
    caption = str(caption_raw).strip() if caption_raw not in (None, "", "null") else None

    # Build ref_wavs list; prefer explicit ref_wavs, fall back to single ref_wav.
    ref_wavs: list[str] | None = None
    if ref_wavs_raw and isinstance(ref_wavs_raw, list):
        converted = [str(_ensure_sf_readable(p)) for p in ref_wavs_raw if p and str(p).strip()]
        ref_wavs = converted if converted else None
    elif ref_wav_raw not in (None, "", "null"):
        single = str(ref_wav_raw).strip()
        if single:
            ref_wavs = [str(_ensure_sf_readable(single))]

    # For back-compat: keep ref_wav as primary (first) entry.
    ref_wav = ref_wavs[0] if ref_wavs else None

    no_ref = bool(req.get("no_ref", False))
    if caption is not None and not ref_embed and not ref_wav:
        no_ref = True

    out_paths: list[Path] = []
    raw_list = req.get("output_wavs")
    if isinstance(raw_list, list):
        out_paths = [Path(str(p)) for p in raw_list if p and str(p).strip()]
    if not out_paths:
        out_paths = [Path(str(req["output_wav"]))]
    requested = max(1, int(req.get("num_candidates", 1) or 1))
    if requested > len(out_paths) and len(out_paths) == 1:
        base = out_paths[0]
        suffix = base.suffix or ".wav"
        out_paths = [base] + [
            base.with_name(f"{base.stem}_{i:03d}{suffix}")
            for i in range(2, requested + 1)
        ]
    num_candidates = max(1, len(out_paths))

    # Pass ref_wavs to SamplingRequest if supported (v4.1+); fall back gracefully.
    sr_kwargs: dict[str, Any] = dict(
        text=str(req["text"]),
        caption=caption,
        ref_embed=ref_embed,
        no_ref=no_ref,
    )
    import inspect as _inspect
    _sr_params = set(_inspect.signature(SamplingRequest).parameters)
    if "ref_wavs" in _sr_params and ref_wavs:
        sr_kwargs["ref_wavs"] = ref_wavs
    elif ref_wav:
        sr_kwargs["ref_wav"] = ref_wav

    sampling = SamplingRequest(
        **sr_kwargs,
        num_candidates=num_candidates,
        seconds=seconds,
        duration_scale=float(req.get("duration_scale", 1.0)),
        num_steps=int(req.get("num_steps", 40)),
        cfg_scale_text=float(req.get("cfg_scale_text", 3.0)),
        cfg_scale_caption=float(req.get("cfg_scale_caption", 3.0)),
        cfg_scale_speaker=float(req.get("cfg_scale_speaker", 5.0)),
        cfg_guidance_mode=str(req.get("cfg_guidance_mode", "independent")),
        seed=seed,
        t_schedule_mode=str(req.get("t_schedule_mode", "linear")),
        sway_coeff=float(req.get("sway_coeff", -1.0)),
        context_kv_cache=bool(req.get("context_kv_cache", True)),
    )

    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    result = RUNTIME.synthesize(sampling, log_fn=None)
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    audios = list(getattr(result, "audios", None) or [result.audio])
    saved_paths: list[str] = []
    n_save = min(len(audios), len(out_paths))
    if n_save <= 0:
        respond(False, error="synthesize produced no audio")
        return
    for audio, out_path in zip(audios[:n_save], out_paths[:n_save]):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        saved_paths.append(str(save_wav(out_path, audio, result.sample_rate)))

    respond(
        True,
        status="synthesized",
        output_wav=saved_paths[0],
        output_wavs=saved_paths,
        sample_rate=int(result.sample_rate),
        used_seed=int(result.used_seed),
    )


def handle_unload() -> None:
    global RUNTIME
    RUNTIME = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    respond(True, status="unloaded")


def main() -> int:
    # Keep stdout reserved for JSON-RPC (HF/tqdm must not print there).
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TQDM_DISABLE", "1")

    # Windows 既定コードページだと JSON 内の日本語が壊れるため UTF-8 固定
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    respond(True, status="ready")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            respond(False, error=f"invalid json: {exc}")
            continue

        cmd = req.get("cmd")
        try:
            if cmd == "ping":
                respond(True, status="pong", loaded=RUNTIME is not None)
            elif cmd == "load":
                handle_load(req)
            elif cmd == "synthesize":
                # Echo received text for debugging (first 40 chars)
                text_preview = str(req.get("text", ""))[:40]
                sys.stderr.write(
                    f"[opt_worker] synthesize text={text_preview!r} "
                    f"ref_embed={req.get('ref_embed')!r} ref_wav={req.get('ref_wav')!r} "
                    f"caption={req.get('caption')!r} no_ref={req.get('no_ref')!r}\n"
                )
                sys.stderr.flush()
                handle_synthesize(req)
            elif cmd == "unload":
                handle_unload()
            elif cmd == "shutdown":
                handle_unload()
                respond(True, status="shutdown")
                break
            else:
                respond(False, error=f"unknown cmd: {cmd}")
        except Exception as exc:  # noqa: BLE001
            respond(False, error=str(exc), traceback=traceback.format_exc())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
