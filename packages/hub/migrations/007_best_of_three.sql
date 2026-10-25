-- Best of 3 with sideboarding (docs/SITE-DATA.md 2.13). Comparability groups no longer split on best-of: keys are
-- kn=<level>;mana=<mode>;prompt=<key> (the bo=<n> part is dropped). Only best of 3 with sideboarding is rated; earlier
-- tables are Early Test Data (visible, never rated). `hub reingest` re-derives every row from the bundles (including
-- best-of-3 tables without sideboarding); this migration fixes what it can from the rows alone.
update events set comparability_group = regexp_replace(comparability_group, ';bo=[0-9]+', '')
  where comparability_group like '%;bo=%';
update events set comparability_group = null, unrated_reason = 'early test data (best of ' || best_of || ')'
  where best_of <> 3 and comparability_group is not null;

-- event_start.sideboarding (null: indexed before this column existed).
alter table events add column sideboarding boolean;

-- Per game (games 2-3 of a match): the play/draw decision { on_play, chooser, choice, by } and each seat's
-- sideboarding { seat: { by, kept, in, out, main_count } }, from the play_draw and sideboarded records; the main deck
-- size per seat from game_start.deck_sizes. The Hub indexes finished events only, so nothing here is withheld.
alter table games add column play_draw jsonb;
alter table games add column sideboarding jsonb;
alter table games add column deck_sizes jsonb;
