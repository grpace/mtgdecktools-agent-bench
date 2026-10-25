-- Hosted play and GitHub self-serve (docs/ARCHITECTURE.md §4, packages/hub/README.md).
-- Tokens can carry several scopes: `contributor` tokens (issued at GitHub sign-in) are {submit, play}.
-- `scope` stays as the token's kind for listings; `scopes` is what authentication checks.
alter table tokens add column scopes text[] not null default '{}';
update tokens set scopes = array[scope] where scopes = '{}';
alter table tokens drop constraint if exists tokens_scope_check;
alter table tokens add constraint tokens_scope_check check (scope in ('submit', 'ingest', 'play', 'contributor'));
create index tokens_scopes on tokens using gin (scopes);

-- GitHub identity (self-serve sign-in) and per-contributor hosted-play quotas (null = the Hub default).
alter table contributors add column github_id bigint unique;
alter table contributors add column github_login text;
alter table contributors add column avatar_url text;
alter table contributors add column github_created_at timestamptz;
alter table contributors add column play_concurrent integer check (play_concurrent is null or play_concurrent >= 0);
alter table contributors add column play_daily integer check (play_daily is null or play_daily >= 0);
alter table contributors add column last_login_at timestamptz;
