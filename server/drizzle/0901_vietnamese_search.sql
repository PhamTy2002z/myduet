-- Memory recall that works for Vietnamese: no English stemming, and diacritics folded so a query
-- typed without them ("hop dong") still finds the memory written with them ("hợp đồng").
-- `unaccent()` itself is only STABLE (its dictionary could change), so it cannot back an index;
-- this wrapper names the dictionary explicitly and is declared IMMUTABLE, the standard way to index it.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.myduet_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;--> statement-breakpoint
CREATE INDEX "intelligence_memories_search_idx" ON "intelligence_memories" USING gin (to_tsvector('simple', myduet_unaccent("content")));
