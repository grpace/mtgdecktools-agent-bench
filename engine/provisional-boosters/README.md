# Provisional Boosters

When a set's cards are out but MTGJSON hasn't published its booster sheets yet, phase-rs has no draft pool for it. This folder writes the sheets ourselves, from Wizards' published Play Booster contents, so the set can be drafted early. Events on these packs are **unrated** (METHODOLOGY §3, "Unrated events"): the collation is our reading of the published odds, not the real sheets.

| File | What it does |
| --- | --- |
| `build_trk.py` | Star Trek (TRK, with the SDS Stardates slot): adds a `booster.play` block to MTGJSON's `TRK.json`. The docstring gives the pack and the sources. |
| `merge.py` | Adds pools made by phase-rs's `draft-pool-gen` to a `draft-pools.json`, marked `provisional: true`. A set the file already has from upstream is left alone, and a pool with any card missing from the card data is refused. |

## Making the Pool

```bash
curl -sO https://mtgjson.com/api/v5/TRK.json && curl -sO https://mtgjson.com/api/v5/SDS.json
python3 -I engine/provisional-boosters/build_trk.py TRK.json SDS.json sets/TRK.json   # sets/ also holds SDS.json
draft-pool-gen sets/ draft-pools.trk.json                                              # phase-rs: crates/draft-core
python3 -I engine/provisional-boosters/merge.py <data>/draft-pools.json <data>/card-data.json draft-pools.trk.json
```

The pool and the card data must come from the same MTGJSON. An engine build from before the set was fully previewed lacks some of its cards (phase-rs 0.118.0 lacks 75 of TRK's 306), and phase-server rejects a deck that holds one.

## How It Is Recorded

- The Director lists the provisional pools in `event_start.boosters.provisional_sets`, and logs `event_start.provisional_boosters: true` for an event on one of them.
- The scoring (`unratedReason`) lists that event as unrated: "provisional boosters (collation not yet published)".
- Packs regenerate from the archived `draft-pools.json` like any other event's.

## Retiring

Once MTGJSON publishes the set's sheets and the pinned phase-rs build carries them, `merge.py` skips the provisional pool, and new events on the set are rated again. Delete the set's script then.
