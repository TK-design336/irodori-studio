#!/usr/bin/env python3
"""Full speaker-inversion training pipeline for Irodori Studio."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

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
}

_TQDM_PCT = re.compile(r"(?<!\d)(\d{1,3}(?:\.\d+)?)%")
_EPOCH = re.compile(r"(?i)epoch\s+(\d+)\s*/\s*(\d+)")
_STEP_FRAC = re.compile(r"(?i)(?:step|iter(?:ation)?|batch)\s+(\d+)\s*/\s*(\d+)")


def emit_progress(
    *,
    step: int,
    total: int,
    name: str,
    fraction: float,
    detail: str | None = None,
) -> None:
    payload: dict = {
        "step": step,
        "total": total,
        "name": name,
        "fraction": max(0.0, min(1.0, float(fraction))),
    }
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def mark_done(job_dir: Path, key: str) -> None:
    (job_dir / f".done_{key}").touch()


def is_done(job_dir: Path, key: str) -> bool:
    return (job_dir / f".done_{key}").is_file()


def manifest_has_rows(path: Path) -> bool:
    """True if train_manifest.jsonl exists and has at least one non-empty line."""
    if not path.is_file():
        return False
    try:
        with path.open(encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    return True
    except OSError:
        return False
    return False


def run_prepare_manifest(
    *,
    py: Path,
    studio_py: Path,
    irodori: Path,
    job_dir: Path,
    dataset_jsonl: Path,
    manifest: Path,
    latent_dir: Path,
    device: str,
    step: int,
    total: int,
) -> None:
    """Encode latents via Studio soundfile path (avoids datasets.Audio / torchcodec)."""
    print(f"STEP {step}/{total} prepare_manifest", flush=True)
    if is_done(job_dir, "prepare_manifest") and manifest_has_rows(manifest):
        print("SKIP prepare_manifest (already done)", flush=True)
        emit_progress(step=step, total=total, name="prepare_manifest", fraction=1.0)
        return
    run(
        [
            str(py),
            str(studio_py / "prepare_manifest_local.py"),
            "--data-files",
            str(dataset_jsonl),
            "--output-manifest",
            str(manifest),
            "--latent-dir",
            str(latent_dir),
            "--device",
            device,
        ],
        cwd=irodori,
        step=step,
        total=total,
        name="prepare_manifest",
    )
    if not manifest_has_rows(manifest):
        print(
            f"ERROR: prepare_manifest wrote 0 samples: {manifest}",
            file=sys.stderr,
        )
        raise SystemExit(1)
    mark_done(job_dir, "prepare_manifest")


def strip_path_quotes(raw: str) -> str:
    """Remove copy-paste wrapping quotes from a filesystem path."""
    s = raw.strip()
    if s.startswith('"'):
        s = s[1:]
        if s.endswith('"'):
            s = s[:-1]
    elif s.startswith("'"):
        s = s[1:]
        if s.endswith("'"):
            s = s[:-1]
    return s.strip()


def list_audio_files(folder: Path) -> list[Path]:
    return sorted(
        p
        for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS
    )


def _parse_child_fraction(line: str) -> tuple[float, str] | None:
    """Best-effort fraction from preprocess PROGRESS lines or train.py logs."""
    raw = line.strip()
    if raw.startswith("PROGRESS\t"):
        try:
            data = json.loads(raw.split("\t", 1)[1])
            frac = float(data.get("fraction", 0))
            detail = data.get("detail")
            if isinstance(detail, str) and detail:
                return frac, detail
            cur, tot = data.get("current"), data.get("total")
            if isinstance(cur, int) and isinstance(tot, int) and tot > 0:
                return frac, f"{cur}/{tot}"
            return frac, ""
        except (json.JSONDecodeError, TypeError, ValueError):
            return None

    m = _EPOCH.search(raw)
    if m:
        cur, tot = int(m.group(1)), int(m.group(2))
        if tot > 0:
            return cur / tot, f"epoch {cur}/{tot}"

    m = _STEP_FRAC.search(raw)
    if m:
        cur, tot = int(m.group(1)), int(m.group(2))
        if tot > 0:
            return cur / tot, f"{cur}/{tot}"

    m = _TQDM_PCT.search(raw)
    if m:
        pct = float(m.group(1))
        if 0 <= pct <= 100:
            return pct / 100.0, f"{pct:g}%"
    return None


def run(
    cmd: list[str],
    *,
    cwd: Path,
    step: int,
    total: int,
    name: str,
) -> None:
    print(f"$ {' '.join(cmd)}", flush=True)
    emit_progress(step=step, total=total, name=name, fraction=0.0)
    # New process group on POSIX; Windows uses CREATE_NEW_PROCESS_GROUP via Rust parent.
    kwargs: dict = {
        "cwd": str(cwd),
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "bufsize": 1,
    }
    if sys.platform != "win32":
        kwargs["start_new_session"] = True

    proc = subprocess.Popen(cmd, **kwargs)
    assert proc.stdout is not None
    last_frac = -1.0
    try:
        for line in proc.stdout:
            parsed = _parse_child_fraction(line)
            if parsed:
                frac, detail = parsed
                # Throttle tiny updates
                if abs(frac - last_frac) < 0.01 and frac < 0.99:
                    continue
                last_frac = frac
                emit_progress(
                    step=step,
                    total=total,
                    name=name,
                    fraction=frac,
                    detail=detail or None,
                )
                continue
            sys.stdout.write(line)
            sys.stdout.flush()
    finally:
        code = proc.wait()

    if code != 0:
        raise SystemExit(code)
    emit_progress(step=step, total=total, name=name, fraction=1.0)


def ensure_sliced_wavs(
    *,
    py: Path,
    studio_py: Path,
    irodori: Path,
    input_dir: Path,
    sliced_dir: Path,
    step: int,
    total: int,
) -> Path:
    """Accept a folder of already-sliced clips; normalize non-wav to pcm wav if needed."""
    audio_files = list_audio_files(input_dir)
    if not audio_files:
        print(
            f"ERROR: no audio files found in sliced folder: {input_dir}",
            file=sys.stderr,
        )
        raise SystemExit(1)

    all_wav = all(p.suffix.lower() == ".wav" for p in audio_files)
    if all_wav:
        print(
            f"SKIP to_wav+slice: using {len(audio_files)} pre-sliced wav(s) → {input_dir}",
            flush=True,
        )
        emit_progress(
            step=step,
            total=total,
            name="prepare sliced audio",
            fraction=1.0,
            detail=f"{len(audio_files)} wav(s)",
        )
        return input_dir

    print(
        f"NORMALIZE sliced: converting {len(audio_files)} file(s) to wav → {sliced_dir}",
        flush=True,
    )
    run(
        [
            str(py),
            str(studio_py / "preprocess_to_wav.py"),
            "--input-dir",
            str(input_dir),
            "--output-dir",
            str(sliced_dir),
        ],
        cwd=irodori,
        step=step,
        total=total,
        name="prepare sliced audio",
    )
    return sliced_dir


def materialize_sliced_for_mutate(sliced_dir: Path, job_sliced: Path) -> Path:
    """Copy into job sliced dir when source is outside the job (so we can overwrite)."""
    if sliced_dir.resolve() == job_sliced.resolve():
        return job_sliced
    job_sliced.mkdir(parents=True, exist_ok=True)
    wavs = sorted(p for p in sliced_dir.iterdir() if p.suffix.lower() == ".wav")
    print(
        f"COPY sliced → job: {len(wavs)} wav(s) → {job_sliced}",
        flush=True,
    )
    for wav in wavs:
        shutil.copy2(wav, job_sliced / wav.name)
    return job_sliced


def apply_speed_step(
    *,
    py: Path,
    studio_py: Path,
    irodori: Path,
    job_dir: Path,
    sliced_dir: Path,
    speed: float,
    step: int,
    total: int,
) -> Path:
    """If speed != 1, adjust each sliced wav in place (after materializing into job dir)."""
    job_sliced = job_dir / "sliced"
    need = abs(speed - 1.0) >= 0.001
    print(f"STEP {step}/{total} speed", flush=True)
    if not need:
        print("SKIP speed (x1.0)", flush=True)
        emit_progress(step=step, total=total, name="speed", fraction=1.0, detail="x1.0")
        mark_done(job_dir, "speed")
        return sliced_dir

    sliced_dir = materialize_sliced_for_mutate(sliced_dir, job_sliced)

    if is_done(job_dir, "speed") and sliced_dir.is_dir() and any(
        sliced_dir.glob("*.wav")
    ):
        print("SKIP speed (already done)", flush=True)
        emit_progress(step=step, total=total, name="speed", fraction=1.0)
        return sliced_dir

    run(
        [
            str(py),
            str(studio_py / "preprocess_speed.py"),
            "--sliced-dir",
            str(sliced_dir),
            "--speed",
            f"{speed:.6g}",
        ],
        cwd=irodori,
        step=step,
        total=total,
        name="speed",
    )
    mark_done(job_dir, "speed")
    return sliced_dir


def _autofix_enabled(review_config_json: str) -> bool:
    if not review_config_json.strip():
        return True
    try:
        cfg = json.loads(Path(review_config_json).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return True
    if not isinstance(cfg, dict):
        return True
    af = cfg.get("autoFix") or cfg.get("autofix") or {}
    if not isinstance(af, dict):
        return True
    return bool(af.get("enabled", True))


def apply_autofix_step(
    *,
    py: Path,
    studio_py: Path,
    irodori: Path,
    job_dir: Path,
    sliced_dir: Path,
    review_config_json: str,
    step: int,
    total: int,
) -> Path:
    """WPE / tilt EQ / light restore on sliced clips. Mutates job sliced copies."""
    print(f"STEP {step}/{total} autofix", flush=True)
    enabled = _autofix_enabled(review_config_json)
    if not enabled:
        print("SKIP autofix (disabled)", flush=True)
        emit_progress(step=step, total=total, name="autofix", fraction=1.0, detail="off")
        return sliced_dir

    job_sliced = job_dir / "sliced"
    sliced_dir = materialize_sliced_for_mutate(sliced_dir, job_sliced)

    if is_done(job_dir, "autofix") and sliced_dir.is_dir() and any(
        sliced_dir.glob("*.wav")
    ):
        print("SKIP autofix (already done)", flush=True)
        emit_progress(step=step, total=total, name="autofix", fraction=1.0)
        return sliced_dir

    backup_dir = job_dir / "sliced_pre_autofix"
    review_dir = job_dir / "slice_review"
    review_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(py),
        str(studio_py / "preprocess_autofix.py"),
        "--sliced-dir",
        str(sliced_dir),
        "--backup-dir",
        str(backup_dir),
        "--out-log",
        str(review_dir / "autofix_log.json"),
    ]
    if review_config_json.strip():
        cmd.extend(["--config-json", review_config_json.strip()])
    run(
        cmd,
        cwd=irodori,
        step=step,
        total=total,
        name="autofix",
    )
    mark_done(job_dir, "autofix")
    return sliced_dir


def apply_review_step(
    *,
    py: Path,
    studio_py: Path,
    irodori: Path,
    job_dir: Path,
    sliced_dir: Path,
    review_mode: str,
    review_config_json: str,
    review_model_cache_dir: str,
    asr_model_dir: str,
    step: int,
    total: int,
) -> bool:
    """Run slice review. Returns True if pipeline should pause (manual)."""
    print(f"STEP {step}/{total} review", flush=True)
    review_dir = job_dir / "slice_review"
    review_dir.mkdir(parents=True, exist_ok=True)
    mode = (review_mode or "manual").strip().lower()
    if mode not in ("skip", "manual", "auto"):
        mode = "manual"

    if is_done(job_dir, "review"):
        print("SKIP review (already done)", flush=True)
        emit_progress(step=step, total=total, name="review", fraction=1.0)
        return False

    if mode == "skip":
        print("SKIP review (mode=skip)", flush=True)
        # Ensure empty exclusions so dataset sees none
        excl = review_dir / "exclusions.json"
        if not excl.is_file():
            excl.write_text("{}\n", encoding="utf-8")
        log = {
            "mode": "skip",
            "excludedCount": 0,
            "byAspect": {},
        }
        (review_dir / "review_log.json").write_text(
            json.dumps(log, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        emit_progress(step=step, total=total, name="review", fraction=1.0)
        mark_done(job_dir, "review")
        return False

    cache = (
        Path(review_model_cache_dir).resolve()
        if review_model_cache_dir.strip()
        else (job_dir / "models")
    )
    cache.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(py),
        str(studio_py / "slice_review_metrics.py"),
        "--sliced-dir",
        str(sliced_dir),
        "--out-dir",
        str(review_dir),
        "--model-cache-dir",
        str(cache),
    ]
    if review_config_json.strip():
        cmd.extend(["--config-json", review_config_json.strip()])
    if asr_model_dir.strip():
        cmd.extend(["--asr-model-dir", asr_model_dir.strip()])
    if mode == "auto":
        cmd.append("--apply-auto")

    run(
        cmd,
        cwd=irodori,
        step=step,
        total=total,
        name="review",
    )

    if mode == "manual":
        ready = {
            "jobDir": str(job_dir),
            "mode": "manual",
        }
        (review_dir / "ready.json").write_text(
            json.dumps(ready, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        # stdout + stderr: Rust used to miss this line and treat exit 0 as
        # a full training success (学習開始に戻る / レビュー画面なし).
        marker = f"REVIEW_READY={job_dir}"
        print(marker, flush=True)
        print(marker, file=sys.stderr, flush=True)
        emit_progress(step=step, total=total, name="review", fraction=1.0)
        return True

    # auto
    mark_done(job_dir, "review")
    emit_progress(step=step, total=total, name="review", fraction=1.0)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Irodori Studio train pipeline")
    parser.add_argument("--irodori-root", required=True)
    parser.add_argument("--python-exe", required=True)
    parser.add_argument("--studio-python-dir", required=True)
    parser.add_argument("--input-dir", required=True)
    parser.add_argument(
        "--input-mode",
        choices=("raw", "sliced"),
        default="raw",
        help="raw: media→wav→slice; sliced: already-sliced clips folder",
    )
    parser.add_argument("--speaker-name", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument(
        "--config",
        default="configs/train_500m_v3_speaker_inversion.yaml",
    )
    parser.add_argument(
        "--outputs-root",
        default="",
        help="Where checkpoint_final.speaker.safetensors is written "
        "(defaults to {irodori-root}/outputs)",
    )
    parser.add_argument("--device", default="cuda")
    parser.add_argument(
        "--job-dir",
        default="",
        help="Reuse an existing job directory (resume after cancel)",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=1.0,
        help="Pitch-preserving playback speed for sliced clips (1.0 = no change)",
    )
    parser.add_argument(
        "--vocal-separate",
        action="store_true",
        help="Run UVR vocal separation before slice / prepare (Vocals-only WAV)",
    )
    parser.add_argument(
        "--vocal-model",
        default="model_bs_roformer_ep_317_sdr_12.9755.ckpt",
        help="audio-separator model filename",
    )
    parser.add_argument(
        "--separator-model-dir",
        default="",
        help="Directory to cache audio-separator model files",
    )
    parser.add_argument(
        "--review-mode",
        choices=("skip", "manual", "auto"),
        default="manual",
        help="Slice review after speed: skip / manual pause / auto exclude",
    )
    parser.add_argument(
        "--review-config-json",
        default="",
        help="JSON file with sliceReview aspects + thresholds",
    )
    parser.add_argument(
        "--review-model-cache-dir",
        default="",
        help="Cache dir for DNSMOS / silero-vad / WeSpeaker ONNX",
    )
    parser.add_argument(
        "--asr-model-dir",
        default="",
        help="faster-whisper model download root",
    )
    parser.add_argument(
        "--slice-method",
        choices=("silence", "silero"),
        default="silence",
        help="Raw-mode slicer: silence (pydub dBFS) or silero (Silero VAD)",
    )
    args = parser.parse_args()

    irodori = Path(args.irodori_root).resolve()
    py = Path(args.python_exe)
    studio_py = Path(args.studio_python_dir).resolve()
    speaker = args.speaker_name.strip()
    if not speaker:
        print("ERROR: speaker name is empty", file=sys.stderr)
        return 1

    speed = float(args.speed)
    if speed <= 0:
        print(f"ERROR: speed must be > 0, got {speed}", file=sys.stderr)
        return 1
    speed = max(0.5, min(2.0, speed))

    input_dir = Path(strip_path_quotes(args.input_dir)).resolve()
    slice_method = (args.slice_method or "silence").strip().lower()
    if slice_method not in ("silence", "silero"):
        slice_method = "silence"

    print(f"INPUT_DIR={input_dir}", flush=True)
    print(f"INPUT_MODE={args.input_mode}", flush=True)
    print(f"SLICE_METHOD={slice_method}", flush=True)
    print(f"SPEED={speed:.6g}", flush=True)
    print(f"TRAIN_CONFIG={args.config}", flush=True)
    if not input_dir.is_dir():
        print(
            f"ERROR: input dir not found or not a directory: {input_dir}",
            file=sys.stderr,
        )
        return 1

    if args.job_dir.strip():
        job_dir = Path(strip_path_quotes(args.job_dir)).resolve()
        job_dir.mkdir(parents=True, exist_ok=True)
        print(f"RESUME_JOB_DIR={job_dir}", flush=True)
    else:
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        job_dir = irodori / "data" / "studio_jobs" / f"{speaker}_{stamp}"
        job_dir.mkdir(parents=True, exist_ok=True)

    wav_dir = job_dir / "wav"
    vocals_dir = job_dir / "vocals"
    sliced_dir = job_dir / "sliced"
    dataset_jsonl = job_dir / "local_dataset.jsonl"
    manifest = job_dir / "train_manifest.jsonl"
    latent_dir = job_dir / "latents"
    outputs_root = (
        Path(strip_path_quotes(args.outputs_root)).resolve()
        if args.outputs_root.strip()
        else (irodori / "outputs")
    )
    output_dir = outputs_root / speaker
    vocal_separate = bool(args.vocal_separate)
    vocal_model = (args.vocal_model or "").strip() or (
        "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
    )
    separator_model_dir = (
        Path(strip_path_quotes(args.separator_model_dir)).resolve()
        if args.separator_model_dir.strip()
        else None
    )

    outputs_root.mkdir(parents=True, exist_ok=True)
    print(f"JOB_DIR={job_dir}", flush=True)
    print(f"OUTPUTS_ROOT={outputs_root}", flush=True)
    print(f"VOCAL_SEPARATE={'1' if vocal_separate else '0'}", flush=True)
    if vocal_separate:
        print(f"VOCAL_MODEL={vocal_model}", flush=True)
        if separator_model_dir is None:
            print(
                "ERROR: --separator-model-dir is required when --vocal-separate",
                file=sys.stderr,
            )
            return 1
        print(f"SEPARATOR_MODEL_DIR={separator_model_dir}", flush=True)

    def run_separate_vocals(*, step: int, total: int, name: str = "separate_vocals") -> Path:
        """Separate vocals from input_dir into job vocals/; return that dir."""
        print(f"STEP {step}/{total} {name}", flush=True)
        if is_done(job_dir, "separate_vocals") and vocals_dir.is_dir() and any(
            vocals_dir.glob("*.wav")
        ):
            print("SKIP separate_vocals (already done)", flush=True)
            emit_progress(step=step, total=total, name=name, fraction=1.0)
            return vocals_dir
        assert separator_model_dir is not None
        run(
            [
                str(py),
                str(studio_py / "preprocess_separate_vocals.py"),
                "--input-dir",
                str(input_dir),
                "--output-dir",
                str(vocals_dir),
                "--model-name",
                vocal_model,
                "--model-file-dir",
                str(separator_model_dir),
            ],
            cwd=irodori,
            step=step,
            total=total,
            name=name,
        )
        mark_done(job_dir, "separate_vocals")
        return vocals_dir

    if args.input_mode == "sliced":
        # prepare (or separate) → speed → autofix → review → dataset → prepare_manifest → train
        total = 7
        # --- 1 prepare sliced / separate ---
        if vocal_separate:
            sliced_dir = run_separate_vocals(step=1, total=total, name="separate_vocals")
        else:
            print("STEP 1/7 prepare sliced audio", flush=True)
            if is_done(job_dir, "prepare_sliced"):
                print("SKIP prepare sliced audio (already done)", flush=True)
                emit_progress(
                    step=1, total=total, name="prepare sliced audio", fraction=1.0
                )
                if sliced_dir.is_dir() and any(sliced_dir.glob("*.wav")):
                    pass
                else:
                    sliced_dir = input_dir
            else:
                sliced_dir = ensure_sliced_wavs(
                    py=py,
                    studio_py=studio_py,
                    irodori=irodori,
                    input_dir=input_dir,
                    sliced_dir=sliced_dir,
                    step=1,
                    total=total,
                )
                mark_done(job_dir, "prepare_sliced")

        # --- 2 speed ---
        sliced_dir = apply_speed_step(
            py=py,
            studio_py=studio_py,
            irodori=irodori,
            job_dir=job_dir,
            sliced_dir=sliced_dir,
            speed=speed,
            step=2,
            total=total,
        )

        # --- 3 autofix ---
        sliced_dir = apply_autofix_step(
            py=py,
            studio_py=studio_py,
            irodori=irodori,
            job_dir=job_dir,
            sliced_dir=sliced_dir,
            review_config_json=args.review_config_json,
            step=3,
            total=total,
        )

        # --- 4 review ---
        pause = apply_review_step(
            py=py,
            studio_py=studio_py,
            irodori=irodori,
            job_dir=job_dir,
            sliced_dir=sliced_dir,
            review_mode=args.review_mode,
            review_config_json=args.review_config_json,
            review_model_cache_dir=args.review_model_cache_dir,
            asr_model_dir=args.asr_model_dir,
            step=4,
            total=total,
        )
        if pause:
            return 0

        # --- 5 dataset ---
        print("STEP 5/7 dataset", flush=True)
        if is_done(job_dir, "dataset") and dataset_jsonl.is_file():
            print("SKIP dataset (already done)", flush=True)
            emit_progress(step=5, total=total, name="dataset", fraction=1.0)
        else:
            excl = job_dir / "slice_review" / "exclusions.json"
            cmd_ds = [
                str(py),
                str(studio_py / "preprocess_dataset.py"),
                "--sliced-dir",
                str(sliced_dir),
                "--output-jsonl",
                str(dataset_jsonl),
            ]
            if excl.is_file():
                cmd_ds.extend(["--exclusions-json", str(excl)])
            run(
                cmd_ds,
                cwd=irodori,
                step=5,
                total=total,
                name="dataset",
            )
            mark_done(job_dir, "dataset")

        # --- 6 prepare_manifest ---
        run_prepare_manifest(
            py=py,
            studio_py=studio_py,
            irodori=irodori,
            job_dir=job_dir,
            dataset_jsonl=dataset_jsonl,
            manifest=manifest,
            latent_dir=latent_dir,
            device=args.device,
            step=6,
            total=total,
        )

        # --- 7 train ---
        print("STEP 7/7 train", flush=True)
        run(
            [
                str(py),
                str(irodori / "train.py"),
                "--config",
                args.config,
                "--init-checkpoint",
                str(Path(args.init_checkpoint).resolve()),
                "--manifest",
                str(manifest),
                "--output-dir",
                str(output_dir),
            ],
            cwd=irodori,
            step=7,
            total=total,
            name="train",
        )
        mark_done(job_dir, "train")
    else:
        # (separate | to_wav) → slice → speed → autofix → review → dataset → prepare_manifest → train
        total = 8
        audio_files = list_audio_files(input_dir)
        all_wav = bool(audio_files) and all(
            p.suffix.lower() == ".wav" for p in audio_files
        )

        # --- 1 separate_vocals or to_wav ---
        if vocal_separate:
            wav_dir = run_separate_vocals(step=1, total=total, name="separate_vocals")
        else:
            print("STEP 1/8 to_wav", flush=True)
            if is_done(job_dir, "to_wav"):
                print("SKIP to_wav (already done)", flush=True)
                emit_progress(step=1, total=total, name="to_wav", fraction=1.0)
                if all_wav or not (wav_dir.is_dir() and any(wav_dir.glob("*.wav"))):
                    if all_wav:
                        wav_dir = input_dir
            elif all_wav:
                wav_dir = input_dir
                print(
                    f"SKIP to_wav: {len(audio_files)} file(s) already wav → using {wav_dir}",
                    flush=True,
                )
                emit_progress(
                    step=1,
                    total=total,
                    name="to_wav",
                    fraction=1.0,
                    detail=f"{len(audio_files)} wav(s)",
                )
                mark_done(job_dir, "to_wav")
            else:
                run(
                    [
                        str(py),
                        str(studio_py / "preprocess_to_wav.py"),
                        "--input-dir",
                        str(input_dir),
                        "--output-dir",
                        str(wav_dir),
                    ],
                    cwd=irodori,
                    step=1,
                    total=total,
                    name="to_wav",
                )
                mark_done(job_dir, "to_wav")

        # --- 2 slice ---
        print("STEP 2/8 slice", flush=True)
        if is_done(job_dir, "slice") and sliced_dir.is_dir() and any(
            sliced_dir.glob("*.wav")
        ):
            print("SKIP slice (already done)", flush=True)
            emit_progress(step=2, total=total, name="slice", fraction=1.0)
        else:
            run(
                [
                    str(py),
                    str(studio_py / "preprocess_slice.py"),
                    "--input-dir",
                    str(wav_dir),
                    "--output-dir",
                    str(sliced_dir),
                    "--method",
                    slice_method,
                ],
                cwd=irodori,
                step=2,
                total=total,
                name="slice",
            )
            mark_done(job_dir, "slice")

        # --- 3 speed ---
        sliced_dir = apply_speed_step(
            py=py,
            studio_py=studio_py,
            irodori=irodori,
            job_dir=job_dir,
            sliced_dir=sliced_dir,
            speed=speed,
            step=3,
            total=total,
        )

        # --- 4 autofix ---
        sliced_dir = apply_autofix_step(
            py=py,
            studio_py=studio_py,
            irodori=irodori,
            job_dir=job_dir,
            sliced_dir=sliced_dir,
            review_config_json=args.review_config_json,
            step=4,
            total=total,
        )

        # --- 5 review ---
        pause = apply_review_step(
            py=py,
            studio_py=studio_py,
            irodori=irodori,
            job_dir=job_dir,
            sliced_dir=sliced_dir,
            review_mode=args.review_mode,
            review_config_json=args.review_config_json,
            review_model_cache_dir=args.review_model_cache_dir,
            asr_model_dir=args.asr_model_dir,
            step=5,
            total=total,
        )
        if pause:
            return 0

        # --- 6 dataset ---
        print("STEP 6/8 dataset", flush=True)
        if is_done(job_dir, "dataset") and dataset_jsonl.is_file():
            print("SKIP dataset (already done)", flush=True)
            emit_progress(step=6, total=total, name="dataset", fraction=1.0)
        else:
            excl = job_dir / "slice_review" / "exclusions.json"
            cmd_ds = [
                str(py),
                str(studio_py / "preprocess_dataset.py"),
                "--sliced-dir",
                str(sliced_dir),
                "--output-jsonl",
                str(dataset_jsonl),
            ]
            if excl.is_file():
                cmd_ds.extend(["--exclusions-json", str(excl)])
            run(
                cmd_ds,
                cwd=irodori,
                step=6,
                total=total,
                name="dataset",
            )
            mark_done(job_dir, "dataset")

        # --- 7 prepare_manifest ---
        run_prepare_manifest(
            py=py,
            studio_py=studio_py,
            irodori=irodori,
            job_dir=job_dir,
            dataset_jsonl=dataset_jsonl,
            manifest=manifest,
            latent_dir=latent_dir,
            device=args.device,
            step=7,
            total=total,
        )

        # --- 8 train ---
        print("STEP 8/8 train", flush=True)
        run(
            [
                str(py),
                str(irodori / "train.py"),
                "--config",
                args.config,
                "--init-checkpoint",
                str(Path(args.init_checkpoint).resolve()),
                "--manifest",
                str(manifest),
                "--output-dir",
                str(output_dir),
            ],
            cwd=irodori,
            step=8,
            total=total,
            name="train",
        )
        mark_done(job_dir, "train")

    final_embed = output_dir / "checkpoint_final.speaker.safetensors"
    print(f"DONE: speaker={speaker}", flush=True)
    print(f"EMBED={final_embed}", flush=True)
    if final_embed.is_file():
        print(f"EMBED_OK={final_embed}", flush=True)
    else:
        print(f"WARN: expected embed not found: {final_embed}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
