#!/usr/bin/env python3
"""Build per-set card rating files from the 17Lands PUBLIC datasets.

Usage (stdlib only, run isolated):
    python3 -I scripts/build-17lands-ratings.py FRA TLA EOE ECL MSH
    python3 -I scripts/build-17lands-ratings.py --all
    python3 -I scripts/build-17lands-ratings.py FRA --max-game-rows 500000
Most people run it through `npm run deps -- update 17lands --set FRA`, which also rebuilds the
archetype ratings, the expert pick model and the deck norms, and records the snapshot in
deps/manifest.json (docs/UPGRADING.md).

Set codes are phase-rs codes (the sets/<SET>/ directory names). The 17Lands code is the same
upper-cased code unless deps/set-codes.json maps it ("17lands".codes). The format is PremierDraft,
or TradDraft when a set has no PremierDraft file at all (--format forces one).

Inputs (downloaded to data/17lands/, which is gitignored):
    https://17lands-public.s3.amazonaws.com/analysis_data/game_data/game_data_public.{CODE17}.{FORMAT}.csv.gz
    https://17lands-public.s3.amazonaws.com/analysis_data/draft_data/draft_data_public.{CODE17}.{FORMAT}.csv.gz
Only these documented public-dataset files are used. Nothing from the
17lands.com website API is touched. Downloads are sequential, retried with
backoff, and send a User-Agent naming this project.

Outputs, per set:
    sets/<SET>/17lands.json  (also records the source files' ETag / Last-Modified / size,
                              the date range of the games, and a snapshot id)
    sets/<SET>/ratings.tsv   (name, gih_wr, ata; sorted by gih_wr desc)
A set with fewer than --min-games game rows (default 20,000) gets no outputs: too few cards
would reach the per-card threshold. The exit summary says so.

Metric definitions (see also sets/README.md)
--------------------------------------------
Game data (one row per game, one side):
    in_hand  = opening_hand_<Card> > 0  OR  drawn_<Card> > 0   (tutored_ ignored)
    GIH WR   = win rate of games where the card was in hand at any point
    OH WR    = win rate of games where the card was in the opening hand
    GP WR    = win rate of games where the card was in the main deck (deck_ > 0)
    GNS WR   = win rate of games where the card was in the deck but never seen
               (in the deck, not in the opening hand, not drawn)
    IWD      = GIH WR - GNS WR   (percentage-point difference, as a fraction)
    baseline = overall win rate across all rows processed
    Rates are null when the card has fewer than --min-gih (default 200)
    games-in-hand; for OH / GP / GNS a rate is null when its own game count is
    below the same threshold.

Draft data (one row per pick):
    pack_number and pick_number are 0-based in the files. We report picks as
    1-based position WITHIN a pack (1..14 or 15), the same convention the
    17Lands card-data pages use, so ATA ~ 3.2 means "usually taken 3rd".
        in_pack_pick = pick_number + 1
    (The overall pick index would be pack_number * picks_per_pack +
    pick_number + 1, 1..42/45. It is not reported because averaging it mixes
    pack rounds. The code keeps the in-pack value only.)
    ATA  = mean in_pack_pick of the pick (the `pick` column) over all picks
           of that card ("picked" = number of such picks).
    ALSA = mean in_pack_pick at which the card was LAST SEEN by the drafter
           in a pack. Pods are 8 drafters, so a pack seen at in-pack pick k
           (k < 8) returns to the same drafter at k + 8 if it has that many
           cards. For a card with c_k copies in the pack at pick k and
           c_{k+8} copies in the same pack at pick k+8, (c_k - c_{k+8})
           copies were last seen at k and c_{k+8} at k + 8. If the pack never
           returns, all c_k copies were last seen at k. Picks k >= 8 are
           always the last view.
           Rows of one draft_id are assumed contiguous in the file (true for
           the current files); a draft_id that is split would only lose some
           wheel information.

Sampling: at most --max-game-rows game rows / --max-draft-rows draft rows are
read (defaults 2,000,000 / 3,000,000; the first rows of the file, draft
sampling stops at a draft boundary). When a cap is hit the JSON records
"sampled": true with the counts. Memory use is O(number of cards).
"""

