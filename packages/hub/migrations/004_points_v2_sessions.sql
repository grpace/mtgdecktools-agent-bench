-- Points scheme v2 and account sessions (docs/COMMUNITY.md "Points and the Contributors Leaderboard";
-- docs/SECURITY.md).
--
-- Sign-out ends every session: a session cookie carries the contributor's epoch at sign-in, and signing out bumps it.
alter table contributors add column if not exists session_epoch integer not null default 0;

-- points_ledger is derived (`hub points recompute` rebuilds it); from points-v2 on, earned_at and season are the
-- Hub's acceptance time of the event (submissions.decided_at, else received_at), never a time from the bundle (PTS-1).
comment on column points_ledger.earned_at is 'when the Hub accepted the event (decided_at, else received_at); points-v2';
comment on column points_ledger.season is 'UTC month of earned_at';
