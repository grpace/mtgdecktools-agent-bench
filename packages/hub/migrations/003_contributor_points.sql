-- Contributor points (packages/hub/src/points.ts; docs/COMMUNITY.md "Points and the Contributors Leaderboard").
-- The ledger is derived: `hub points recompute` (and the server, after every export) rebuilds it from the accepted
-- events, so the scheme can change and history can be rescored. Nothing here is a source of truth except
-- contributors.board_visibility, which the contributor sets on their account page.

-- null: follow the lobby's hide-handle choice (their latest lobby seat); 'public' / 'hidden': their own setting.
alter table contributors add column board_visibility text check (board_visibility in ('public', 'hidden'));

create table points_ledger (
  event_id          text not null references events(id) on delete cascade,
  seat              text not null,
  contributor_id    bigint not null references contributors(id),
  season            text not null,                 -- "2026-11" (UTC month of the event's end)
  earned_at         timestamptz not null,           -- the event's end
  scheme            text not null,                  -- points-v1
  set_code          text not null,
  table_kind        text not null check (table_kind in ('lobby', 'private')),
  identity          text not null,
  model_id          text not null,
  status            text not null check (status in ('finished', 'abandoned', 'ineligible')),
  games             integer not null,
  rated_games       integer not null,
  base              real not null,
  table_mult        real not null,
  repeat_mult       real not null,
  reliability_mult  real not null,
  bounty            real not null,
  bounties          jsonb not null default '[]',
  raw               real not null,
  capped            integer not null,
  points            integer not null,
  note              text not null,
  primary key (event_id, seat)
);
create index points_ledger_contributor on points_ledger(contributor_id, earned_at desc);
create index points_ledger_season on points_ledger(season);