import argparse
import csv
import datetime
import email.utils
import gzip
import io
import json
import operator
import os
import sys
import tarfile
import time
import urllib.error
import urllib.request

BASE = "https://17lands-public.s3.amazonaws.com/analysis_data"
GENERATOR = "scripts/build-17lands-ratings.py v2"
USER_AGENT = "mtgdecktools-agent-bench/0.1 (17Lands public datasets; sequential downloads)"
FORMATS = ["PremierDraft", "TradDraft"]
MIN_GAMES = 20_000
SOURCE = "17Lands public datasets (https://www.17lands.com/public_datasets)"
LICENSE_NOTE = (
    "Data from 17Lands (17lands.com). The 17Lands public datasets page states that, "
    "unless otherwise noted, the datasets are licensed under Creative Commons Attribution 4.0 "
    "International (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). This file contains "
    "per-card aggregates derived by this project from those datasets; it is a modified/derived "
    "work, not a 17Lands product, and its use does not imply endorsement by 17Lands. "
    "Credit 17Lands when you reuse it."
)
POD = 8
CSV_FIELD_LIMIT = 1 << 24


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def url_for(kind, code17, fmt):
    return f"{BASE}/{kind}/{kind}_public.{code17}.{fmt}.csv.gz"


def load_codes(root):
    path = os.path.join(root, "deps", "set-codes.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("17lands", {})
    except FileNotFoundError:
        return {}


def code17_for(root, set_code):
    """17Lands code for a phase-rs set code: (code, None), or (None, reason) when the set is unmapped."""
    entry = load_codes(root).get("codes", {}).get(set_code.upper())
    if entry is None:
        return set_code.upper(), None
    if entry.get("17lands") is None:
        return None, entry.get("reason", "no 17Lands code (deps/set-codes.json)")
    return entry["17lands"], None


def default_sets(root):
    """Every set with a 17Lands snapshot in deps/manifest.json (the --all list)."""
    try:
        with open(os.path.join(root, "deps", "manifest.json"), encoding="utf-8") as f:
            return sorted(json.load(f)["17lands"]["sets"])
    except (FileNotFoundError, KeyError):
        return sorted(d for d in os.listdir(os.path.join(root, "sets"))
                      if os.path.exists(os.path.join(root, "sets", d, "17lands.json")))


def request(url, method="GET", tries=5):
    """urlopen with retries and exponential backoff. 403/404 (no such file) are returned, not retried."""
    delay = 5
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT})
        try:
            return urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return e
            err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
        if attempt == tries:
            raise RuntimeError(f"{method} {url} failed after {tries} attempts: {err!r}")
        log(f"  retry {attempt}/{tries - 1} in {delay}s after {err!r}")
        time.sleep(delay)
        delay = min(delay * 3, 300)


def head(url):
    """Remote file info {url, etag, last_modified, bytes}, or None when it doesn't exist (S3 answers 403)."""
    r = request(url, "HEAD")
    with r:
        if getattr(r, "status", None) != 200:
            return None
        return {
            "url": url,
            "etag": (r.headers.get("ETag") or "").strip('"'),
            "last_modified": r.headers.get("Last-Modified"),
            "bytes": int(r.headers.get("Content-Length", "-1")),
        }


def pick_format(code17, forced=None):
    """(format, {kind: head-info or None}): PremierDraft, else TradDraft when it has no PremierDraft file."""
    for fmt in ([forced] if forced else FORMATS):
        info = {kind: head(url_for(kind, code17, fmt)) for kind in ("game_data", "draft_data")}
        if any(info.values()):
            return fmt, info
    return None, {}


