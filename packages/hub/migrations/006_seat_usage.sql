-- Usage summaries for hosted seats (POST /api/usage, packages/director/src/usage-upload.ts). A hosted Director never sees
-- harness logs, so the contributor's bench CLI sends each seat's summary after the event: model ids, token counts, the
-- logged effort and the harness version only. Stored here and in the bundle store (body_sha256), and written into the
-- event's run folder as usage-<seat>.json at every ingest; self-attested evidence (evidence.kind "cli-local-logs").
create table seat_usage (
  event_id        text not null,
  seat_name       text not null,
  -- Who sent it: a contributor (their token), or null for the Hub admin token (admin-organized events).
  contributor_id  bigint references contributors(id),
  uploaded_by     text not null check (uploaded_by in ('contributor', 'admin')),
  body_sha256     text not null,
  body            jsonb not null,
  received_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (event_id, seat_name)
);
create index seat_usage_contributor on seat_usage(contributor_id);
