#!/usr/bin/env python3
"""Provisional Star Trek (TRK) Play Booster collation, written in MTGJSON's `booster.play` format.

MTGJSON has the TRK and SDS cards but no booster sheets yet (isPartialPreview). Until it does, this builds them
from Wizards' published Play Booster contents and MTG Scribe's slot-by-slot fact sheet (2026-10-29). Only card
names matter for play, so frame treatments (LCARS, Klingon, scene, classic Enterprise, borderless) count as their
base card and rarity. Events drafted on these packs are provisional: drop this file once MTGJSON publishes the
real sheets.

Pack (14 cards, the token slot is skipped):
  6 commons + 1 common slot that is a Stardates (SDS) mythic in 1 of 25 packs
  3 uncommons, 1 non-foil wildcard, 1 rare or mythic, 1 traditional foil of any rarity
  1 land: a common Planet dual 50%, a basic 50% (foil or not doesn't matter for play)

Usage: build_trk.py TRK.json SDS.json OUT.json   (MTGJSON per-set files; writes TRK.json with `booster.play` added)
"""
import json, re, sys

# Slot rarity shares (percent). Variant-frame rows from the fact sheet are folded into their base rarity.
RARE_SLOT = {"rare": 2, "mythic": 1}                    # per-card weight: 160 vs 25, about 13.5% mythic (sheet: 12.4% + variants)
WILDCARD = {"common": 21.0, "uncommon": 57.0, "rare": 18.5, "mythic": 3.5}
FOIL = {"common": 52.5, "uncommon": 38.5, "rare": 7.7, "mythic": 1.3}
STARDATES_PACKS = 1                                    # out of 25
SCALE = 10_000_000


def num(card):
    m = re.match(r"(\d+)", card["number"])
    return int(m.group(1)) if m else 10**6


def main(trk_path, sds_path, out_path):
    trk = json.load(open(trk_path))
    sds = json.load(open(sds_path))["data"]
    data = trk["data"]
    if data.get("booster"):
        sys.exit("TRK.json already has booster data: use MTGJSON's sheets, not this file")

    # Main set: collector numbers 1-326 (306 cards, then the basics). One printing per name: the lowest number.
    first = {}
    for c in sorted(data["cards"], key=num):
        if num(c) <= 326:
            first.setdefault(c["name"], c)
    basics = {n: c for n, c in first.items() if "Basic" in (c.get("supertypes") or [])}
    cards = {n: c for n, c in first.items() if n not in basics}
    planets = {n: c for n, c in cards.items() if c["rarity"] == "common" and "Planet" in (c.get("subtypes") or [])}
    by_rarity = {r: {n: c for n, c in cards.items() if c["rarity"] == r and n not in planets}
                 for r in ("common", "uncommon", "rare", "mythic")}

    def flat(group, weight=1):
        return {c["uuid"]: weight for c in group.values()}

    def shared(shares):
        # Each rarity's share split evenly over its cards; integer weights.
        out = {}
        for r, pct in shares.items():
            group = by_rarity[r]
            w = round(pct / 100 * SCALE / len(group))
            out.update({c["uuid"]: w for c in group.values()})
        return out

    sheets = {
        "common": flat(by_rarity["common"]),
        "uncommon": flat(by_rarity["uncommon"]),
        "rareMythic": {**flat(by_rarity["rare"], RARE_SLOT["rare"]), **flat(by_rarity["mythic"], RARE_SLOT["mythic"])},
        "wildcard": shared(WILDCARD),
        "foil": shared(FOIL),
        # 50% one of the 10 Planet duals, 50% one of the five basics.
        "land": {**flat(planets, len(basics)), **flat(basics, len(planets))},
        "stardates": {c["uuid"]: 1 for c in {c["name"]: c for c in sds["cards"]}.values()},
    }
    booster = {
        "boosters": [
            {"contents": {"common": 7, "uncommon": 3, "wildcard": 1, "rareMythic": 1, "foil": 1, "land": 1},
             "weight": 25 - STARDATES_PACKS},
            {"contents": {"common": 6, "stardates": 1, "uncommon": 3, "wildcard": 1, "rareMythic": 1, "foil": 1, "land": 1},
             "weight": STARDATES_PACKS},
        ],
        "boostersTotalWeight": 25,
        "sheets": {
            name: {"cards": cs, "totalWeight": sum(cs.values()), "foil": name == "foil",
                   **({"balanceColors": True} if name == "common" else {})}
            for name, cs in sheets.items()
        },
        "sourceSetCodes": ["SDS", "TRK"],
        "name": "Star Trek Play Booster (provisional)",
    }
    data["booster"] = {"play": booster}
    json.dump(trk, open(out_path, "w"), indent=1, ensure_ascii=False)
    counts = {k: len(v) for k, v in sheets.items()}
    print(f"wrote {out_path}: sheets {counts}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
