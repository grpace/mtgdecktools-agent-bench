-- Seats answer with their choice only (docs/PROTOCOL.md): the index keeps no free text from picks or decisions.
alter table picks drop column if exists note;
alter table seat_game_stats drop column if exists notes;
