#!/usr/bin/env python3
"""Long-lived OPT-equivalent inference worker (Flash SDP + empty_cache).

Protocol: one JSON object per stdin line, one JSON response per stdout line.
Commands:
  {"cmd":"ping"}
  {"cmd":"load","checkpoint":"...","model_device":"cuda","model_precision":"fp32",
   "codec_device":"cuda","codec_precision":"fp32"}
  {"cmd":"synthesize","text":"...","ref_embed"|"ref_wav"|caption+no_ref,"output_wav":"...", ...}
  {"cmd":"unload"}
  {"cmd":"shutdown"}
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any


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

from irodori_tts.inference_runtime import (  # noqa: E402
    InferenceRuntime,
    RuntimeKey,
    SamplingRequest,
    save_wav,
)


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
    caption_raw = req.get("caption")
    ref_embed = str(ref_embed_raw).strip() if ref_embed_raw not in (None, "", "null") else None
    ref_wav = str(ref_wav_raw).strip() if ref_wav_raw not in (None, "", "null") else None
    caption = str(caption_raw).strip() if caption_raw not in (None, "", "null") else None
    no_ref = bool(req.get("no_ref", False))
    if caption is not None and not ref_embed and not ref_wav:
        no_ref = True

    sampling = SamplingRequest(
        text=str(req["text"]),
        caption=caption,
        ref_wav=ref_wav,
        ref_embed=ref_embed,
        no_ref=no_ref,
        num_candidates=int(req.get("num_candidates", 1)),
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

    out_path = Path(str(req["output_wav"]))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    saved = save_wav(out_path, result.audio, result.sample_rate)
    respond(
        True,
        status="synthesized",
        output_wav=str(saved),
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
