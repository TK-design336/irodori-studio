#!/usr/bin/env python3
"""Long-lived ASR worker: faster-whisper on CPU only (no GPU / VRAM).

Model: Whisper "small" with int8. Stays loaded across requests.
Protocol: one JSON per stdin line → one JSON per stdout line.
  {"cmd":"ping"}
  {"cmd":"load","downloadRoot":"...","modelSize":"small"}
  {"cmd":"transcribe","wavPath":"..."}
  {"cmd":"verify","wavPath":"...","expectedText":"..."}
  {"cmd":"shutdown"}
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

# Extra safety: never touch CUDA even if a GPU build of ctranslate2 is installed.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("CT2_FORCE_CPU", "1")

MODEL = None
LOADED_KEY: str | None = None
MODEL_SIZE = "small"


def respond(ok: bool, **payload: Any) -> None:
    sys.stdout.write(json.dumps({"ok": ok, **payload}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_load(req: dict[str, Any]) -> None:
    global MODEL, LOADED_KEY, MODEL_SIZE
    from faster_whisper import WhisperModel

    # Prefer explicit download root under AppData; fall back to HF cache.
    download_root = str(
        req.get("downloadRoot") or req.get("download_root") or req.get("modelDir") or ""
    ).strip()
    model_size = str(req.get("modelSize") or req.get("model_size") or "small").strip() or "small"
    # Keep footprint bounded — never load medium/large here.
    if model_size not in ("tiny", "base", "small"):
        model_size = "small"

    key = f"cpu-int8:{model_size}:{download_root}"
    if MODEL is not None and LOADED_KEY == key:
        respond(True, status="loaded", modelSize=model_size, device="cpu", computeType="int8")
        return

    kwargs: dict[str, Any] = dict(
        device="cpu",
        compute_type="int8",
        cpu_threads=max(1, min(4, (os.cpu_count() or 4) // 2)),
        num_workers=1,
    )
    if download_root:
        Path(download_root).mkdir(parents=True, exist_ok=True)
        kwargs["download_root"] = download_root

    MODEL = WhisperModel(model_size, **kwargs)
    LOADED_KEY = key
    MODEL_SIZE = model_size
    respond(
        True,
        status="loaded",
        modelSize=model_size,
        device="cpu",
        computeType="int8",
        downloadRoot=download_root or None,
    )


def _transcribe_path(wav_path: str) -> dict[str, Any]:
    if MODEL is None:
        raise RuntimeError("ASR not loaded; call load first")

    # Full-file decode. No VAD trim (can drop soft openings on TTS).
    segments, info = MODEL.transcribe(
        wav_path,
        language="ja",
        task="transcribe",
        beam_size=1,
        best_of=1,
        patience=1.0,
        temperature=0.0,
        condition_on_previous_text=False,
        without_timestamps=True,
        vad_filter=False,
        word_timestamps=False,
    )
    parts: list[str] = []
    for seg in segments:
        t = (seg.text or "").strip()
        if t:
            parts.append(t)
    text = "".join(parts).strip()
    # Whisper often inserts ASCII spaces between CJK — strip for CER kana path.
    text = text.replace(" ", "").replace("\u3000", "")

    return {
        "text": text,
        "language": getattr(info, "language", "ja"),
        "durationSec": round(float(getattr(info, "duration", 0.0) or 0.0), 3),
        "modelSize": MODEL_SIZE,
        "device": "cpu",
    }


def handle_transcribe(req: dict[str, Any]) -> None:
    wav_path = str(req["wavPath"] if "wavPath" in req else req["wav_path"])
    info = _transcribe_path(wav_path)
    respond(True, **info)


def handle_verify(req: dict[str, Any]) -> None:
    from kana_normalize import char_error_rate, normalize_kana

    wav_path = str(req["wavPath"] if "wavPath" in req else req["wav_path"])
    expected = str(req.get("expectedText") or req.get("expected_text") or "")
    info = _transcribe_path(wav_path)
    asr_text = str(info.get("text") or "")
    expected_kana = normalize_kana(expected)
    actual_kana = normalize_kana(asr_text)
    cer = char_error_rate(expected_kana, actual_kana)
    respond(
        True,
        asrText=asr_text,
        expectedKana=expected_kana,
        actualKana=actual_kana,
        cer=cer,
        durationSec=info.get("durationSec"),
        modelSize=info.get("modelSize"),
        device=info.get("device"),
    )


def main() -> int:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))

    respond(True, status="ready", engine="faster-whisper")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = str(req.get("cmd", ""))
            if cmd == "ping":
                respond(True, status="pong")
            elif cmd == "load":
                handle_load(req)
            elif cmd == "transcribe":
                handle_transcribe(req)
            elif cmd == "verify":
                handle_verify(req)
            elif cmd == "shutdown":
                respond(True, status="bye")
                break
            else:
                respond(False, error=f"unknown cmd: {cmd}")
        except Exception as e:  # noqa: BLE001
            respond(False, error=str(e), trace=traceback.format_exc()[-800:])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