def download(info, dest):
    """Download a file described by head() to dest (skip if already complete). Returns bytes fetched."""
    size = info["bytes"]
    if os.path.exists(dest) and os.path.getsize(dest) == size:
        log(f"  have {os.path.basename(dest)} ({size / 1e6:.1f} MB)")
        return 0
    log(f"  downloading {os.path.basename(dest)} ({size / 1e6:.1f} MB)")
    tmp = dest + ".part"
    for attempt in range(1, 4):
        r = request(info["url"])
        with r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        if os.path.getsize(tmp) == size:
            os.replace(tmp, dest)
            return size
        log(f"  short download ({os.path.getsize(tmp)} of {size} bytes), attempt {attempt}/3")
        time.sleep(10 * attempt)
    os.remove(tmp)
    raise RuntimeError(f"short download for {info['url']}")


def is_tar_gz(path):
    """Some older 17Lands files (the January 2024 re-exports) are a gzipped tar holding the CSV, not a gzipped CSV."""
    with gzip.open(path, "rb") as f:
        head = f.read(512)
    return len(head) == 512 and head[257:262] == b"ustar"


def open_csv(path):
    if is_tar_gz(path):
        tar = tarfile.open(path, "r:gz")
        member = next(m for m in tar if m.isfile())
        raw = tar.extractfile(member)
    else:
        raw = gzip.open(path, "rb")
    return csv.reader(io.TextIOWrapper(raw, encoding="utf-8", newline=""))


def nonzero(values):
    return [i for i, v in enumerate(values) if v != "0" and v != "" and v != "0.0"]


def process_games(path, max_rows, stats):
    """Stream game data. Returns dict card -> list of counters."""
    rd = open_csv(path)
    header = next(rd)
    col = {name: i for i, name in enumerate(header)}
    won_i = col["won"]
    time_i = col.get("game_time", col.get("draft_time"))
    first = last = None
    names = [h[len("deck_"):] for h in header if h.startswith("deck_")]
    n = len(names)
    oh_idx = [col["opening_hand_" + c] for c in names]
    dr_idx = [col["drawn_" + c] for c in names]
    dk_idx = [col["deck_" + c] for c in names]
    # fast slicing when the three columns are interleaved with a fixed stride
    stride_ok = (
        all(oh_idx[i] == oh_idx[0] + 5 * i for i in range(n))
        and all(dr_idx[i] == dr_idx[0] + 5 * i for i in range(n))
        and all(dk_idx[i] == dk_idx[0] + 5 * i for i in range(n))
    )
    # counters per card: [gih_g, gih_w, oh_g, oh_w, gp_g, gp_w, gns_g, gns_w]
    cnt = [[0] * 8 for _ in range(n)]
    games = wins = 0
    truthy = {"True", "true", "1", "TRUE"}
    for row in rd:
        if games >= max_rows:
            stats["game_truncated"] = True
            break
        if len(row) != len(header):
            stats["bad_game_rows"] = stats.get("bad_game_rows", 0) + 1
            continue
        w = 1 if row[won_i] in truthy else 0
        games += 1
        wins += w
        if time_i is not None:
            ts = row[time_i]
            if ts:
                if first is None or ts < first:
                    first = ts
                if last is None or ts > last:
                    last = ts
        if stride_ok:
            dk = row[dk_idx[0]::5][:n]
            oh = row[oh_idx[0]::5][:n]
            dr = row[dr_idx[0]::5][:n]
            idxs = nonzero(dk)
            for i in idxs:
                c = cnt[i]
                c[4] += 1
                c[5] += w
                o = oh[i] != "0"
                d = dr[i] != "0"
                if o:
                    c[2] += 1
                    c[3] += w
                if o or d:
                    c[0] += 1
                    c[1] += w
                else:
                    c[6] += 1
                    c[7] += w
        else:
            for i in range(n):
                if row[dk_idx[i]] == "0":
                    continue
                c = cnt[i]
                c[4] += 1
                c[5] += w
                o = row[oh_idx[i]] != "0"
                d = row[dr_idx[i]] != "0"
                if o:
                    c[2] += 1
                    c[3] += w
                if o or d:
                    c[0] += 1
                    c[1] += w
                else:
                    c[6] += 1
                    c[7] += w
        if games % 250000 == 0:
            log(f"    {games:,} game rows")
    stats["game_rows"] = games
    stats["wins"] = wins
    stats["first"], stats["last"] = first, last
    return dict(zip(names, cnt))


