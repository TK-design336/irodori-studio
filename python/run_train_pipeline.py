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
    print(f"INPUT_DIR={input_dir}", flush=True)
    print(f"INPUT_MODE={args.input_mode}", flush=True)
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

    outputs_root.mkdir(parents=True, exist_ok=True)
    print(f"JOB_DIR={job_dir}", flush=True)
    print(f"OUTPUTS_ROOT={outputs_root}", flush=True)

    if args.input_mode == "sliced":
        # prepare → speed → dataset → prepare_manifest → train
        total = 5
        # --- 1 prepare sliced ---
        print("STEP 1/5 prepare sliced audio", flush=True)
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

        # --- 3 dataset ---
        print("STEP 3/5 dataset", flush=True)
        if is_done(job_dir, "dataset") and dataset_jsonl.is_file():
            print("SKIP dataset (already done)", flush=True)
            emit_progress(step=3, total=total, name="dataset", fraction=1.0)
        else:
            run(
                [
                    str(py),
                    str(studio_py / "preprocess_dataset.py"),
                    "--sliced-dir",
                    str(sliced_dir),
                    "--output-jsonl",
                    str(dataset_jsonl),
                ],
                cwd=irodori,
                step=3,
                total=total,
                name="dataset",
            )
            mark_done(job_dir, "dataset")

        # --- 4 prepare_manifest ---
        print("STEP 4/5 prepare_manifest", flush=True)
        if is_done(job_dir, "prepare_manifest") and manifest.is_file():
            print("SKIP prepare_manifest (already done)", flush=True)
            emit_progress(
                step=4, total=total, name="prepare_manifest", fraction=1.0
            )
        else:
            run(
                [
                    str(py),
                    str(irodori / "prepare_manifest.py"),
                    "--dataset",
                    "json",
                    "--data-files",
                    str(dataset_jsonl),
                    "--audio-column",
                    "audio",
                    "--text-column",
                    "text",
                    "--output-manifest",
                    str(manifest),
                    "--latent-dir",
                    str(latent_dir),
                    "--device",
                    args.device,
                ],
                cwd=irodori,
                step=4,
                total=total,
                name="prepare_manifest",
            )
            mark_done(job_dir, "prepare_manifest")

        # --- 5 train ---
        print("STEP 5/5 train", flush=True)
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
            step=5,
            total=total,
            name="train",
        )
        mark_done(job_dir, "train")
    else:
        # to_wav → slice → speed → dataset → prepare_manifest → train
        total = 6
        audio_files = list_audio_files(input_dir)
        all_wav = bool(audio_files) and all(
            p.suffix.lower() == ".wav" for p in audio_files
        )

        # --- 1 to_wav ---
        print("STEP 1/6 to_wav", flush=True)
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
        print("STEP 2/6 slice", flush=True)
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

        # --- 4 dataset ---
        print("STEP 4/6 dataset", flush=True)
        if is_done(job_dir, "dataset") and dataset_jsonl.is_file():
            print("SKIP dataset (already done)", flush=True)
            emit_progress(step=4, total=total, name="dataset", fraction=1.0)
        else:
            run(
                [
                    str(py),
                    str(studio_py / "preprocess_dataset.py"),
                    "--sliced-dir",
                    str(sliced_dir),
                    "--output-jsonl",
                    str(dataset_jsonl),
                ],
                cwd=irodori,
                step=4,
                total=total,
                name="dataset",
            )
            mark_done(job_dir, "dataset")

        # --- 5 prepare_manifest ---
        print("STEP 5/6 prepare_manifest", flush=True)
        if is_done(job_dir, "prepare_manifest") and manifest.is_file():
            print("SKIP prepare_manifest (already done)", flush=True)
            emit_progress(
                step=5, total=total, name="prepare_manifest", fraction=1.0
            )
        else:
            run(
                [
                    str(py),
                    str(irodori / "prepare_manifest.py"),
                    "--dataset",
                    "json",
                    "--data-files",
                    str(dataset_jsonl),
                    "--audio-column",
                    "audio",
                    "--text-column",
                    "text",
                    "--output-manifest",
                    str(manifest),
                    "--latent-dir",
                    str(latent_dir),
                    "--device",
                    args.device,
                ],
                cwd=irodori,
                step=5,
                total=total,
                name="prepare_manifest",
            )
            mark_done(job_dir, "prepare_manifest")

        # --- 6 train ---
        print("STEP 6/6 train", flush=True)
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
            step=6,
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
