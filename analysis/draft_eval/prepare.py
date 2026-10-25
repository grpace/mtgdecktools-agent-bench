"""Convert the 17Lands public CSV.gz files to typed parquet (streaming; ~1 GB RAM peak)."""
from __future__ import annotations

import csv
import gzip
import shutil
import tarfile
from pathlib import Path

import polars as pl

from . import config

PREFIXES = {
    "draft": ("pack_card_", "pool_"),
    "game": ("deck_", "sideboard_", "opening_hand_", "drawn_", "tutored_"),
}


def csv_path(kind: str, set_code: str) -> Path:
    code17, fmt = config.source(set_code)
    return config.l17_dir() / f"{kind}_data_public.{code17}.{fmt}.csv.gz"


def parquet_path(kind: str, set_code: str) -> Path:
    return config.cache_dir() / f"{kind}.{set_code}.parquet"


def ensure_parquet(kind: str, set_code: str, force: bool = False) -> Path:
    out = parquet_path(kind, set_code)
    if out.exists() and not force:
        return out
    src = csv_path(kind, set_code)
    if not src.exists():
        raise FileNotFoundError(src)
    plain = None
    if _is_tar_gz(src):
        # Older 17Lands files (the January 2024 re-exports) are a gzipped tar holding the CSV: unpack it first.
        plain = src.with_name(src.name[: -len(".csv.gz")] + ".unpacked.csv")
        with tarfile.open(src, "r:gz") as tar:
            for m in tar:
                if m.isfile():
                    with tar.extractfile(m) as fin, open(plain, "wb") as fout:
                        shutil.copyfileobj(fin, fout, 1 << 20)
                    break
        src = plain
    opener = open if plain else gzip.open
    with opener(src, "rt", newline="") as fh:
        header = next(csv.reader(fh))
    count_cols = [c for c in header if c.startswith(PREFIXES[kind])]
    # Some files write counts as "0.0": read as float, cast to int8.
    lf = pl.scan_csv(src, schema_overrides={c: pl.Float32 for c in count_cols}, infer_schema_length=10000)
    lf = lf.with_columns([pl.col(c).cast(pl.Int8) for c in count_cols])
    # Older game files (2021-2022 sets, re-exported January 2024) call the player's game win-rate bucket
    # user_win_rate_bucket; newer ones user_game_win_rate_bucket. Same meaning, one name downstream.
    if kind == "game" and "user_win_rate_bucket" in header and "user_game_win_rate_bucket" not in header:
        lf = lf.rename({"user_win_rate_bucket": "user_game_win_rate_bucket"})
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp.parquet")
    try:
        lf.sink_parquet(tmp)
    finally:
        if plain is not None:
            plain.unlink(missing_ok=True)
    tmp.rename(out)
    return out


def _is_tar_gz(path: Path) -> bool:
    with gzip.open(path, "rb") as f:
        head = f.read(512)
    return len(head) == 512 and head[257:262] == b"ustar"
