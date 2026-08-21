#!/usr/bin/env python3
"""Linear blend of two or three speaker inversion embeddings."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

KEY = "speaker_embedding"


def load_embedding(path: Path) -> torch.Tensor:
    if not path.name.endswith(".speaker.safetensors"):
        raise ValueError(f"Expected *.speaker.safetensors: {path}")
    raw = load_file(str(path), device="cpu")
    if KEY not in raw:
        raise ValueError(f"Missing key {KEY!r} in {path}")
    emb = raw[KEY].detach().float()
    if emb.ndim == 3 and emb.shape[0] == 1:
        emb = emb[0]
    if emb.ndim != 2:
        raise ValueError(f"Expected shape (tokens, dim), got {tuple(emb.shape)}")
    return emb.contiguous()


def _normalize_weights(wa: float, wb: float, wc: float) -> tuple[float, float, float]:
    if min(wa, wb, wc) < -1e-9:
        raise ValueError("weights must be non-negative")
    wa = max(0.0, wa)
    wb = max(0.0, wb)
    wc = max(0.0, wc)
    total = wa + wb + wc
    if total <= 1e-12:
        raise ValueError("weights must sum to a positive value")
    return wa / total, wb / total, wc / total


def main() -> int:
    parser = argparse.ArgumentParser(description="Blend two or three speaker embeddings")
    parser.add_argument("--embed-a", required=True)
    parser.add_argument("--embed-b", required=True)
    parser.add_argument("--embed-c", default="")
    parser.add_argument("--alpha", type=float, default=None, help="0=A, 1=B (2-speaker fallback)")
    parser.add_argument("--weight-a", type=float, default=None)
    parser.add_argument("--weight-b", type=float, default=None)
    parser.add_argument("--weight-c", type=float, default=None)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    path_c = (args.embed_c or "").strip()
    if args.weight_a is not None or args.weight_b is not None or args.weight_c is not None:
        if args.weight_a is None or args.weight_b is None:
            print("ERROR: --weight-a and --weight-b are required when using weights", file=sys.stderr)
            return 1
        wa, wb, wc = _normalize_weights(
            float(args.weight_a),
            float(args.weight_b),
            float(args.weight_c or 0.0),
        )
    elif args.alpha is not None:
        alpha = float(args.alpha)
        if not (0.0 <= alpha <= 1.0):
            print("ERROR: alpha must be in [0, 1]", file=sys.stderr)
            return 1
        wa, wb, wc = 1.0 - alpha, alpha, 0.0
    else:
        print("ERROR: provide --weight-a/--weight-b or --alpha", file=sys.stderr)
        return 1

    if wc > 1e-8 and not path_c:
        print("ERROR: --embed-c is required when weight C > 0", file=sys.stderr)
        return 1

    path_a = Path(args.embed_a)
    path_b = Path(args.embed_b)
    out = Path(args.output)

    try:
        embs = [load_embedding(path_a), load_embedding(path_b)]
        if path_c:
            embs.append(load_embedding(Path(path_c)))
        else:
            wc = 0.0
            wa, wb, wc = _normalize_weights(wa, wb, 0.0)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    shape0 = tuple(embs[0].shape)
    for i, emb in enumerate(embs[1:], start=1):
        if tuple(emb.shape) != shape0:
            print(f"ERROR: shape mismatch {shape0} vs {tuple(emb.shape)} (#{i + 1})", file=sys.stderr)
            return 1

    blended = (wa * embs[0] + wb * embs[1]).contiguous()
    if len(embs) == 3:
        blended = (blended + wc * embs[2]).contiguous()

    if not out.name.endswith(".speaker.safetensors"):
        print("ERROR: output must end with .speaker.safetensors", file=sys.stderr)
        return 1

    out.parent.mkdir(parents=True, exist_ok=True)
    save_file({KEY: blended}, str(out), metadata={})
    extra = f" C={wc:.4f}" if len(embs) == 3 else ""
    print(
        f"DONE: blended A={wa:.4f} B={wb:.4f}{extra} shape={tuple(blended.shape)} -> {out}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