def process_drafts(path, max_rows, stats):
    """Stream draft data. Returns dict card -> [picked, pick_sum, seen, last_seen_sum]."""
    rd = open_csv(path)
    header = next(rd)
    col = {name: i for i, name in enumerate(header)}
    pc_idx = [i for i, h in enumerate(header) if h.startswith("pack_card_")]
    names = [header[i][len("pack_card_"):] for i in pc_idx]
    # Columns are usually one contiguous block, but some files (e.g. EOE) have a
    # stray pack_card_ column elsewhere, so gather by index.
    get_pack = operator.itemgetter(*pc_idx)
    name_to_i = {nm: i for i, nm in enumerate(names)}
    n = len(names)
    did_i, pack_i, pick_i, pk_i = col["draft_id"], col["pack_number"], col["pick_number"], col["pick"]
    time_i = col.get("draft_time")
    first = last = None
    picked = [0] * n
    pick_sum = [0] * n
    seen = [0] * n
    ls_sum = [0] * n
    unknown_picks = 0
    rows = drafts = 0

    def flush(buf):
        """buf: list of (pack, pick_number, {card_idx: count}) for one draft."""
        by_pack = {}
        for pack, pk, d in buf:
            by_pack.setdefault(pack, {})[pk] = d
        for picks in by_pack.values():
            for k, d in picks.items():
                nxt = picks.get(k + POD) if k < POD else None
                for ci, c in d.items():
                    if nxt is not None:
                        # copies that wheel are counted when pick k + POD is
                        # processed (it is always the last view)
                        left = c - min(c, nxt.get(ci, 0))
                    else:
                        left = c
                    if left:
                        ls_sum[ci] += left * (k + 1)
                        seen[ci] += left

    buf = []
    cur = None
    for row in rd:
        if len(row) != len(header):
            stats["bad_draft_rows"] = stats.get("bad_draft_rows", 0) + 1
            continue
        did = row[did_i]
        if did != cur:
            if buf:
                flush(buf)
                drafts += 1
                buf = []
            if rows >= max_rows:
                stats["draft_truncated"] = True
                cur = None
                break
            cur = did
            if time_i is not None and row[time_i]:
                ts = row[time_i]
                if first is None or ts < first:
                    first = ts
                if last is None or ts > last:
                    last = ts
        rows += 1
        pk = int(row[pick_i])
        pack = int(row[pack_i])
        sl = get_pack(row)
        d = {i: int(sl[i]) for i in nonzero(sl)}
        buf.append((pack, pk, d))
        ci = name_to_i.get(row[pk_i])
        if ci is None:
            unknown_picks += 1
        else:
            picked[ci] += 1
            pick_sum[ci] += pk + 1
        if rows % 500000 == 0:
            log(f"    {rows:,} draft rows")
    if buf and cur is not None:
        flush(buf)
        drafts += 1
    stats["draft_rows"] = rows
    stats["drafts"] = drafts
    stats["unknown_picks"] = unknown_picks
    stats["first"], stats["last"] = first, last
    return {nm: [picked[i], pick_sum[i], seen[i], ls_sum[i]] for i, nm in enumerate(names)}


def r4(x):
    return None if x is None else round(x, 4)


def build_cards(game, draft, min_gih, min_pick):
    cards = {}
    for nm in sorted(set(game) | set(draft)):
        g = game.get(nm, [0] * 8)
        d = draft.get(nm, [0, 0, 0, 0])

        def rate(games, wins, minimum=min_gih):
            return wins / games if games >= minimum else None

        gih = rate(g[0], g[1])
        gns = rate(g[6], g[7])
        entry = {
            "gih_wr": r4(gih),
            "gp_wr": r4(rate(g[4], g[5])),
            "oh_wr": r4(rate(g[2], g[3])),
            "gns_wr": r4(gns),
            "iwd": r4(gih - gns) if gih is not None and gns is not None else None,
            "gih_games": g[0],
            "oh_games": g[2],
            "gp_games": g[4],
            "gns_games": g[6],
            "alsa": r4(d[3] / d[2]) if d[2] >= min_pick else None,
            "ata": r4(d[1] / d[0]) if d[0] >= min_pick else None,
            "picked": d[0],
            "seen": d[2],
        }
        if g[0] == 0 and g[4] == 0 and d[0] == 0 and d[2] == 0:
            continue
        cards[nm] = entry
    return cards


