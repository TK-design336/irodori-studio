#!/usr/bin/env python3
"""Lightweight speaker clustering for sliced training clips."""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

UNKNOWN = "?"


def emit_fraction(i: int, n: int, detail: str = "") -> None:
    frac = (i / n) if n else 1.0
    payload: dict[str, Any] = {"fraction": frac, "current": i, "total": n}
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def list_wavs(sliced_dir: Path) -> list[Path]:
    return sorted(p for p in sliced_dir.iterdir() if p.suffix.lower() == ".wav")


def _load_mono(path: Path, target_sr: int = 16000):
    import numpy as np

    try:
        import soundfile as sf

        data, sr = sf.read(str(path), always_2d=False)
    except Exception:
        from pydub import AudioSegment

        seg = AudioSegment.from_file(path).set_channels(1).set_frame_rate(target_sr)
        samples = np.array(seg.get_array_of_samples(), dtype=np.float32)
        sw = int(seg.sample_width)
        if sw == 1:
            data = (samples - 128.0) / 128.0
        elif sw == 2:
            data = samples / 32768.0
        else:
            data = samples
            peak = float(np.max(np.abs(data))) or 1.0
            data = data / peak
        sr = target_sr
    data = np.asarray(data, dtype=np.float32)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != target_sr and len(data) > 1:
        x_old = np.linspace(0.0, 1.0, num=len(data), endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=int(len(data) * target_sr / sr), endpoint=False)
        data = np.interp(x_new, x_old, data).astype(np.float32)
    return np.clip(data, -1.0, 1.0)


def _embedding(wav: Path) -> list[float]:
    import numpy as np

    x = _load_mono(wav)
    if x.size < 400:
        return [0.0] * 32
    # Optional higher-quality embedding when resemblyzer is installed.
    try:
        from resemblyzer import VoiceEncoder, preprocess_wav

        enc = VoiceEncoder()
        pre = preprocess_wav(x, 16000)
        vec = enc.embed_utterance(pre)
        return [float(v) for v in vec[:64]]
    except Exception:
        pass
    frame = 400
    hop = 200
    feats: list[float] = []
    for i in range(0, max(1, len(x) - frame), hop):
        chunk = x[i : i + frame]
        rms = float(np.sqrt(np.mean(chunk * chunk) + 1e-12))
        zcr = float(np.mean(np.abs(np.diff(np.signbit(chunk).astype(np.float32)))))
        feats.extend([rms, zcr])
    arr = np.asarray(feats, dtype=np.float32)
    if arr.size < 32:
        arr = np.pad(arr, (0, 32 - arr.size))
    vec = arr[:32]
    norm = float(np.linalg.norm(vec)) or 1.0
    return [float(v / norm) for v in vec]


def _kmeans2(vectors: list[list[float]], k: int = 2, iters: int = 20):
    import random

    if len(vectors) <= k:
        return list(range(len(vectors))), vectors
    dim = len(vectors[0])
    idxs = random.sample(range(len(vectors)), k)
    cents = [vectors[i][:] for i in idxs]
    assign = [0] * len(vectors)
    for _ in range(iters):
        for i, v in enumerate(vectors):
            best = 0
            best_d = math.inf
            for c, cent in enumerate(cents):
                d = sum((a - b) ** 2 for a, b in zip(v, cent))
                if d < best_d:
                    best_d = d
                    best = c
            assign[i] = best
        buckets: list[list[list[float]]] = [[] for _ in range(k)]
        for a, v in zip(assign, vectors):
            buckets[a].append(v)
        for c in range(k):
            if buckets[c]:
                cents[c] = [sum(col) / len(buckets[c]) for col in zip(*buckets[c])]
    return assign, cents


def cluster_labels(wavs: list[Path]) -> dict[str, str]:
    if len(wavs) <= 1:
        return {w.name: "A" for w in wavs}
    vectors = [_embedding(w) for w in wavs]
    assign, cents = _kmeans2(vectors, k=min(2, len(vectors)))
    labels = ["A", "B"]
    dists: list[float] = []
    for v, a in zip(vectors, assign):
        cent = cents[a]
        d = math.sqrt(sum((x - y) ** 2 for x, y in zip(v, cent)))
        dists.append(d)
    med = sorted(dists)[len(dists) // 2] if dists else 0.0
    thresh = max(0.35, med * 1.8)
    out: dict[str, str] = {}
    for w, a, d in zip(wavs, assign, dists):
        if d > thresh:
            out[w.name] = UNKNOWN
        else:
            out[w.name] = labels[a]
    # If only one cluster effectively used, collapse to A.
    used = {v for v in out.values() if v != UNKNOWN}
    if len(used) <= 1:
        for k in list(out):
            if out[k] != UNKNOWN:
                out[k] = "A"
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Speaker diarization for sliced clips")
    parser.add_argument("--sliced-dir", required=True)
    parser.add_argument("--out-json", required=True)
    args = parser.parse_args()

    sliced_dir = Path(args.sliced_dir)
    out_json = Path(args.out_json)
    if not sliced_dir.is_dir():
        print(f"ERROR: sliced dir not found: {sliced_dir}", file=sys.stderr)
        return 1

    wavs = list_wavs(sliced_dir)
    if not wavs:
        payload = {
            "enabled": True,
            "clusters": [],
            "labels": {},
            "selected": [],
        }
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 0

    labels = cluster_labels(wavs)
    clusters = sorted({v for v in labels.values() if v})
    selected: list[str] = []
    known = [c for c in clusters if c != UNKNOWN]
    if len(known) == 1:
        selected = known[:]

    payload = {
        "enabled": True,
        "clusters": clusters,
        "labels": labels,
        "selected": selected,
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    metrics_path = out_json.parent / "metrics.json"
    if metrics_path.is_file():
        try:
            metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
            slices = metrics.get("slices")
            if isinstance(slices, list):
                for row in slices:
                    if not isinstance(row, dict):
                        continue
                    name = str(row.get("file") or "")
                    if name in labels:
                        row["speakerCluster"] = labels[name]
                metrics_path.write_text(
                    json.dumps(metrics, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
        except (OSError, json.JSONDecodeError):
            pass

    emit_fraction(len(wavs), len(wavs), f"{len(clusters)} clusters")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
