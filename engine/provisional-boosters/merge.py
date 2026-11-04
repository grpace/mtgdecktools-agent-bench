#!/usr/bin/env python3
"""Add provisional booster pools to a phase-rs draft-pools.json, marked `provisional: true`.

    merge.py DRAFT_POOLS.json CARD_DATA.json POOL.json [POOL.json ...]

Every card on a provisional pool's sheets must be in CARD_DATA.json, the card data the engine will load: build the
pool from the same MTGJSON the card data was generated from (an engine build from before a set was fully previewed
lacks some of its cards, and phase-server rejects a deck holding them). Each POOL.json is draft-pool-gen output for one set (from a TRK.json that build_trk.py gave provisional sheets). A
set that the upstream file already has is left alone: once MTGJSON publishes the real sheets and phase-rs ships them,
the provisional pool stops being used. Writes DRAFT_POOLS.json in place, keys sorted the way phase-rs writes them.
"""
import json, sys
from pathlib import Path


def main(target, card_data, *pools):
    path = Path(target)
    data = json.loads(path.read_text())
    cards = json.loads(Path(card_data).read_text())
    for p in pools:
        for key, pool in json.loads(Path(p).read_text()).items():
            if key in data and not data[key].get("provisional"):
                print(f"{key}: upstream has real booster data; provisional pool not used")
                continue
            names = {c["name"] for s in pool["sheets"].values() for c in s["cards"]}
            missing = sorted(n for n in names if n.lower() not in cards and n.split(" // ")[0].lower() not in cards)
            if missing:
                sys.exit(f"{key}: {len(missing)} sheet cards are not in {card_data} (e.g. {', '.join(missing[:5])}); "
                         "build the pool from the MTGJSON this card data came from")
            data[key] = {**pool, "provisional": True}
            print(f"{key}: provisional pool added ({len(pool['sheets'])} sheets)")
    path.write_text(json.dumps(dict(sorted(data.items())), indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
