# sets/

Per-set data. Each `sets/<CODE>/` directory is named by the **phase-rs set code**, upper-cased (the code `--set` takes). Every set with phase-rs booster data is playable and fully scored without anything here; these files add the optional extras:

| File | What it is | Made by |
| --- | --- | --- |
| `primer.md` | The MTG Deck Tools Set Context (knowledge level `primer`) | `npm run deps -- update set-context` |
| `17lands.json` | Per-card 17Lands aggregates (below) | `npm run deps -- update 17lands` |
| `ratings.tsv` | Compact `name<TAB>gih_wr<TAB>ata`, sorted by GIH WR | same |
| `17lands-archetypes.json` | Card ratings within each color pair, deck-shape stats (`analysis/README.md` §1) | same |
| `deck-norms.json` | Norms of winning human decks per pair, build-quality scoring parameters (`analysis/README.md` §4) | same |

`rotation.json` is the site's featured list (an editorial choice: sets with a Set Context). It doesn't limit what can be played and doesn't change when human stats arrive for more sets.

What version of each file we're on (17Lands snapshot, source files, sha256) is recorded in `deps/manifest.json`; `docs/UPGRADING.md` is the guide to refreshing them.

## Which Sets Have 17Lands Data

17Lands publishes public files for the sets it tracked on MTG Arena. The rest (paper-only sets, and Arena sets from before 17Lands' public datasets) have no public file; they are listed in `deps/manifest.json` → `17lands.no_public_data` and re-probed by every `npm run deps -- check`, which also reports any set that newly appears.

<!-- coverage:start (generated from deps/manifest.json by `npm run deps -- manifest`; don't edit by hand) -->
Of the 175 sets with phase-rs booster data, **32 have 17Lands data** (last probed 2026-10-22). Model and norms: ✓ built, – skipped (reason in the manifest).

| Set | Name | 17Lands | Games | Drafts | Rated cards | Game dates | Pick model | Deck norms |
| --- | --- | --- | ---: | ---: | ---: | --- | :---: | :---: |
| FRA | Reality Fracture | FRA PremierDraft | 297,964 | 56,527 | 284/295 | 2026-09-29 to 2026-10-16 | ✓ | ✓ |
| HOB | The Hobbit | HOB PremierDraft | 323,114 | 58,017 | 190/193 | 2026-08-11 to 2026-09-22 | ✓ | ✓ |
| MSH | Marvel Super Heroes | MSH PremierDraft | 377,514 | 68,633 | 300/339 | 2026-06-23 to 2026-07-24 | ✓ | ✓ |
| SOS | Secrets of Strixhaven | SOS PremierDraft | 582,914 | 71,430 | 334/346 | 2026-04-21 to 2026-06-02 | ✓ | ✓ |
| TMT | Teenage Mutant Ninja Turtles | TMT PremierDraft | 180,204 | 32,151 | 201/215 | 2026-03-03 to 2026-04-04 | ✓ | ✓ |
| ECL | Lorwyn Eclipsed | ECL PremierDraft | 536,566 | 78,948 | 283/293 | 2026-01-20 to 2026-03-05 | ✓ | ✓ |
| TLA | Avatar: The Last Airbender | TLA PremierDraft | 562,924 | 73,171 | 304/347 | 2025-11-18 to 2025-12-31 | ✓ | ✓ |
| EOE | Edge of Eternities | EOE PremierDraft | 563,418 | 76,924 | 305/321 | 2025-07-29 to 2025-09-01 | ✓ | ✓ |
| FIN | Final Fantasy | FIN PremierDraft | 769,659 | 71,429 | 357/362 | 2025-06-10 to 2025-07-14 | ✓ | ✓ |
| TDM | Tarkir: Dragonstorm | TDM PremierDraft | 552,428 | 71,429 | 283/286 | 2025-04-08 to 2025-05-14 | ✓ | ✓ |
| DFT | Aetherdrift | DFT PremierDraft | 857,667 | 72,049 | 283/286 | 2025-02-11 to 2025-03-18 | ✓ | ✓ |
| FDN | Foundations | FDN PremierDraft | 791,159 | 71,805 | 282/286 | 2024-11-12 to 2024-12-15 | ✓ | ✓ |
| DSK | Duskmourn: House of Horror | DSK PremierDraft | 1,011,949 | 71,877 | 280/286 | 2024-09-24 to 2024-10-28 | ✓ | ✓ |
| BLB | Bloomburrow | BLB PremierDraft | 931,230 | 77,521 | 273/276 | 2024-07-30 to 2024-09-03 | ✓ | ✓ |
| MH3 | Modern Horizons 3 | MH3 PremierDraft | 767,772 | 71,885 | 321/326 | 2024-06-11 to 2024-07-15 | ✓ | ✓ |
| OTJ | Outlaws of Thunder Junction | OTJ PremierDraft | 1,172,393 | 71,845 | 373/381 | 2024-04-16 to 2024-05-27 | ✓ | ✓ |
| MKM | Murders at Karlov Manor | MKM PremierDraft | 964,377 | 77,385 | 308/326 | 2024-02-06 to 2024-03-18 | ✓ | ✓ |
| KTK | Khans of Tarkir | KTK PremierDraft | 212,170 | 35,783 | 249/254 | 2023-12-12 to 2024-01-14 | ✓ | ✓ |
| LCI | The Lost Caverns of Ixalan | LCI PremierDraft | 823,614 | 67,244 | 290/291 | 2023-11-09 to 2023-12-25 | ✓ | ✓ |
| WOE | Wilds of Eldraine | WOE PremierDraft | 1,024,028 | 72,510 | 312/329 | 2023-08-31 to 2023-10-15 | ✓ | ✓ |
| LTR | The Lord of the Rings: Tales of Middle-earth | LTR PremierDraft | 980,485 | 72,099 | 262/266 | 2023-06-15 to 2023-08-28 | ✓ | ✓ |
| MOM | March of the Machine | MOM PremierDraft | 1,246,850 | 67,367 | 346/346 | 2023-04-13 to 2023-06-12 | ✓ | ✓ |
| ONE | Phyrexia: All Will Be One | ONE PremierDraft | 583,077 | 71,918 | 265/270 | 2023-02-02 to 2023-02-27 | ✓ | ✓ |
| BRO | The Brothers' War | BRO PremierDraft | 542,903 | 67,387 | 322/335 | 2022-11-15 to 2022-12-13 | ✓ | ✓ |
| DMU | Dominaria United | DMU PremierDraft | 947,395 | 71,870 | 266/266 | 2022-08-30 to 2022-10-25 | ✓ | ✓ |
| SNC | Streets of New Capenna | SNC PremierDraft | 812,978 | 73,560 | 263/266 | 2022-04-28 to 2022-06-30 | ✓ | ✓ |
| NEO | Kamigawa: Neon Dynasty | NEO PremierDraft | 630,450 | 67,164 | 285/287 | 2022-02-10 to 2022-03-11 | ✓ | ✓ |
| VOW | Innistrad: Crimson Vow | VOW PremierDraft | 494,030 | 72,074 | 269/272 | 2021-11-11 to 2021-12-19 | – | ✓ |
| MID | Innistrad: Midnight Hunt | MID PremierDraft | 653,944 | 77,365 | 270/272 | 2021-09-16 to 2021-10-26 | – | ✓ |
| AFR | Adventures in the Forgotten Realms | AFR PremierDraft | 366,660 | 26,177 | 261/266 | 2021-07-08 to 2021-08-12 | – | ✓ |
| STX | Strixhaven: School of Mages | STX PremierDraft | 465,319 | 68,695 | 327/343 | 2021-04-15 to 2021-05-12 | – | – |
| KHM | Kaldheim | KHM PremierDraft | 440,826 | 0 | 282/285 | 2021-01-27 to 2021-04-04 | – | – |

Left out on purpose (`deps/set-codes.json`): **SPM**.
<!-- coverage:end -->

### Code Mapping

The 17Lands code is the phase-rs code unless `deps/set-codes.json` says otherwise. That file is the only place codes are mapped:

- **SPM** (Marvel's Spider-Man) has **no human stats**: Arena released it as Through the Omenpaths (17Lands code OM1) with different card names, and 17Lands has only PickTwoDraft data for it, so its ratings can't be matched to the phase-rs cards.
- **KTK** uses 17Lands' data from the 2024 Arena release of Khans of Tarkir (same card names, different collation).
- **Older files** (2021 sets, re-exported by 17Lands in January 2024: AFR, KHM, MID, STX, VOW) use an older format. Their draft files bucket player skill by match win rate, so the expert pick model (defined on game win rate) isn't built. STX and KHM game files have no `main_colors`, so they get card win rates only (no archetype ratings or deck norms). KHM has no draft data file at all (no ATA/ALSA).
- Arena-only products with 17Lands data but no phase-rs booster data (HBG, PIO, SIR, OM1) and Alchemy Y-sets are not used.

The MTG Deck Tools Set Context code `ATLA` maps to `TLA` (same file, `"mtgdecktools"` section).

## 17Lands Card Ratings

| File | What it is |
| --- | --- |
| `17lands.json` | Per-card aggregates from the 17Lands public datasets: `gih_wr`, `gp_wr`, `oh_wr`, `gns_wr`, `iwd`, game counts, `alsa`, `ata`, `picked`, `seen`, plus set-level `games`, `baseline_win_rate`, sampling info, the snapshot id (`snapshot`), the 17Lands code and format (`source_code`, `format`), the source files (`source_files`: URL, ETag, Last-Modified, size, rows) and the date range of the games (`date_range`). |
| `ratings.tsv` | Compact `name<TAB>gih_wr<TAB>ata`, sorted by GIH WR descending. `gih_wr` is in percent, `ata` is the in-pack pick number. Cards below the sample threshold have blank cells and sort last. |

Definitions (also documented at the top of `scripts/build-17lands-ratings.py`):

- **GIH WR**: win rate in games where the card was in hand at any point (opening hand or drawn). **OH WR**: opening hand only. **GP WR**: card in the main deck. **GNS WR**: card in the deck but never seen. **IWD** = GIH WR - GNS WR.
- Win-rate fields are `null` when the card has fewer than 200 games-in-hand (counts are still recorded).
- **ATA / ALSA**: average pick position at which a card was taken / last seen, as a 1-based position within a pack (1 to 14 or 15), the same convention 17Lands uses on its card pages. 17Lands files number picks from 0; we add 1. An overall pick index (`pack_number * picks_per_pack + pick_number + 1`) is not reported. ALSA assumes 8-player pods: a pack seen at pick k returns at pick k + 8.
- `sampled` is `true` if a row cap was hit and only the first rows of the file were used. The file also records `drafts`, `draft_picks`, and `games`.
- Card names are exactly as 17Lands spells them. Basic lands appear (they are in packs and decks).
- A set with fewer than 20,000 game rows gets no files at all (too few cards would reach the per-card threshold); the analysis outputs have their own set-level thresholds (`docs/UPGRADING.md`). Skips are recorded in the manifest.

## Attribution and License

Data from 17Lands (17lands.com). The raw files come from the 17Lands public datasets (<https://www.17lands.com/public_datasets>). That page states that, unless otherwise noted, the datasets are licensed under Creative Commons Attribution 4.0 International (CC BY 4.0). The 17Lands data-use guidelines also ask that anyone using their data make clear it comes from 17Lands, keep that credit visible, and not imply 17Lands endorses the product or findings. Those guidelines say they do not apply to the public datasets page itself, but we follow them anyway.

The files here are derived aggregates (modified from the originals) and are not produced or endorsed by 17Lands. If you reuse them, credit 17Lands and indicate that changes were made.

Verification note: the license wording was read from the page's own JavaScript bundle (the page renders client-side). It was last checked on 2026-10-21. Re-check the page before redistributing, because the license can change per dataset ("unless otherwise noted").

Only the documented public S3 files are used (`https://17lands-public.s3.amazonaws.com/analysis_data/...`). Nothing is fetched from the 17lands.com website API.

## Regenerating

```sh
npm run deps -- check                              # which 17Lands files changed, which sets are new
npm run deps -- update 17lands                     # rebuild those (ratings, archetypes, pick model, deck norms)
npm run deps -- update 17lands --set FRA           # one set, even if unchanged
npm run deps -- update 17lands --set FRA --steps ratings   # only 17lands.json and ratings.tsv (Python standard library)
```

The ratings step alone is `python3 -I scripts/build-17lands-ratings.py FRA` (options: `--format`, `--max-game-rows` (default 2,000,000), `--max-draft-rows` (default 3,000,000), `--min-gih` (default 200), `--min-pick` (default 30), `--min-games` (default 20,000)); run that way it doesn't update the manifest, so follow it with `npm run deps -- manifest`.
