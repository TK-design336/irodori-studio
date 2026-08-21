#!/usr/bin/env python3
"""Batch slice-review metrics (aspects A–J) for Irodori Studio training.

Signal-statistics only (no Whisper / no ONNX). Flags are distribution
outliers (z-score + Tukey IQR), not absolute thresholds.

Aspect I covers muffled audio and oddly resonant / reverberant audio.

Writes metrics.json / cache_key.json under --out-dir.
Optional --apply-auto writes exclusions.json + review_log.json.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any, Literal

METRICS_VERSION = 3

YOON_START = set("ャュョャュョぁぃぅぇぉァィゥェォゃゅょ")
Side = Literal["both", "low", "high"]


def emit_fraction(i: int, n: int, detail: str = "") -> None:
    frac = (i / n) if n else 1.0
    payload: dict[str, Any] = {"fraction": frac, "current": i, "total": n}
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def load_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def list_wavs(sliced_dir: Path) -> list[Path]:
    return sorted(p for p in sliced_dir.iterdir() if p.suffix.lower() == ".wav")


def file_sig(path: Path) -> dict[str, Any]:
    st = path.stat()
    return {"name": path.name, "size": st.st_size, "mtimeNs": int(st.st_mtime_ns)}


def build_cache_key(
    wavs: list[Path],
    aspects: dict[str, bool],
    thresholds: dict[str, Any],
) -> dict[str, Any]:
    files = [file_sig(p) for p in wavs]
    blob = json.dumps(
        {"v": METRICS_VERSION, "aspects": aspects, "thresholds": thresholds, "files": files},
        sort_keys=True,
        ensure_ascii=False,
    )
    return {
        "version": METRICS_VERSION,
        "hash": hashlib.sha256(blob.encode("utf-8")).hexdigest(),
        "aspects": aspects,
        "thresholds": thresholds,
        "files": files,
    }


def zscore(values: list[float | None]) -> list[float | None]:
    valid = [v for v in values if v is not None and math.isfinite(v)]
    if len(valid) < 2:
        return [None] * len(values)
    mean = sum(valid) / len(valid)
    var = sum((v - mean) ** 2 for v in valid) / max(1, len(valid) - 1)
    std = math.sqrt(var) if var > 1e-18 else 0.0
    if std <= 0:
        return [0.0 if v is not None and math.isfinite(v) else None for v in values]
    out: list[float | None] = []
    for v in values:
        if v is None or not math.isfinite(v):
            out.append(None)
        else:
            out.append((v - mean) / std)
    return out


def iqr_one_sided(
    values: list[float | None],
    mult: float,
    side: Side,
) -> list[bool]:
    valid = sorted(v for v in values if v is not None and math.isfinite(v))
    if len(valid) < 4:
        return [False] * len(values)
    q1 = valid[len(valid) // 4]
    q3 = valid[(3 * len(valid)) // 4]
    iqr = q3 - q1
    lo = q1 - mult * iqr
    hi = q3 + mult * iqr
    flags: list[bool] = []
    for v in values:
        if v is None or not math.isfinite(v):
            flags.append(False)
        elif side == "low":
            flags.append(v < lo)
        elif side == "high":
            flags.append(v > hi)
        else:
            flags.append(v < lo or v > hi)
    return flags


def dist_hits(
    values: list[float | None],
    z_thresh: float,
    iqr_mult: float,
    side: Side,
) -> tuple[list[bool], list[float | None], list[float]]:
    """Distribution outliers. badness is always >= 0 (how far on the bad side)."""
    zs = zscore(values)
    iqr = iqr_one_sided(values, iqr_mult, side)
    flags: list[bool] = []
    badness: list[float] = []
    for z, iq in zip(zs, iqr):
        if z is None:
            flags.append(False)
            badness.append(0.0)
            continue
        if side == "low":
            bad = max(0.0, -float(z))
            hit = z <= -z_thresh
        elif side == "high":
            bad = max(0.0, float(z))
            hit = z >= z_thresh
        else:
            bad = abs(float(z))
            hit = abs(z) >= z_thresh
        flags.append(bool(hit or iq))
        badness.append(bad)
    return flags, zs, badness


def mora_count(text: str) -> int:
    """Count Japanese mora via g2p kana, joining yoon to previous mora."""
    if not text or not text.strip():
        return 0
    try:
        import pyopenjtalk

        kana = pyopenjtalk.g2p(text, kana=True) or ""
    except Exception:  # noqa: BLE001
        kana = text
    kana = kana.replace(" ", "").replace("\u3000", "")
    count = 0
    for ch in kana:
        if ch in YOON_START or ch in "ャュョゃゅょァィゥェォぁぃぅぇぉ":
            continue
        if "\u30a0" <= ch <= "\u30ff" or "\u3040" <= ch <= "\u309f" or ch == "ー":
            count += 1
        elif ch.isascii() and ch.isalnum():
            count += 1
    return max(0, count)


def load_transcripts(sliced_dir: Path, wavs: list[Path]) -> dict[str, str]:
    out: dict[str, str] = {}
    tj = sliced_dir / "transcripts.json"
    if tj.is_file():
        data = load_json(tj, {})
        if isinstance(data, dict):
            for k, v in data.items():
                if isinstance(v, str) and v.strip():
                    out[str(k)] = v.strip()
    for w in wavs:
        if w.name in out:
            continue
        side = w.with_suffix(".txt")
        if side.is_file():
            try:
                t = side.read_text(encoding="utf-8").strip()
                if t:
                    out[w.name] = t
            except OSError:
                pass
    return out


def compute_signal_metrics(y, sr: int) -> dict[str, Any]:
    import numpy as np
    import pyloudnorm as pyln

    duration = float(len(y) / sr) if sr else 0.0
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    peak_db = 20.0 * math.log10(max(peak, 1e-12))
    clip_ratio = float(np.mean(np.abs(y) >= 0.99)) if len(y) else 0.0

    frame = max(1, int(0.025 * sr))
    hop = max(1, int(0.010 * sr))
    if len(y) < frame:
        silence_ratio = 1.0 if peak < 1e-4 else 0.0
    else:
        frames = np.lib.stride_tricks.sliding_window_view(y, frame)[::hop]
        rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
        thr = max(1e-5, float(np.median(rms)) * 0.2)
        silence_ratio = float(np.mean(rms < thr))

    try:
        meter = pyln.Meter(sr)
        y_l = y
        if len(y_l) < int(0.4 * sr):
            y_l = np.pad(y_l, (0, int(0.4 * sr) - len(y_l)))
        lufs = float(meter.integrated_loudness(y_l.astype(np.float64)))
        if not math.isfinite(lufs):
            lufs = -70.0
    except Exception:  # noqa: BLE001
        lufs = -70.0

    n_fft = 2048
    win = np.hanning(n_fft).astype(np.float32)
    hop_stft = hop
    if len(y) < n_fft:
        spec = np.abs(np.fft.rfft(np.pad(y, (0, n_fft - len(y))) * win)) ** 2
        mag = spec.astype(np.float64) + 1e-12
        specs_t = mag[:, None]
    else:
        n_fr = 1 + (len(y) - n_fft) // hop_stft
        specs = []
        for i in range(n_fr):
            chunk = y[i * hop_stft : i * hop_stft + n_fft]
            specs.append(np.abs(np.fft.rfft(chunk * win)) ** 2)
        specs_t = np.stack(specs, axis=1).astype(np.float64) + 1e-12
        mag = np.mean(specs_t, axis=1)

    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    total_e = float(np.sum(mag))
    high_mask = freqs >= 4000
    high_band_ratio = float(np.sum(mag[high_mask]) / total_e) if total_e > 0 else 0.0

    pos = freqs > 50
    if np.any(pos):
        xf = np.log2(freqs[pos] + 1e-9)
        yf = 10.0 * np.log10(mag[pos])
        slope = float(np.polyfit(xf, yf, 1)[0])
    else:
        slope = 0.0

    cum = np.cumsum(mag) / total_e if total_e > 0 else np.cumsum(mag)
    roll_idx = int(np.searchsorted(cum, 0.85))
    bw_idx = int(np.searchsorted(cum, 0.95))
    rolloff = float(freqs[min(roll_idx, len(freqs) - 1)])
    bandwidth_hz = float(freqs[min(bw_idx, len(freqs) - 1)])
    centroid = float(np.sum(freqs * mag) / total_e) if total_e > 0 else 0.0

    band = (freqs >= 80) & (freqs <= min(sr * 0.5 - 1.0, 12000.0))
    band_mag = mag[band] if np.any(band) else mag
    mean_p = float(np.mean(band_mag))
    if mean_p > 0:
        geo = float(np.exp(np.mean(np.log(band_mag))))
        spectral_flatness = geo / mean_p
        spectral_crest = float(np.max(band_mag) / mean_p)
    else:
        spectral_flatness = 1.0
        spectral_crest = 1.0

    n_t = int(specs_t.shape[1])
    if n_t >= 4:
        early = specs_t[:, : max(1, n_t // 2)]
        late = specs_t[:, int(n_t * 0.7) :]
        early_e = float(np.mean(np.sum(early, axis=0)))
        late_e = float(np.mean(np.sum(late, axis=0)))
        tail_ratio = late_e / max(early_e, 1e-12)
        early_hf = float(np.sum(early[high_mask]) / max(float(np.sum(early)), 1e-12))
        late_hf = float(np.sum(late[high_mask]) / max(float(np.sum(late)), 1e-12))
        hf_sustain = late_hf / max(early_hf, 1e-8)
    else:
        tail_ratio = 0.0
        hf_sustain = 1.0

    if len(y) >= frame * 8:
        env_frames = np.lib.stride_tricks.sliding_window_view(y, frame)[::hop]
        env = np.sqrt(np.mean(env_frames.astype(np.float64) ** 2, axis=1))
        env_mean = float(np.mean(env))
        env_crest = float(np.max(env) / max(env_mean, 1e-12))
    else:
        env_crest = 1.0 if peak > 1e-8 else 0.0

    return {
        "duration": round(duration, 4),
        "silenceRatio": round(silence_ratio, 4),
        "lufs": round(lufs, 3),
        "peakDb": round(peak_db, 3),
        "clipRatio": round(clip_ratio, 5),
        "highBandRatio": round(high_band_ratio, 4),
        "spectralTilt": round(slope, 3),
        "rolloff85Hz": round(rolloff, 1),
        "bandwidthHz": round(bandwidth_hz, 1),
        "spectralCentroid": round(centroid, 1),
        "spectralFlatness": round(spectral_flatness, 5),
        "spectralCrest": round(spectral_crest, 4),
        "tailRatio": round(tail_ratio, 4),
        "hfSustain": round(hf_sustain, 4),
        "envCrest": round(env_crest, 4),
        "f0Mean": None,
    }


def mfcc_embed(y, sr: int):
    """Cheap speaker proxy: MFCC mean+std. No ONNX."""
    import numpy as np
    import librosa

    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20)
    return np.concatenate(
        [mfcc.mean(axis=1), mfcc.std(axis=1)]
    ).astype(np.float32)


def cosine(a, b) -> float:
    import numpy as np

    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na < 1e-12 or nb < 1e-12:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def aspect_enabled(aspects: dict[str, bool], key: str) -> bool:
    default = key not in ("E", "J")
    return bool(aspects.get(key, default))


def _as_opt(v: Any) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def main() -> int:
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))

    parser = argparse.ArgumentParser(description="Slice review metrics batch")
    parser.add_argument("--sliced-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--model-cache-dir", default="")
    parser.add_argument("--config-json", default="")
    parser.add_argument("--asr-model-dir", default="")
    parser.add_argument("--apply-auto", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    sliced_dir = Path(args.sliced_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cfg: dict[str, Any] = {}
    if args.config_json.strip():
        cfg = json.loads(Path(args.config_json).read_text(encoding="utf-8"))
    aspects = dict(cfg.get("aspects") or {})
    for k in list(aspects.keys()):
        aspects[k.upper() if len(k) == 1 else k] = aspects[k]
    thresholds = dict(cfg.get("thresholds") or {})
    auto_cfg = dict(cfg.get("auto") or {})

    def th(name: str, default: float) -> float:
        camel = {
            "outlier_z": "outlierZ",
            "duration_z": "durationZ",
            "duration_iqr_mult": "durationIqrMult",
            "speed_z": "speedZ",
            "centroid_z": "centroidZ",
        }.get(name, name)
        v = thresholds.get(camel, thresholds.get(name, default))
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    wavs = list_wavs(sliced_dir)
    if not wavs:
        print("ERROR: no wav files in sliced dir", file=sys.stderr)
        return 1

    cache_key = build_cache_key(wavs, aspects, thresholds)
    cache_path = out_dir / "cache_key.json"
    metrics_path = out_dir / "metrics.json"
    prev = load_json(cache_path, {})
    if (
        not args.force
        and isinstance(prev, dict)
        and prev.get("hash") == cache_key["hash"]
        and prev.get("version") == METRICS_VERSION
        and metrics_path.is_file()
    ):
        print("SKIP metrics (cache hit)", flush=True)
        metrics = load_json(metrics_path, {})
        if args.apply_auto:
            apply_auto_exclusions(out_dir, metrics, aspects, thresholds, th, auto_cfg)
        emit_fraction(1, 1, "cache")
        print(f"DONE: cached {len(wavs)} slices", flush=True)
        return 0

    import numpy as np
    import soundfile as sf

    transcripts = load_transcripts(sliced_dir, wavs)
    need_spk = aspect_enabled(aspects, "F")

    rows: list[dict[str, Any]] = []
    embeds: list[Any] = []
    embed_names: list[str] = []
    n = len(wavs)
    print(f"REVIEW_METRICS slices={n} signal-only", flush=True)
    for i, w in enumerate(wavs, start=1):
        emit_fraction(i, n, w.name)
        y, sr = sf.read(str(w), always_2d=False)
        if getattr(y, "ndim", 1) > 1:
            y = np.mean(y, axis=1)
        y = np.asarray(y, dtype=np.float32)
        sig = compute_signal_metrics(y, int(sr))
        script = transcripts.get(w.name)
        mora = mora_count(script) if script else 0
        dur = float(sig["duration"] or 0.0)
        speed = (mora / dur) if script and dur > 0.05 else None
        speech_ratio = max(0.0, 1.0 - float(sig["silenceRatio"]))

        emb = None
        if need_spk:
            try:
                emb = mfcc_embed(y, int(sr))
            except Exception as e:  # noqa: BLE001
                print(f"WARN MFCC {w.name}: {e}", flush=True)
        if emb is not None:
            embeds.append(emb)
            embed_names.append(w.name)

        rows.append(
            {
                "file": w.name,
                "path": str(w.resolve()),
                "scriptText": script,
                "asrText": None,
                "moraCount": mora,
                "speedMoraPerSec": None if speed is None else round(speed, 3),
                "cer": None,
                "noSpeechProb": 0.0,
                "speechRatio": round(speech_ratio, 4),
                "mos": None,
                **sig,
            }
        )

    speaker_sims: dict[str, float] = {}
    hist_sims: list[float] = []
    if embeds:
        stack = np.stack(embeds, axis=0)
        centroid = np.median(stack, axis=0)
        for name, emb in zip(embed_names, embeds):
            sim = cosine(emb, centroid)
            speaker_sims[name] = round(sim, 4)
            hist_sims.append(sim)
        for row in rows:
            row["speakerSim"] = speaker_sims.get(row["file"])

    z_common = th("outlier_z", th("duration_z", 3.0))
    iqr_mult = th("duration_iqr_mult", 1.5)

    dur_f, dur_z, dur_b = dist_hits(
        [_as_opt(r["duration"]) for r in rows],
        th("duration_z", z_common),
        iqr_mult,
        "both",
    )
    spd_f, spd_z, spd_b = dist_hits(
        [_as_opt(r.get("speedMoraPerSec")) for r in rows],
        th("speed_z", z_common),
        iqr_mult,
        "both",
    )
    sil_f, sil_z, sil_b = dist_hits(
        [_as_opt(r["silenceRatio"]) for r in rows],
        z_common,
        iqr_mult,
        "both",
    )
    lufs_f, lufs_z, lufs_b = dist_hits(
        [_as_opt(r["lufs"]) for r in rows],
        z_common,
        iqr_mult,
        "both",
    )
    peak_f, peak_z, peak_b = dist_hits(
        [_as_opt(r["peakDb"]) for r in rows],
        z_common,
        iqr_mult,
        "high",
    )
    clip_f, clip_z, clip_b = dist_hits(
        [_as_opt(r["clipRatio"]) for r in rows],
        z_common,
        iqr_mult,
        "high",
    )
    sim_f, sim_z, sim_b = dist_hits(
        [_as_opt(r.get("speakerSim")) for r in rows],
        z_common,
        iqr_mult,
        "low",
    )
    cent_f, cent_z, cent_b = dist_hits(
        [_as_opt(r["spectralCentroid"]) for r in rows],
        th("centroid_z", z_common),
        iqr_mult,
        "both",
    )
    spk_f, spk_z, spk_b = dist_hits(
        [_as_opt(r.get("speechRatio")) for r in rows],
        z_common,
        iqr_mult,
        "low",
    )

    # I: composite "muffled" from already-standardized spectral features
    hb_z = zscore([_as_opt(r["highBandRatio"]) for r in rows])
    ro_z = zscore([_as_opt(r["rolloff85Hz"]) for r in rows])
    bw_z = zscore([_as_opt(r["bandwidthHz"]) for r in rows])
    ti_z = zscore([_as_opt(r["spectralTilt"]) for r in rows])
    muffle: list[float | None] = []
    for i in range(len(rows)):
        parts: list[float] = []
        for z in (hb_z[i], ro_z[i], bw_z[i], ti_z[i]):
            if z is not None:
                parts.append(-float(z))
        muffle.append(sum(parts) / len(parts) if parts else None)
    muf_f, muf_z, muf_b = dist_hits(muffle, z_common, iqr_mult, "high")

    # I: composite "ring / reverb" (peaked spectrum, smeared envelope, late energy)
    cr_z = zscore([_as_opt(r.get("spectralCrest")) for r in rows])
    fl_z = zscore([_as_opt(r.get("spectralFlatness")) for r in rows])
    ta_z = zscore([_as_opt(r.get("tailRatio")) for r in rows])
    hf_z = zscore([_as_opt(r.get("hfSustain")) for r in rows])
    en_z = zscore([_as_opt(r.get("envCrest")) for r in rows])
    ring: list[float | None] = []
    for i in range(len(rows)):
        rparts: list[float] = []
        # high crest, low flatness, high tail, high HF sustain, low envelope crest
        for z, sign in (
            (cr_z[i], 1.0),
            (fl_z[i], -1.0),
            (ta_z[i], 1.0),
            (hf_z[i], 1.0),
            (en_z[i], -1.0),
        ):
            if z is not None:
                rparts.append(sign * float(z))
        ring.append(sum(rparts) / len(rparts) if rparts else None)
    ring_f, ring_z, ring_b = dist_hits(ring, z_common, iqr_mult, "high")

    for i, row in enumerate(rows):
        flags: dict[str, bool] = {}
        scores: dict[str, Any] = {}
        parts: dict[str, float] = {}

        if aspect_enabled(aspects, "A"):
            scores["A"] = {
                "duration": row["duration"],
                "z": dur_z[i],
                "badness": round(dur_b[i], 4),
            }
            flags["A"] = dur_f[i]
            parts["A"] = dur_b[i]
        if aspect_enabled(aspects, "B"):
            scores["B"] = {
                "speed": row.get("speedMoraPerSec"),
                "z": spd_z[i],
                "badness": round(spd_b[i], 4),
            }
            flags["B"] = spd_f[i]
            parts["B"] = spd_b[i]
        if aspect_enabled(aspects, "C"):
            scores["C"] = {
                "silenceRatio": row["silenceRatio"],
                "z": sil_z[i],
                "badness": round(sil_b[i], 4),
            }
            flags["C"] = sil_f[i]
            parts["C"] = sil_b[i]
        if aspect_enabled(aspects, "D"):
            d_bad = max(lufs_b[i], peak_b[i], clip_b[i])
            scores["D"] = {
                "lufs": row["lufs"],
                "peakDb": row["peakDb"],
                "clipRatio": row["clipRatio"],
                "lufsZ": lufs_z[i],
                "peakZ": peak_z[i],
                "clipZ": clip_z[i],
                "badness": round(d_bad, 4),
            }
            flags["D"] = bool(lufs_f[i] or peak_f[i] or clip_f[i])
            parts["D"] = d_bad
        if aspect_enabled(aspects, "F"):
            scores["F"] = {
                "speakerSim": row.get("speakerSim"),
                "z": sim_z[i],
                "badness": round(sim_b[i], 4),
            }
            flags["F"] = sim_f[i]
            parts["F"] = sim_b[i]
        if aspect_enabled(aspects, "G"):
            scores["G"] = {
                "centroid": row["spectralCentroid"],
                "z": cent_z[i],
                "badness": round(cent_b[i], 4),
            }
            flags["G"] = cent_f[i]
            parts["G"] = cent_b[i]
        if aspect_enabled(aspects, "H"):
            scores["H"] = {
                "speechRatio": row.get("speechRatio"),
                "z": spk_z[i],
                "badness": round(spk_b[i], 4),
            }
            flags["H"] = spk_f[i]
            parts["H"] = spk_b[i]
        if aspect_enabled(aspects, "I"):
            i_bad = max(muf_b[i], ring_b[i])
            scores["I"] = {
                "highBandRatio": row["highBandRatio"],
                "spectralTilt": row["spectralTilt"],
                "rolloff85Hz": row["rolloff85Hz"],
                "bandwidthHz": row["bandwidthHz"],
                "spectralCrest": row.get("spectralCrest"),
                "spectralFlatness": row.get("spectralFlatness"),
                "tailRatio": row.get("tailRatio"),
                "hfSustain": row.get("hfSustain"),
                "envCrest": row.get("envCrest"),
                "muffle": None if muffle[i] is None else round(float(muffle[i]), 4),
                "ring": None if ring[i] is None else round(float(ring[i]), 4),
                "muffleHit": bool(muf_f[i]),
                "ringHit": bool(ring_f[i]),
                "muffleZ": muf_z[i],
                "ringZ": ring_z[i],
                "z": ring_z[i] if ring_b[i] >= muf_b[i] else muf_z[i],
                "badness": round(i_bad, 4),
            }
            flags["I"] = bool(muf_f[i] or ring_f[i])
            parts["I"] = i_bad

        hit = [k for k, v in flags.items() if v]
        outlier = float(sum(parts.values()))
        row["flags"] = flags
        row["scores"] = scores
        row["hitAspects"] = hit
        row["hitCount"] = len(hit)
        row["outlierScore"] = round(outlier, 4)
        row["outlierParts"] = {k: round(v, 4) for k, v in parts.items()}

    metrics = {
        "version": METRICS_VERSION,
        "count": len(rows),
        "slices": rows,
        "speakerSimHistogram": hist_sims,
        "aspects": aspects,
        "thresholds": thresholds,
    }
    save_json(metrics_path, metrics)
    save_json(cache_path, cache_key)

    if args.apply_auto:
        apply_auto_exclusions(out_dir, metrics, aspects, thresholds, th, auto_cfg)

    print(f"DONE: wrote metrics for {len(rows)} slices → {metrics_path}", flush=True)
    return 0


def apply_auto_exclusions(
    out_dir: Path,
    metrics: dict[str, Any],
    aspects: dict[str, Any],
    thresholds: dict[str, Any],
    th_fn,
    auto_cfg: dict[str, Any] | None = None,
) -> None:
    _ = (aspects, thresholds, th_fn)
    exclusions = load_json(out_dir / "exclusions.json", {})
    if not isinstance(exclusions, dict):
        exclusions = {}
    rows = list(metrics.get("slices") or [])
    by_aspect: dict[str, int] = {}
    newly = 0
    for row in rows:
        hits = list(row.get("hitAspects") or [])
        if not hits:
            continue
        name = row["file"]
        prev = exclusions.get(name) if isinstance(exclusions.get(name), dict) else {}
        if prev.get("excluded"):
            continue
        exclusions[name] = {
            "excluded": True,
            "source": "auto",
            "aspects": hits,
            "flagged": True,
        }
        newly += 1
        for a in hits:
            by_aspect[a] = by_aspect.get(a, 0) + 1

    auto = auto_cfg if isinstance(auto_cfg, dict) else {}
    try:
        remove_pct = float(auto.get("removePercent", auto.get("remove_percent", 0)) or 0)
    except (TypeError, ValueError):
        remove_pct = 0.0
    try:
        keep_max = int(auto.get("keepMax", auto.get("keep_max", 0)) or 0)
    except (TypeError, ValueError):
        keep_max = 0
    remove_pct = min(90.0, max(0.0, remove_pct))
    keep_max = max(0, keep_max)

    total = len(rows)
    already = sum(
        1
        for r in rows
        if isinstance(exclusions.get(r["file"]), dict)
        and exclusions[r["file"]].get("excluded")
    )
    target_exclude = 0
    if remove_pct > 0 and total > 0:
        target_exclude = max(target_exclude, int(math.ceil(total * remove_pct / 100.0)))
    if keep_max > 0 and total > keep_max:
        target_exclude = max(target_exclude, total - keep_max)
    if total > 1:
        target_exclude = min(target_exclude, total - 1)
    need = max(0, target_exclude - already)
    score_cut = 0
    if need > 0:
        eligible = [
            r
            for r in rows
            if not (
                isinstance(exclusions.get(r["file"]), dict)
                and exclusions[r["file"]].get("excluded")
            )
        ]
        eligible.sort(
            key=lambda r: float(r.get("outlierScore") or 0.0),
            reverse=True,
        )
        for row in eligible[:need]:
            name = row["file"]
            prev = exclusions.get(name) if isinstance(exclusions.get(name), dict) else {}
            exclusions[name] = {
                **prev,
                "excluded": True,
                "source": prev.get("source") or "auto-score",
                "aspects": list(prev.get("aspects") or ["score"]),
                "flagged": True,
            }
            newly += 1
            score_cut += 1
        if score_cut:
            by_aspect["score"] = by_aspect.get("score", 0) + score_cut

    save_json(out_dir / "exclusions.json", exclusions)
    log = {
        "mode": "auto",
        "excludedCount": newly,
        "byAspect": by_aspect,
        "totalSlices": metrics.get("count"),
        "removePercent": remove_pct,
        "keepMax": keep_max,
        "scoreCut": score_cut,
    }
    save_json(out_dir / "review_log.json", log)
    print(
        f"AUTO_EXCLUDE count={newly} byAspect={json.dumps(by_aspect)} "
        f"removePercent={remove_pct} keepMax={keep_max}",
        flush=True,
    )


if __name__ == "__main__":
    raise SystemExit(main())
