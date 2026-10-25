-- Separate hosted-play quotas for the Matchmaking Lobby (owner decision 2026-10-22, docs/LOBBY.md §2.1): Private Tables
-- keep play_concurrent / play_daily; lobby tables count against these instead. null = the Hub default
-- (HUB_LOBBY_CONCURRENT, HUB_LOBBY_DAILY). The Director's admission control still limits capacity for everyone.
alter table contributors add column lobby_concurrent integer check (lobby_concurrent is null or lobby_concurrent >= 0);
alter table contributors add column lobby_daily integer check (lobby_daily is null or lobby_daily >= 0);
