#!/usr/bin/env python3
"""One-shot ASR (legacy). Prefer asr_worker.py.

Uses faster-whisper on CPU only.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("CT2_FORCE_CPU", "1")


def main() -> int:
    raw = sys.stdin.read()
    req = json.loads(raw) if raw.strip() else {}
    wav = str(req.get("wavPath") or req.get("wav_path") or "")
    download_root = str(req.get("downloadRoot") or req.get("modelDir") or "").strip()
    model_size = str(req.get("modelSize") or "small")
    if model_size not in ("tiny", "base", "small"):
        model_size = "small"
    if not wav:
        print(json.dumps({"ok": False, "error": "wavPath required"}, ensure_ascii=False))
        return 1

    from faster_whisper import WhisperModel

    kwargs = dict(device="cpu", compute_type="int8", cpu_threads=4, num_workers=1)
    if download_root:
        Path(download_root).mkdir(parents=True, exist_ok=True)
        kwargs["download_root"] = download_root
    model = WhisperModel(model_size, **kwargs)
    segments, _info = model.transcribe(
        wav,
        language="ja",
        beam_size=1,
        temperature=0.0,
        condition_on_previous_text=False,
        without_timestamps=True,
        vad_filter=False,
    )
    text = "".join((s.text or "").strip() for s in segments).replace(" ", "").replace("\u3000", "")
    print(json.dumps({"ok": True, "text": text}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
