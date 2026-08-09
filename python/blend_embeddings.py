#!/usr/bin/env python3
"""Linear blend of two speaker inversion embeddings."""
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Blend two speaker embeddings")
    parser.add_argument("--embed-a", required=True)
    parser.add_argument("--embed-b", required=True)
    parser.add_argument("--alpha", type=float, required=True, help="0=A, 1=B")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    alpha = float(args.alpha)
    if not (0.0 <= alpha <= 1.0):
        print("ERROR: alpha must be in [0, 1]", file=sys.stderr)
        return 1

    path_a = Path(args.embed_a)
    path_b = Path(args.embed_b)
    out = Path(args.output)

    a = load_embedding(path_a)
    b = load_embedding(path_b)
    if a.shape != b.shape:
        print(f"ERROR: shape mismatch {tuple(a.shape)} vs {tuple(b.shape)}", file=sys.stderr)
        return 1

    blended = ((1.0 - alpha) * a + alpha * b).contiguous()
    if not out.name.endswith(".speaker.safetensors"):
        print("ERROR: output must end with .speaker.safetensors", file=sys.stderr)
        return 1

    out.parent.mkdir(parents=True, exist_ok=True)
    save_file({KEY: blended}, str(out), metadata={})
    print(
        f"DONE: blended alpha={alpha:.4f} shape={tuple(blended.shape)} -> {out}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