def snapshot_id(code17, fmt, files):
    """Human-readable snapshot id: <17Lands code>.<format>@<newest Last-Modified of the source files, UTC>."""
    stamps = []
    for f in files.values():
        if f and f.get("last_modified"):
            stamps.append(email.utils.parsedate_to_datetime(f["last_modified"]).astimezone(datetime.timezone.utc))
    when = max(stamps).strftime("%Y-%m-%dT%H:%M:%SZ") if stamps else "unknown"
    return f"{code17}.{fmt}@{when}"


def write_outputs(root, set_code, fmt, game_stats, draft_stats, cards, args, files, code17):
    out_dir = os.path.join(root, "sets", set_code)
    os.makedirs(out_dir, exist_ok=True)
    games = game_stats.get("game_rows", 0)
    baseline = game_stats["wins"] / games if games else None
    sampled = bool(game_stats.get("game_truncated") or draft_stats.get("draft_truncated"))
    have_game, have_draft = bool(files.get("game_data")), bool(files.get("draft_data"))
    firsts = [x for x in (game_stats.get("first"), draft_stats.get("first")) if x]
    lasts = [x for x in (game_stats.get("last"), draft_stats.get("last")) if x]
    doc = {
        "set": set_code,
        "source_code": code17,
        "format": fmt,
        "snapshot": snapshot_id(code17, fmt, files),
        "generator": GENERATOR,
        "source": SOURCE,
        "license_note": LICENSE_NOTE,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "games": games,
        "baseline_win_rate": r4(baseline),
        "drafts": draft_stats.get("drafts", 0),
        "draft_picks": draft_stats.get("draft_rows", 0),
        "sampled": sampled,
        "sampling": {
            "games_truncated": bool(game_stats.get("game_truncated")),
            "drafts_truncated": bool(draft_stats.get("draft_truncated")),
            "max_game_rows": args.max_game_rows,
            "max_draft_rows": args.max_draft_rows,
            "note": "when truncated, only the first rows of each file were used",
        },
        "thresholds": {"min_gih_games_for_rates": args.min_gih, "min_samples_for_alsa_ata": args.min_pick},
        "pick_numbering": "1-based position within a pack (1..14 or 15)",
        "has_game_data": have_game,
        "has_draft_data": have_draft,
        "date_range": {"first": min(firsts) if firsts else None, "last": max(lasts) if lasts else None,
                       "note": "earliest and latest draft_time/game_time in the rows read (UTC, as 17Lands writes them)"},
        "source_files": {k: ({**v, "rows": (game_stats.get("game_rows") if k == "game_data" else draft_stats.get("draft_rows"))} if v else None)
                         for k, v in files.items()},
        "rated_cards": sum(1 for c in cards.values() if c["gih_wr"] is not None),
        "cards": cards,
    }
    with open(os.path.join(out_dir, "17lands.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    ordered = sorted(
        cards.items(),
        key=lambda kv: (kv[1]["gih_wr"] is None, -(kv[1]["gih_wr"] or 0), kv[0]),
    )
    with open(os.path.join(out_dir, "ratings.tsv"), "w", encoding="utf-8") as f:
        f.write("name\tgih_wr\tata\n")
        for nm, c in ordered:
            wr = "" if c["gih_wr"] is None else f"{c['gih_wr'] * 100:.2f}"
            ata = "" if c["ata"] is None else f"{c['ata']:.2f}"
            f.write(f"{nm}\t{wr}\t{ata}\n")
    return doc


def run_set(root, set_code, args):
    """Build one set. Returns (status, doc-or-reason): status is "ok", "unavailable", "unmapped" or "thin"."""
    code17, why = code17_for(root, set_code)
    if code17 is None:
        log(f"[{set_code}] {why}")
        return "unmapped", why
    data_dir = os.path.join(root, "data", "17lands")
    os.makedirs(data_dir, exist_ok=True)
    t0 = time.time()
    fmt, files = pick_format(code17, args.format)
    if not fmt:
        log(f"[{set_code}] no public 17Lands file for {code17} ({' or '.join([args.format] if args.format else FORMATS)}); skipping")
        return "unavailable", f"no public {code17} file"
    paths = {}
    fetched = 0
    for kind, info in files.items():
        if info:
            dest = os.path.join(data_dir, f"{kind}_public.{code17}.{fmt}.csv.gz")
            fetched += download(info, dest)
            paths[kind] = dest
        else:
            paths[kind] = None
    gstats, dstats = {}, {}
    game, draft = {}, {}
    if paths["game_data"]:
        log(f"[{set_code}] processing game data ({code17} {fmt})")
        game = process_games(paths["game_data"], args.max_game_rows, gstats)
    else:
        gstats = {"game_rows": 0, "wins": 0}
    if gstats["game_rows"] < args.min_games:
        log(f"[{set_code}] only {gstats['game_rows']:,} game rows (< {args.min_games:,}); no outputs written")
        return "thin", f"{gstats['game_rows']} game rows < {args.min_games}"
    if paths["draft_data"]:
        log(f"[{set_code}] processing draft data")
        draft = process_drafts(paths["draft_data"], args.max_draft_rows, dstats)
    cards = build_cards(game, draft, args.min_gih, args.min_pick)
    doc = write_outputs(root, set_code, fmt, gstats, dstats, cards, args, files, code17)
    doc["_downloaded_bytes"] = fetched
    log(
        f"[{set_code}] done in {time.time() - t0:.0f}s: games={doc['games']:,} "
        f"picks={doc['draft_picks']:,} drafts={doc['drafts']:,} cards={len(cards)} rated={doc['rated_cards']} "
        f"baseline={doc['baseline_win_rate']} sampled={doc['sampled']} snapshot={doc['snapshot']}"
    )
    return "ok", doc


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sets", nargs="*", help="phase-rs set codes, e.g. FRA TLA")
    ap.add_argument("--all", action="store_true", help="every set with a snapshot in deps/manifest.json")
    ap.add_argument("--format", default=None, help="force an event format (default: PremierDraft, else TradDraft)")
    ap.add_argument("--max-game-rows", type=int, default=2_000_000)
    ap.add_argument("--max-draft-rows", type=int, default=3_000_000)
    ap.add_argument("--min-gih", type=int, default=200, help="min games-in-hand for win-rate stats")
    ap.add_argument("--min-pick", type=int, default=30, help="min samples for ALSA/ATA")
    ap.add_argument("--min-games", type=int, default=MIN_GAMES, help="min game rows for a set to get outputs")
    ap.add_argument("--status-json", help="write {set: {status, ...}} here (used by scripts/deps.py)")
    args = ap.parse_args()
    csv.field_size_limit(CSV_FIELD_LIMIT)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sets = [s.upper() for s in (default_sets(root) if args.all or not args.sets else args.sets)]
    ok, other = [], []
    status = {}
    for s in sets:
        try:
            st, res = run_set(root, s, args)
        except Exception as e:  # keep going with other sets
            log(f"[{s}] FAILED: {e!r}")
            st, res = "failed", repr(e)
        if st == "ok":
            ok.append(s)
            status[s] = {"status": st, "snapshot": res["snapshot"], "downloaded_bytes": res["_downloaded_bytes"]}
        else:
            other.append(f"{s} ({st})")
            status[s] = {"status": st, "reason": res}
    if args.status_json:
        with open(args.status_json, "w", encoding="utf-8") as f:
            json.dump(status, f, indent=1)
    log(f"succeeded: {' '.join(ok) or '-'}; not built: {', '.join(other) or '-'}")
    return 0 if ok or not sets else 1


if __name__ == "__main__":
    sys.exit(main())
