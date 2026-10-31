-- Recall ORs full text with a substring pass; Postgres uses indexes for an OR only when both sides
-- have one, so this trigram index is what lets 0901's full-text index be used at all.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;--> statement-breakpoint
CREATE INDEX "intelligence_memories_substring_idx" ON "intelligence_memories" USING gin (lower(myduet_unaccent("content")) public.gin_trgm_ops);
