"""Rebuild data/unsupported-cards.json for the phase-rs build whose data is in <data-dir>.

Unsupported = cards whose parsed rules in this build's card-data.json contain an Unimplemented or
Unknown node, unioned with phase-rs's published coverage report (which tracks their latest main).
The union is deliberately conservative: a card we aren't sure about gets swapped out of packs.
With card overrides applied in <data-dir> (its card-overrides.json sidecar describes card-data.json), the cards an
active override makes supported (`marks_supported`) are taken off the list (`removed_by_overrides`;
scripts/card_overrides.py adjust_unsupported, docs/CARD-OVERRIDES.md).

Usage: python3 -I scripts/refresh-phase-data.py data/
"""
import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

COVERAGE_URL = "https://data.phase-rs.dev/coverage-data.json"


def main() -> None:
    data_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    # With local card overrides applied, card-data.json is patched: the base list is judged on the upstream file, and
    # then only the cards an applied override marks supported come off it (docs/CARD-OVERRIDES.md).
    side = data_dir / "card-overrides.json"
    upstream = data_dir / "card-data.upstream.json"
    src = data_dir / "card-data.json"
    supported: list[str] = []
    if side.exists() and upstream.exists():
        import hashlib
        sc = json.loads(side.read_text())
        if sc.get("sha256") == hashlib.sha256(src.read_bytes()).hexdigest():
            src = upstream
            supported = sc.get("supported") or []
    cards = json.loads(src.read_text())
    marked = set()
    for card in cards.values():
        blob = json.dumps(card)
        if "Unimplemented" in blob or '"Unknown"' in blob:
            marked.add(card["name"])

    published = set()
    try:
        with urllib.request.urlopen(COVERAGE_URL, timeout=120) as r:
            coverage = json.load(r)
        published = {c["card_name"] for c in coverage["cards"] if not c["supported"]}
    except Exception as e:  # offline is fine; the build's own markers still apply
        print(f"warning: could not fetch {COVERAGE_URL}: {e}", file=sys.stderr)

    unsupported = sorted(marked | published, key=str.lower)
    out = {
        "generated": date.today().isoformat(),
        "sources": {"card_data_markers": len(marked), "published_coverage": len(published)},
        "unsupported": unsupported,
    }
    if supported:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from card_overrides import adjust_unsupported
        out, _ = adjust_unsupported(out, supported)
    (data_dir / "unsupported-cards.json").write_text(json.dumps(out))
    removed = out.get("removed_by_overrides") or []
    print(f"{len(out['unsupported'])} unsupported cards ({len(marked)} from this build's card data, {len(published)} from published coverage"
          + (f"; taken off by card overrides: {', '.join(removed)}" if removed else "") + ")")


if __name__ == "__main__":
    main()
