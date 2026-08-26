#!/usr/bin/env python3
"""Non-generative Auto Fix for sliced training clips.

Detects gym/tunnel-like reverb and muffled / noisy slices with *absolute*
signal stats (not batch z-scores — a whole session can be wet). Applies:

- WPE (early reflections) + Habets-style late-reverb suppression
- Spectral tilt / boxiness EQ
- High-pass, light Wiener denoise, soft declip

Always processes from a backup copy so re-runs do not stack.
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from pathlib import Path
from typing import Any

VERSION = 1

# --- absolute detection (speech @ ~44.1 kHz) --------------------------------
# Studio close-mic post-speech DRR is typically > 20 dB; gym/hall often < 12.
DRR_BATCH_DB = 16.0
DRR_SLICE_DB = 12.0
RT60_BATCH_S = 0.50
RT60_SLICE_S = 0.65
TILT_BATCH = -11.0  # dB / octave (more negative = duller)
TILT_SLICE = -12.5
HIGH_BAND_BATCH = 0.018
HIGH_BAND_SLICE = 0.012
SNR_DENOISE_DB = 16.0
RUMBLE_RATIO = 0.10
CLIP_RATIO = 5e-4
BOX_RATIO = 4.0  # 200–500 Hz power / 1–4 kHz power
TARGET_TILT = -6.5
MAX_TILT_LIFT = 8.0  # dB/oct applied
PEAK_CEIL = 0.99


def emit_fraction(i: int, n: int, detail: str = "") -> None:
    frac = (i / n) if n else 1.0
    payload: dict[str, Any] = {"fraction": frac, "current": i, "total": n}
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def list_wavs(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.suffix.lower() == ".wav")


def _as_mono_float(y) -> Any:
    import numpy as np

    y = np.asarray(y)
    if y.ndim > 1:
        y = np.mean(y, axis=1)
    y = y.astype(np.float64, copy=False)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak > 1.5:
        y = y / 32768.0
    return np.clip(y, -1.0, 1.0)


def _rms(y) -> float:
    import numpy as np

    if y.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(y, dtype=np.float64))))


def _frame_rms(y, sr: int, win_s: float = 0.02, hop_s: float = 0.010):
    import numpy as np

    win = max(8, int(win_s * sr))
    hop = max(1, int(hop_s * sr))
    if y.size < win:
        r = _rms(y)
        return np.array([r], dtype=np.float64)
    frames = np.lib.stride_tricks.sliding_window_view(y, win)[::hop]
    return np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1))


def estimate_c50_rt60(y, sr: int) -> tuple[float, float]:
    """Post-speech DRR (dB) and a T15→RT60 proxy from the RMS tail.

    Global-peak C50 is the wrong tool on speech slices (the 'late' window
    still contains the utterance). After slicing, keep_silence is a short
    tail: gym/tunnel energy lingers there; a dry booth goes quiet.
    The returned first value is DRR, kept as 'c50' in logs for compatibility.
    """
    import numpy as np

    rms = _frame_rms(y, sr)
    hop_s = 0.010
    if rms.size < 8:
        return 24.0, 0.15
    peak = float(np.max(rms)) + 1e-12
    # Utterance end: last frame that is still 'direct' speech, not a decay tail.
    strong = np.where(rms >= peak * 0.40)[0]
    if strong.size < 2:
        strong = np.where(rms >= peak * 0.20)[0]
    if strong.size < 2:
        return 24.0, 0.15
    last = int(strong[-1])
    hop_frames_80 = max(1, int(0.080 / hop_s))
    hop_frames_200 = max(hop_frames_80 + 1, int(0.200 / hop_s))
    late_lo = last + hop_frames_80
    if late_lo >= rms.size - 2:
        late = float(np.mean(rms[max(0, rms.size - hop_frames_80) :])) + 1e-12
    else:
        late_hi = min(rms.size, last + hop_frames_200)
        late = float(np.mean(rms[late_lo:late_hi])) + 1e-12
    drr = 20.0 * math.log10(peak / late)

    tail = rms[last:]
    start = float(tail[0]) + 1e-12
    target = start * (10.0 ** (-15.0 / 20.0))
    below = np.where(tail <= target)[0]
    if below.size:
        t15_s = float(below[0]) * hop_s
    else:
        t15_s = float(len(tail)) * hop_s
    rt60 = max(0.12, min(3.0, t15_s * 4.0))
    return drr, rt60


def spectral_stats(y, sr: int) -> dict[str, float]:
    import numpy as np

    n_fft = 2048
    win = np.hanning(n_fft).astype(np.float64)
    hop = max(1, int(0.010 * sr))
    if y.size < n_fft:
        mag = np.abs(np.fft.rfft(np.pad(y, (0, n_fft - y.size)) * win)) ** 2
    else:
        n_fr = 1 + (y.size - n_fft) // hop
        acc = np.zeros(n_fft // 2 + 1, dtype=np.float64)
        for i in range(max(1, n_fr)):
            chunk = y[i * hop : i * hop + n_fft]
            if chunk.size < n_fft:
                chunk = np.pad(chunk, (0, n_fft - chunk.size))
            acc += np.abs(np.fft.rfft(chunk * win)) ** 2
        mag = acc / max(1, n_fr)
    mag = mag + 1e-18
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    total = float(np.sum(mag))
    high_mask = freqs >= 4000
    high_band = float(np.sum(mag[high_mask]) / total) if total > 0 else 0.0
    pos = (freqs >= 200) & (freqs <= min(8000.0, sr * 0.45))
    if int(np.count_nonzero(pos)) >= 8:
        xf = np.log2(freqs[pos])
        yf = 10.0 * np.log10(mag[pos])
        tilt = float(np.polyfit(xf, yf, 1)[0])
    else:
        tilt = 0.0
    rumble = float(np.sum(mag[freqs < 80]) / total) if total > 0 else 0.0
    box = (freqs >= 200) & (freqs <= 500)
    mid = (freqs >= 1000) & (freqs <= 4000)
    box_e = float(np.sum(mag[box]))
    mid_e = float(np.sum(mag[mid]))
    box_ratio = (box_e / mid_e) if mid_e > 1e-12 else 1.0
    box_ratio = min(box_ratio, 12.0)
    clip_ratio = float(np.mean(np.abs(y) >= 0.99)) if y.size else 0.0
    return {
        "tilt": tilt,
        "highBand": high_band,
        "rumble": rumble,
        "boxRatio": box_ratio,
        "clipRatio": clip_ratio,
    }


def estimate_snr_db(y, sr: int) -> float:
    import numpy as np

    rms = _frame_rms(y, sr)
    if rms.size < 6:
        return 40.0
    noise = float(np.percentile(rms, 15))
    speech = float(np.percentile(rms, 85))
    return 20.0 * math.log10((speech + 1e-12) / (noise + 1e-12))


def _stft(y, sr: int):
    import numpy as np
    from scipy.signal import stft

    n_fft = 1024 if sr >= 32000 else 512
    hop = n_fft // 4
    _, _, z = stft(
        y,
        fs=sr,
        window="hann",
        nperseg=n_fft,
        noverlap=n_fft - hop,
        nfft=n_fft,
        boundary="zeros",
        padded=True,
        return_onesided=True,
    )
    return np.asarray(z, dtype=np.complex128), n_fft, hop


def _istft(z, sr: int, n_fft: int, hop: int, length: int):
    from scipy.signal import istft

    _, x = istft(
        z,
        fs=sr,
        window="hann",
        nperseg=n_fft,
        noverlap=n_fft - hop,
        nfft=n_fft,
        input_onesided=True,
        boundary=True,
    )
    x = x.astype("float64", copy=False)
    if x.size < length:
        import numpy as np

        x = np.pad(x, (0, length - x.size))
    return x[:length]


def _solve_wpe_filters(r, p):
    """Solve (F,K,K) @ g = (F,K). Batched solve is version-fragile; fall back per bin."""
    import numpy as np

    f_bins, taps = int(p.shape[0]), int(p.shape[-1])
    rhs = np.reshape(p, (f_bins, taps, 1))
    try:
        return np.linalg.solve(r, rhs)[..., 0]
    except (np.linalg.LinAlgError, ValueError):
        pass
    g = np.zeros((f_bins, taps), dtype=np.complex128)
    for fi in range(f_bins):
        try:
            g[fi] = np.linalg.solve(r[fi], p[fi])
        except (np.linalg.LinAlgError, ValueError):
            continue
    return g


def wpe_stft(y_stft, taps: int = 10, delay: int = 3, iterations: int = 3):
    """Single-channel WPE (Nakatani / Yoshioka). y_stft: (F, T) complex."""
    import numpy as np

    y = np.asarray(y_stft, dtype=np.complex128)
    f_bins, n_t = y.shape
    if n_t < delay + taps + 8:
        return y
    x_tap = np.zeros((f_bins, n_t, taps), dtype=np.complex128)
    for k in range(taps):
        shift = delay + k
        x_tap[:, shift:, k] = y[:, : n_t - shift]
    z = y.copy()
    eye = np.eye(taps, dtype=np.complex128) * 1e-5
    for _ in range(max(1, iterations)):
        lam = np.maximum(np.abs(z) ** 2, 1e-10)
        kernel = np.array([0.15, 0.7, 0.15], dtype=np.float64)
        pad = np.pad(lam, ((0, 0), (1, 1)), mode="edge")
        lam = (
            kernel[0] * pad[:, 0:-2]
            + kernel[1] * pad[:, 1:-1]
            + kernel[2] * pad[:, 2:]
        )
        inv = 1.0 / np.maximum(lam, 1e-10)
        xw = x_tap * inv[:, :, None]
        r = np.einsum("ftk,ftl->fkl", np.conjugate(xw), x_tap, optimize=True)
        p = np.einsum("ftk,ft->fk", np.conjugate(xw), y, optimize=True)
        r = np.reshape(r, (f_bins, taps, taps)) + eye[None, :, :]
        p = np.reshape(p, (f_bins, taps))
        g = _solve_wpe_filters(r, p)
        pred = np.einsum("ftk,fk->ft", x_tap, g, optimize=True)
        z = y - pred
    return z


def late_reverb_suppress(y_stft, sr: int, hop: int, rt60: float, strength: float):
    """Habets / Lebart late-reverberation spectral subtraction."""
    import numpy as np
    from scipy.signal import lfilter

    y = np.asarray(y_stft, dtype=np.complex128)
    _f_bins, n_t = y.shape
    rt60 = max(0.2, min(3.0, float(rt60)))
    hop_s = hop / float(sr)
    # ~40 ms after the direct sound is treated as late reverb.
    delay = max(2, int(round(0.040 / hop_s)))
    decay = math.exp(-3.0 * math.log(10.0) * hop_s / rt60)
    power = np.abs(y) ** 2
    late = np.zeros_like(power)
    if n_t > delay:
        late[:, delay:] = power[:, : n_t - delay] * (decay**delay)
    # Causal 1-pole smoother along time (RT60 decay).
    late = lfilter([1.0 - decay], [1.0, -decay], late, axis=1)
    over = 1.35 + 0.85 * min(1.0, strength)
    floor = 10.0 ** ((-14.0 - 8.0 * strength) / 10.0)
    gain2 = 1.0 - over * late / np.maximum(power, 1e-12)
    gain2 = np.clip(gain2, floor, 1.0)
    return y * np.sqrt(gain2)


def apply_dereverb(y, sr: int, rt60: float, strength: float):
    import numpy as np

    n_fft = 1024 if sr >= 32000 else 512
    if len(y) < n_fft * 3:
        return np.asarray(y, dtype=np.float64)
    z, n_fft, hop = _stft(y, sr)
    z = wpe_stft(z, taps=10, delay=3, iterations=3)
    z = late_reverb_suppress(z, sr, hop, rt60=rt60, strength=strength)
    out = _istft(z, sr, n_fft, hop, length=len(y))
    wet = 0.55 + 0.40 * min(1.0, max(0.0, strength))
    mixed = (1.0 - wet) * y + wet * out
    return mixed.astype(np.float64, copy=False)


def fft_eq_gain(n: int, sr: int, mag_fn) -> Any:
    import numpy as np

    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    gain = np.ones_like(freqs, dtype=np.float64)
    pos = freqs >= 20.0
    gain[pos] = mag_fn(freqs[pos])
    return np.clip(gain, 10.0 ** (-12 / 20), 10.0 ** (12 / 20))


def apply_tilt_eq(y, sr: int, measured_tilt: float, box_ratio: float):
    import numpy as np

    lift = max(0.0, min(MAX_TILT_LIFT, TARGET_TILT - measured_tilt))
    n = int(y.size)
    if n < 32:
        return y
    pivot = 1000.0

    def mag(freqs):
        g = np.ones_like(freqs)
        if lift > 0.05:
            g *= 10.0 ** ((lift / 20.0) * np.log2(np.maximum(freqs, 40.0) / pivot))
        # Don't boost rumble; ease in above 120 Hz.
        fade = np.clip((freqs - 80.0) / 160.0, 0.0, 1.0)
        g = 1.0 + (g - 1.0) * fade
        # Cap hiss: flatten lift above 9 kHz.
        hi = freqs > 9000
        if np.any(hi):
            g_9k = 10.0 ** ((lift / 20.0) * np.log2(9000.0 / pivot))
            g = np.where(hi, 1.0 + (g_9k - 1.0) * fade, g)
        if box_ratio >= BOX_RATIO:
            # Gentle cut around 350 Hz (boxiness).
            cut_db = min(5.0, 1.5 + 1.8 * (box_ratio - BOX_RATIO))
            bw = 0.55  # octaves-ish
            x = np.log2(np.maximum(freqs, 40.0) / 350.0)
            notch = np.exp(-0.5 * (x / bw) ** 2)
            g *= 10.0 ** ((-cut_db * notch) / 20.0)
        return g

    gain = fft_eq_gain(n, sr, mag)
    spec = np.fft.rfft(y)
    out = np.fft.irfft(spec * gain, n=n)
    return out.astype(np.float64, copy=False)


def apply_highpass(y, sr: int, cutoff: float = 70.0):
    import numpy as np
    from scipy.signal import butter, sosfiltfilt

    nyq = 0.5 * sr
    w = min(0.45, max(8.0, cutoff) / nyq)
    sos = butter(2, w, btype="highpass", output="sos")
    try:
        return sosfiltfilt(sos, y).astype(np.float64, copy=False)
    except ValueError:
        return np.asarray(y, dtype=np.float64)


def apply_denoise(y, sr: int, snr_db: float):
    """Minimum-statistics Wiener gain. No-op when SNR is already high."""
    import numpy as np

    if snr_db >= SNR_DENOISE_DB + 6.0:
        return y
    z, n_fft, hop = _stft(y, sr)
    power = np.abs(z) ** 2
    noise = np.percentile(power, 20, axis=1, keepdims=True)
    noise = np.maximum(noise, 1e-12)
    over = 1.0 + 0.6 * min(1.0, max(0.0, (SNR_DENOISE_DB + 4.0 - snr_db) / 12.0))
    floor = 10.0 ** (-14.0 / 10.0)
    gain2 = 1.0 - over * noise / np.maximum(power, 1e-12)
    gain2 = np.clip(gain2, floor, 1.0)
    # Temporal smoothing so it doesn't twitter.
    pad = np.pad(gain2, ((0, 0), (1, 1)), mode="edge")
    gain2 = 0.25 * pad[:, 0:-2] + 0.5 * pad[:, 1:-1] + 0.25 * pad[:, 2:]
    out = _istft(z * np.sqrt(gain2), sr, n_fft, hop, length=len(y))
    wet = 0.35 + 0.50 * min(1.0, max(0.0, (SNR_DENOISE_DB + 4.0 - snr_db) / 14.0))
    return ((1.0 - wet) * y + wet * out).astype(np.float64, copy=False)


def apply_declip(y):
    import numpy as np

    x = np.asarray(y, dtype=np.float64).copy()
    thr = 0.99
    clipped = np.abs(x) >= thr
    if not np.any(clipped):
        return x
    n = x.size
    i = 0
    while i < n:
        if not clipped[i]:
            i += 1
            continue
        j = i
        while j < n and clipped[j]:
            j += 1
        left = x[i - 1] if i > 0 else np.sign(x[i]) * 0.97
        right = x[j] if j < n else np.sign(x[j - 1]) * 0.97
        span = j - i
        if span <= 0:
            i = j
            continue
        # Limit interpolation length so we don't invent long stretches.
        if span > 32:
            i = j
            continue
        t = np.linspace(0.0, 1.0, span + 2)[1:-1]
        x[i:j] = left + (right - left) * t
        i = j
    return np.clip(x, -PEAK_CEIL, PEAK_CEIL)


def match_loudness(orig, out):
    import numpy as np

    r0 = _rms(orig)
    r1 = _rms(out)
    if r1 < 1e-8:
        return orig
    scaled = out * (r0 / r1)
    peak = float(np.max(np.abs(scaled)))
    if peak > PEAK_CEIL:
        scaled *= PEAK_CEIL / peak
    return scaled


def analyze_one(y, sr: int) -> dict[str, float]:
    c50, rt60 = estimate_c50_rt60(y, sr)
    spec = spectral_stats(y, sr)
    snr = estimate_snr_db(y, sr)
    return {
        "c50": round(c50, 3),
        "rt60": round(rt60, 3),
        "tilt": round(spec["tilt"], 3),
        "highBand": round(spec["highBand"], 5),
        "rumble": round(spec["rumble"], 5),
        "boxRatio": round(spec["boxRatio"], 4),
        "clipRatio": round(spec["clipRatio"], 6),
        "snr": round(snr, 2),
    }


def decide_ops(
    stats: dict[str, float],
    *,
    batch_reverb: bool,
    batch_muffle: bool,
    do_reverb: bool,
    do_muffle: bool,
    do_enhance: bool,
) -> list[str]:
    ops: list[str] = []
    c50 = float(stats["c50"])
    rt60 = float(stats["rt60"])
    if do_reverb and (
        batch_reverb
        or c50 < DRR_SLICE_DB
        or rt60 > RT60_SLICE_S
    ):
        ops.append("wpe")
        ops.append("late")
    if do_muffle:
        hits = 0
        if float(stats["tilt"]) < TILT_SLICE:
            hits += 1
        if float(stats["highBand"]) < HIGH_BAND_SLICE:
            hits += 1
        if float(stats["boxRatio"]) >= BOX_RATIO:
            hits += 1
        if batch_muffle or hits >= 2 or float(stats["highBand"]) < 0.008:
            ops.append("tilt")
            if float(stats["boxRatio"]) >= BOX_RATIO:
                ops.append("box")
    if do_enhance:
        if float(stats["rumble"]) >= RUMBLE_RATIO:
            ops.append("hp")
        if float(stats["snr"]) < SNR_DENOISE_DB:
            ops.append("denoise")
        if float(stats["clipRatio"]) >= CLIP_RATIO:
            ops.append("declip")
    return ops


def process_signal(
    y,
    sr: int,
    stats: dict[str, float],
    ops: list[str],
):
    import numpy as np

    out = np.asarray(y, dtype=np.float64)
    if "declip" in ops:
        out = apply_declip(out)
    if "hp" in ops:
        out = apply_highpass(out, sr, 70.0)
    if "wpe" in ops or "late" in ops:
        c50 = float(stats["c50"])
        rt60 = float(stats["rt60"])
        # Stronger wetness as C50 drops / RT60 rises.
        strength = 0.0
        if c50 < DRR_BATCH_DB:
            strength = max(strength, min(1.0, (DRR_BATCH_DB - c50) / 12.0))
        if rt60 > RT60_BATCH_S:
            strength = max(strength, min(1.0, (rt60 - RT60_BATCH_S) / 1.2))
        strength = max(0.35, strength)
        out = apply_dereverb(out, sr, rt60=max(rt60, 0.45), strength=strength)
    if "tilt" in ops or "box" in ops:
        out = apply_tilt_eq(
            out,
            sr,
            measured_tilt=float(stats["tilt"]),
            box_ratio=float(stats["boxRatio"]),
        )
    if "denoise" in ops:
        out = apply_denoise(out, sr, float(stats["snr"]))
    out = match_loudness(y, out)
    return np.clip(out, -PEAK_CEIL, PEAK_CEIL)


def write_wav(path: Path, y, sr: int) -> None:
    import numpy as np
    import soundfile as sf

    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak > PEAK_CEIL:
        y = y * (PEAK_CEIL / peak)
    sf.write(str(path), y.astype(np.float32), int(sr), subtype="PCM_16")


def parse_bool(v: Any, default: bool) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    return default


def main() -> int:
    parser = argparse.ArgumentParser(description="Auto-fix sliced WAVs (WPE / EQ / denoise)")
    parser.add_argument("--sliced-dir", required=True)
    parser.add_argument("--backup-dir", required=True)
    parser.add_argument("--out-log", required=True)
    parser.add_argument("--config-json", default="")
    parser.add_argument("--reverb", default="")
    parser.add_argument("--muffle", default="")
    parser.add_argument("--enhance", default="")
    args = parser.parse_args()

    sliced_dir = Path(args.sliced_dir)
    backup_dir = Path(args.backup_dir)
    out_log = Path(args.out_log)
    if not sliced_dir.is_dir():
        print(f"ERROR: sliced dir not found: {sliced_dir}", file=sys.stderr)
        return 1

    cfg: dict[str, Any] = {}
    if args.config_json.strip():
        cfg = load_json(Path(args.config_json.strip()), {})
        if not isinstance(cfg, dict):
            cfg = {}
    af = dict(cfg.get("autoFix") or cfg.get("autofix") or {})
    do_reverb = parse_bool(args.reverb if args.reverb != "" else af.get("reverb"), True)
    do_muffle = parse_bool(args.muffle if args.muffle != "" else af.get("muffle"), True)
    do_enhance = parse_bool(
        args.enhance if args.enhance != "" else af.get("enhance"), True
    )

    wavs = list_wavs(sliced_dir)
    if not wavs:
        print("ERROR: no wav files in sliced dir", file=sys.stderr)
        return 1

    import numpy as np
    import soundfile as sf

    backup_dir.mkdir(parents=True, exist_ok=True)
    print(
        f"AUTOFIX slices={len(wavs)} reverb={int(do_reverb)} "
        f"muffle={int(do_muffle)} enhance={int(do_enhance)}",
        flush=True,
    )

    # First pass: copy backups + collect stats from originals.
    stats_by: dict[str, dict[str, float]] = {}
    n = len(wavs)
    emit_fraction(0, n, "analyze")
    for i, wav in enumerate(wavs, start=1):
        bak = backup_dir / wav.name
        if not bak.is_file():
            shutil.copy2(wav, bak)
        src = bak if bak.is_file() else wav
        y, sr = sf.read(str(src), always_2d=False)
        y = _as_mono_float(y)
        stats_by[wav.name] = analyze_one(y, int(sr))
        emit_fraction(i, n, f"analyze {wav.name}")

    c50s = [s["c50"] for s in stats_by.values()]
    rt60s = [s["rt60"] for s in stats_by.values()]
    tilts = [s["tilt"] for s in stats_by.values()]
    hbs = [s["highBand"] for s in stats_by.values()]
    median_c50 = float(sorted(c50s)[len(c50s) // 2])
    median_rt60 = float(sorted(rt60s)[len(rt60s) // 2])
    median_tilt = float(sorted(tilts)[len(tilts) // 2])
    median_hb = float(sorted(hbs)[len(hbs) // 2])
    batch_reverb = bool(
        do_reverb
        and (median_c50 < DRR_BATCH_DB or median_rt60 > RT60_BATCH_S)
    )
    batch_muffle = bool(
        do_muffle
        and (median_tilt < TILT_BATCH or median_hb < HIGH_BAND_BATCH)
    )
    print(
        f"AUTOFIX_BATCH reverb={int(batch_reverb)} muffle={int(batch_muffle)} "
        f"medianC50={median_c50:.2f} medianRT60={median_rt60:.2f} "
        f"medianTilt={median_tilt:.2f} medianHighBand={median_hb:.4f}",
        flush=True,
    )

    files: dict[str, Any] = {}
    changed = 0
    emit_fraction(0, n, "process")
    for i, wav in enumerate(wavs, start=1):
        bak = backup_dir / wav.name
        src = bak if bak.is_file() else wav
        y, sr = sf.read(str(src), always_2d=False)
        y = _as_mono_float(y)
        sr_i = int(sr)
        st = stats_by[wav.name]
        ops = decide_ops(
            st,
            batch_reverb=batch_reverb,
            batch_muffle=batch_muffle,
            do_reverb=do_reverb,
            do_muffle=do_muffle,
            do_enhance=do_enhance,
        )
        info = {**st, "ops": ops, "changed": False}
        if ops:
            try:
                out = process_signal(y, sr_i, st, ops)
                write_wav(wav, out, sr_i)
                info["changed"] = True
                changed += 1
                print(f"FIX {wav.name} ops={','.join(ops)}", flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"WARN {wav.name}: {exc}", flush=True)
                info["error"] = str(exc)
        else:
            # Restore original if a previous run had rewritten the slice.
            if bak.is_file() and bak.resolve() != wav.resolve():
                shutil.copy2(bak, wav)
            print(f"KEEP {wav.name}", flush=True)
        files[wav.name] = info
        emit_fraction(i, n, wav.name)

    log = {
        "version": VERSION,
        "backupDir": str(backup_dir.resolve()),
        "slicedDir": str(sliced_dir.resolve()),
        "batch": {
            "reverb": batch_reverb,
            "muffle": batch_muffle,
            "medianC50": round(median_c50, 3),
            "medianRt60": round(median_rt60, 3),
            "medianTilt": round(median_tilt, 3),
            "medianHighBand": round(median_hb, 5),
        },
        "flags": {
            "reverb": do_reverb,
            "muffle": do_muffle,
            "enhance": do_enhance,
        },
        "changedCount": changed,
        "total": n,
        "files": files,
    }
    save_json(out_log, log)
    print(f"DONE: autofix changed={changed}/{n} log={out_log}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
