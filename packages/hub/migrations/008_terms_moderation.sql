-- Terms acceptance, moderation and erasure (docs/legal/, docs/SECURITY.md "Moderation and erasure").

-- Terms: the version each contributor last accepted, and every acceptance (the record of consent).
alter table contributors add column if not exists terms_version text;
alter table contributors add column if not exists terms_accepted_at timestamptz;
create table if not exists consents (
  id             bigserial primary key,
  contributor_id bigint not null references contributors(id),
  terms_version  text not null,
  accepted_at    timestamptz not null default now(),
  via            text not null check (via in ('cli', 'web', 'admin'))
);
create index if not exists consents_contributor on consents(contributor_id, accepted_at desc);

-- Moderation: a handle hidden by moderators (the reason; the contributor can't show it again), and erasure.
alter table contributors add column if not exists moderation_hidden text;
alter table contributors add column if not exists erased_at timestamptz;
alter table contributors drop constraint if exists contributors_status_check;
alter table contributors add constraint contributors_status_check check (status in ('active', 'suspended', 'erased'));

-- Hidden agent text: a single note (item = its note key, public-text.ts noteItem) or a deck name (item '').
create table if not exists moderation_hides (
  id          bigserial primary key,
  kind        text not null check (kind in ('note', 'deck_name')),
  event_id    text not null,
  seat        text not null,
  item        text not null default '',
  reason      text not null,
  created_at  timestamptz not null default now(),
  created_by  text not null,
  unique (kind, event_id, seat, item)
);
create index if not exists moderation_hides_event on moderation_hides(event_id);

-- The review queue: text the filter flagged (word list, links, impersonating handles). Flagged text is published but
-- never featured automatically; a reviewer keeps it (stays unfeatured) or hides it.
create table if not exists moderation_flags (
  id             bigserial primary key,
  key            text not null unique,
  kind           text not null check (kind in ('note', 'deck_name', 'handle')),
  event_id       text,
  seat           text,
  item           text,
  contributor_id bigint references contributors(id),
  excerpt        text not null,
  reasons        text[] not null,
  status         text not null default 'open' check (status in ('open', 'kept', 'hidden')),
  created_at     timestamptz not null default now(),
  reviewed_by    text,
  reviewed_at    timestamptz
);
create index if not exists moderation_flags_status on moderation_flags(status, id);

-- Every moderation action: who, when, what and why.
create table if not exists moderation_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  actor   text not null,
  action  text not null,
  target  jsonb not null,
  reason  text
);

-- Erased contributors: the anonymous id that replaces their Hub id in every event log (never reversible from the
-- public data: the contributor row keeps no GitHub id, login or handle).
create table if not exists erasures (
  contributor_id bigint primary key references contributors(id),
  anon_id        text not null unique,
  erased_at      timestamptz not null default now()
);
