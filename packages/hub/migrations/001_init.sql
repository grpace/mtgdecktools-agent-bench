-- Hub index (docs/ARCHITECTURE.md §3). The bundle store is the source of truth: every table here can be
-- rebuilt from the stored bundles (`hub reingest --all`). Per-decision rows stay in the bundles.

create table contributors (
  id            bigserial primary key,
  handle        text not null unique check (handle ~ '^[a-z0-9][a-z0-9_.-]{0,39}$'),
  -- person: a community contributor; director: an official hosted Director (service account);
  -- maintainers: the import / admin account.
  kind          text not null default 'person' check (kind in ('person', 'director', 'maintainers')),
  status        text not null default 'active' check (status in ('active', 'suspended')),
  -- new: submissions are held for review until a maintainer trusts the contributor (or `review_first` pass).
  trust         text not null default 'new' check (trust in ('new', 'trusted')),
  note          text,
  created_at    timestamptz not null default now()
);

create table tokens (
  id             bigserial primary key,
  contributor_id bigint not null references contributors(id),
  -- submit: POST /api/submissions; ingest: POST /api/internal/events (hosted Directors only).
  scope          text not null check (scope in ('submit', 'ingest')),
  token_sha256   text not null unique,
  -- First characters of the token, to tell tokens apart in listings (never enough to use it).
  prefix         text not null,
  label          text,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);
create index tokens_contributor on tokens(contributor_id);

create table submissions (
  id                bigserial primary key,
  contributor_id    bigint references contributors(id),
  via               text not null check (via in ('upload', 'director', 'import')),
  bundle_sha256     text not null unique,
  bundle_bytes      integer not null,
  -- Optional derived inputs stored next to the bundle (imports): { "strength.json": sha256, ... }
  sidecars          jsonb not null default '{}',
  event_id          text,
  submitter_claimed text,
  label             text check (label in ('verified', 'community', 'smoke')),
  status            text not null default 'received'
                    check (status in ('received', 'validated', 'ingested', 'held', 'rejected', 'withdrawn')),
  -- [{ code, severity: reject|hold|flag|info, message }]
  reasons           jsonb not null default '[]',
  -- Full integrity report (METHODOLOGY §3.1), including the pack regeneration result.
  checks            jsonb,
  received_at       timestamptz not null default now(),
  validated_at      timestamptz,
  decided_at        timestamptz,
  ingested_at       timestamptz,
  reviewed_by       text,
  review_note       text
);
create index submissions_contributor on submissions(contributor_id, received_at desc);
create index submissions_event on submissions(event_id);
create index submissions_status on submissions(status);

create table events (
  id                  text primary key,
  submission_id       bigint not null references submissions(id),
  label               text not null check (label in ('verified', 'community', 'smoke')),
  set_code            text not null,
  set_name            text,
  seed                text,
  knowledge           text,
  mana                text,
  best_of             integer not null,
  pod_size            integer not null,
  agents              integer not null,
  llm                 boolean not null,
  engine_digest       text,
  engine_version      text,
  protocol_version    integer,
  director_version    text,
  prompt_version      text,
  primer_sha256       text,
  -- kn=<level>;mana=<mode>;bo=<n>;prompt=<version>; null = unrated (see unrated_reason)
  comparability_group text,
  unrated_reason      text,
  -- verified | partial | mismatch | unverifiable
  pack_regen          text,
  started_at          timestamptz,
  ended_at            timestamptz,
  winner              text,
  excluded            text,
  ingested_at         timestamptz not null default now()
);
create index events_group on events(comparability_group);
create index events_set on events(set_code);

create table seats (
  event_id        text not null references events(id) on delete cascade,
  name            text not null,
  kind            text not null,
  position        integer not null,
  is_agent        boolean not null,
  is_llm          boolean not null,
  harness         text,
  model           text,
  model_id        text,
  effort          text,
  identity        text,
  final_colours   text,
  -- sha256 over the seat's picks and decisions (choice + note): duplicate-stream detection.
  decision_fingerprint text,
  primary key (event_id, name)
);
create index seats_identity on seats(identity);
create index seats_fingerprint on seats(decision_fingerprint);

create table picks (
  event_id      text not null references events(id) on delete cascade,
  seat          text not null,
  pack_number   integer not null,
  pick_number   integer not null,
  overall_pick  integer not null,
  contents      text[] not null,
  pick          text not null,
  by            text not null,
  note          text,
  latency_ms    integer,
  -- Context-aware evaluation (METHODOLOGY §5.1), when the inputs exist.
  model_p       real,
  model_rank    integer,
  ev_regret_pp  real,
  in_lane       boolean,
  arch_regret_pp real,
  made_deck     boolean,
  primary key (event_id, seat, overall_pick)
);

create table decks (
  event_id       text not null references events(id) on delete cascade,
  seat           text not null,
  by             text not null,
  main           text[] not null,
  sideboard      text[] not null,
  basics         jsonb not null,
  main_count     integer not null,
  colours        text,
  deck_strength  real,
  reference_strength real,
  primary key (event_id, seat)
);

create table games (
  event_id      text not null references events(id) on delete cascade,
  game_index    integer not null,
  match_key     text not null,
  game_in_match integer not null,
  seat_a        text not null,
  seat_b        text not null,
  winner        text,
  turns         integer,
  on_play       text,
  end_reason    text,
  final_life    jsonb,
  mulligans     jsonb,
  started_at    timestamptz,
  ended_at      timestamptz,
  primary key (event_id, game_index)
);

create table seat_game_stats (
  event_id          text not null references events(id) on delete cascade,
  game_index        integer not null,
  seat              text not null,
  decisions         integer not null,
  auto_passes       integer not null,
  forced            integer not null,
  rejections        integer not null,
  manual_payments   integer,
  auto_tapper       integer,
  payment_failures  integer,
  median_latency_ms integer,
  notes             integer not null,
  primary key (event_id, game_index, seat)
);

-- Per comparability group ('*' = every event) × set × card: refreshed after each ingest for the event's set.
create table card_stats (
  group_key      text not null,
  set_code       text not null,
  card           text not null,
  agent_picks    integer not null,
  avg_pick       real,
  seen           integer not null,
  in_decks       integer not null,
  deck_games     integer not null,
  deck_wins      integer not null,
  deck_wr        real,
  refreshed_at   timestamptz not null default now(),
  primary key (group_key, set_code, card)
);

-- One row per board (group × set or '*' × source) × seat identity, from packages/site buildBoards().
create table ratings (
  board_id       text not null,
  group_key      text not null,
  set_code       text not null,
  source         text not null,
  identity       text not null,
  rating         real,
  ci_lo          real,
  ci_hi          real,
  se             real,
  rank           integer,
  games          integer not null,
  wins           integer not null,
  losses         integer not null,
  events         integer not null,
  opponents      integer not null,
  provisional    boolean not null,
  provisional_reasons jsonb not null,
  stages         jsonb not null,
  fitted_at      timestamptz not null default now(),
  primary key (board_id, identity)
);
create index ratings_identity on ratings(identity);
