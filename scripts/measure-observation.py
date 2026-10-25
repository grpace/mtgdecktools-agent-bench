"""Token cost of the observation formats (prompt v3 vs v4) on the same decisions.

Run events with MTGDT_OBS_COMPARE=<file.jsonl> (the Director then renders every draft pick, deckbuilding and game
decision in both formats, plus two v4 card-table variants), then:

    uv run --no-project --with tiktoken python -I scripts/measure-observation.py tmp/obs/cmp-*.jsonl

Reports chars/4 and, when tiktoken is installed, o200k_base BPE tokens (a proxy: Claude's tokenizer is not public;
JSON usually costs more tokens per character than prose, which chars/4 misses). Per decision (mean, p50, p95) and
per game seat (the sum over one seat's decisions in one game).
"""
import json
import statistics
import sys
from collections import defaultdict

try:
    import tiktoken

    ENC = tiktoken.get_encoding("o200k_base")
except Exception:  # noqa: BLE001 - optional dependency
    ENC = None

VARIANTS = [("v3", "earlier text format (cards once per game)"), ("v4", "current format"), ("v4_json", "structured JSON (when the text layout was current)"), ("v4_text", "text layout around the JSON state"), ("v4_new", "card table only for new cards"), ("v4_inline", "printed data inline per object")]


def tokens(text: str) -> tuple[float, float | None]:
    return len(text) / 4, (len(ENC.encode(text)) if ENC else None)


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))]


def row(label: str, xs: list[float]) -> str:
    return f"| {label} | {len(xs)} | {statistics.mean(xs):,.0f} | {pct(xs, 0.5):,.0f} | {pct(xs, 0.95):,.0f} | {max(xs):,.0f} |"


def main() -> None:
    rows = [dict(json.loads(line), _file=path) for path in sys.argv[1:] for line in open(path, encoding="utf8")]
    games = [r for r in rows if "game" in r]
    picks = [r for r in rows if r.get("kind") == "draft_pick"]
    builds = [r for r in rows if r.get("kind") == "deck_build"]
    print(f"{len(sys.argv) - 1} file(s): {len(games)} game decisions, {len(picks)} draft picks, {len(builds)} deckbuilding decisions")
    print(f"Tokenizer: chars/4{' and o200k_base (tiktoken)' if ENC else ' only (install tiktoken for a BPE count)'}\n")
    header = "| format | n | mean | p50 | p95 | max |\n|---|---|---|---|---|---|"

    def section(title: str, items: list[dict], variants, group=None) -> None:
        for unit, idx in (("chars/4", 0), ("o200k", 1)):
            if idx == 1 and not ENC:
                continue
            print(f"### {title}: tokens per decision ({unit})\n\n{header}")
            for key, label in variants:
                xs = [tokens(r[key])[idx] for r in items if key in r]
                if xs:
                    print(row(label, xs))
            print()
            if group:
                print(f"### {title}: tokens per {group[0]} ({unit})\n\n{header}")
                for key, label in variants:
                    sums: dict[tuple, float] = defaultdict(float)
                    for r in items:
                        if key in r:
                            sums[group[1](r)] += tokens(r[key])[idx]
                    if sums:
                        print(row(label, list(sums.values())))
                print()

    section("Games", games, VARIANTS, ("game seat (one seat, one game)", lambda r: (r["_file"], r["game"], r["seat"])))
    section("Draft", picks, VARIANTS[:2], ("draft (one seat, all picks)", lambda r: (r["_file"], r["seat"])))
    section("Deckbuilding", builds, VARIANTS[:2])


if __name__ == "__main__":
    main()
