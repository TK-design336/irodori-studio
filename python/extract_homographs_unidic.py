#!/usr/bin/env python3
"""Extract heteronyms (同形異音) from UniDic lex.csv.

Groups by MeCab surface (col 0), collects distinct readings, keeps entries
with 2+ readings that contain kanji.

Usage:
  python extract_homographs_unidic.py \\
    --csj path/to/unidic-csj/lex.csv \\
    --cwj path/to/unidic-cwj/lex.csv \\
    --out ../data/homographs_unidic.json
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# MeCab UniDic lex.csv: surface,left,right,cost,f[0]...
# f[6]=lForm, f[7]=lemma, f[8]=orth, f[9]=pron, f[10]=orthBase, f[11]=pronBase
# f[19]=kana (if present in newer UniDic), f[20]=kanaBase
COL_SURFACE = 0
COL_POS1 = 4
COL_POS2 = 5
COL_CFORM = 9
COL_LFORM = 10
COL_LEMMA = 11
COL_ORTH = 12
COL_PRON = 13
COL_ORTH_BASE = 14
COL_PRON_BASE = 15
COL_KANA = 25
COL_KANA_BASE = 26

KANJI_RE = re.compile(r"[\u4e00-\u9fff]")
SKIP_POS = {
    "補助記号",
    "空白",
    "記号",
}
# 固有名詞は同形異音警告ノイズになりやすいのでデフォルト除外
SKIP_POS2 = {
    "固有名詞",
}

# NDL「読みの基準」別紙5 実例寄りの種（人手キュレーションの核）
NDL_SEED = {
    "足跡",
    "明日",
    "生花",
    "石綿",
    "市場",
    "魚",
    "開眼",
    "係る",
    "気質",
    "漢書",
    "教化",
    "競売",
    "求道",
    "区分",
    "血脈",
    "現世",
    "口腔",
    "後世",
    "公文",
    "作法",
    "雑",
    "施行",
    "借家",
    "頭蓋骨",
    "日本",
    "今日",
    "風車",
    "上手",
    "下手",
    "人気",
    "生物",
    "行方",
    "一筋",
    "一日",
    "開く",
    "入る",
    "行く",
    "言う",
    "辛い",
    "早い",
    "高い",
    "長い",
    "強い",
    "空",
    "角",
    "通",
    "生",
    "行",
    "表",
    "方",
}


def norm_reading(s: str) -> str:
    s = (s or "").strip()
    if not s or s == "*":
        return ""
    # 長音のゆれをゆるく揃える（コーリ / コオリ）
    s = s.replace("ー", "")
    s = s.replace("ヴ", "ブ")
    return s


def pick_reading(row: list[str]) -> str:
    # Prefer 仮名形 (フウシャ) over 発音形 (フーシャ)
    for idx in (COL_KANA_BASE, COL_KANA, COL_LFORM, COL_PRON_BASE, COL_PRON):
        if idx < len(row):
            r = row[idx].strip()
            if r and r != "*":
                return r
    return ""


def ingest(
    path: Path,
    store: dict[str, dict[str, set[str]]],
    source: str,
    *,
    skip_proper: bool,
) -> int:
    n = 0
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        for row in reader:
            n += 1
            if len(row) <= COL_KANA_BASE:
                continue
            surface = row[COL_SURFACE]
            if not surface or not KANJI_RE.search(surface):
                continue
            pos1 = row[COL_POS1]
            if pos1 in SKIP_POS:
                continue
            if skip_proper and row[COL_POS2] in SKIP_POS2:
                continue
            reading = pick_reading(row)
            if not reading:
                continue
            bucket = store.setdefault(
                surface,
                {"readings": set(), "sources": set(), "lemmas": set()},
            )
            bucket["readings"].add(reading)
            bucket["sources"].add(source)
            lemma = row[COL_LEMMA].strip() if COL_LEMMA < len(row) else ""
            if lemma and lemma != "*":
                bucket["lemmas"].add(lemma)
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csj", type=Path, required=True)
    ap.add_argument("--cwj", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--min-readings", type=int, default=2)
    ap.add_argument(
        "--keep-proper",
        action="store_true",
        help="固有名詞を含める（デフォルトは除外）",
    )
    args = ap.parse_args()

    skip_proper = not args.keep_proper
    store: dict[str, dict[str, set[str]]] = {}
    print(f"reading CSJ: {args.csj}", flush=True)
    n_csj = ingest(args.csj, store, "csj", skip_proper=skip_proper)
    print(f"  rows={n_csj}", flush=True)
    print(f"reading CWJ: {args.cwj}", flush=True)
    n_cwj = ingest(args.cwj, store, "cwj", skip_proper=skip_proper)
    print(f"  rows={n_cwj}", flush=True)

    entries = []
    for surface, info in store.items():
        # distinct by normalized form, but keep original readings
        by_norm: dict[str, str] = {}
        for r in info["readings"]:
            n = norm_reading(r)
            if not n:
                continue
            # prefer longer original (keeps ー)
            if n not in by_norm or len(r) > len(by_norm[n]):
                by_norm[n] = r
        readings = sorted(by_norm.values())
        if len(readings) < args.min_readings:
            continue
        entries.append(
            {
                "surface": surface,
                "readings": readings,
                "sources": sorted(info["sources"]),
                "lemmas": sorted(info["lemmas"])[:12],
                "ndlSeed": surface in NDL_SEED,
            }
        )

    entries.sort(key=lambda e: (not e["ndlSeed"], e["surface"]))
    seed_hits = sum(1 for e in entries if e["ndlSeed"])
    payload = {
        "version": 1,
        "source": {
            "dictionaries": ["unidic-csj", "unidic-cwj"],
            "note": "UniDic lex.csv surfaces with 2+ distinct readings; NDL seed flagged",
        },
        "stats": {
            "totalHeteronyms": len(entries),
            "ndlSeedHits": seed_hits,
            "csjRows": n_csj,
            "cwjRows": n_cwj,
        },
        "entries": entries,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"wrote {args.out}  heteronyms={len(entries)}  ndlSeedHits={seed_hits}",
        flush=True,
    )

    # preview NDL seed matches
    preview = [e for e in entries if e["ndlSeed"]][:15]
    for e in preview:
        print(f"  {e['surface']}: {' / '.join(e['readings'])}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
