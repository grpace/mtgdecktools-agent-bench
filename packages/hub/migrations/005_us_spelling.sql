-- US spelling for column names (docs/SITE-DATA.md "Deprecated keys"). 001 stays as it was applied; this renames.
-- GET /api/events/:id answers with the new names and, for one release, the old ones too.
alter table seats rename column final_colours to final_colors;
alter table decks rename column colours to colors;
