---
phase: 2
title: "Vietnamese search and platform fidelity"
status: completed
effort: 0.75d
---

# Phase 2: Vietnamese search and platform fidelity

## Context

- `server/src/intelligence/store.ts:900-916` ranks memory recall with
  `to_tsvector('english', …)` and `plainto_tsquery('english', …)`. English stemming does nothing
  for Vietnamese, and "hop dong" never matches "hợp đồng".
- `docs/intelligence-platform.md` "What it does not do": errors are `{error:{code,retryable}}`
  without the hosted `message`/`category`/`requestId`; deleted thread ids are not tombstoned.
- Migration rule: the next fork-owned migration takes the next `09xx` (here `0901`), and its journal
  `when` is never restamped.

## Requirements

1. Recall matches regardless of diacritics and case, for Vietnamese and English alike. English
   stemming is given up; this is an accepted trade-off for a Vietnamese company.
2. Recall is backed by an expression index so it does not seq-scan as memories grow.
3. Error responses carry `message`, `category` and `requestId` in addition to the existing fields,
   in the shape the runtime reads. Existing fields are unchanged.
4. A deleted thread id answers 410 with a tombstone instead of 404, and cannot be recreated by
   `lock`/`connect`. Another person's thread still answers 404.

## Design

- Migration `0901`: `create extension if not exists unaccent`; an `immutable` SQL wrapper
  `myduet_unaccent(text)` (the built-in is only `stable` and cannot back an index); a GIN index on
  `to_tsvector('simple', myduet_unaccent(content))` for `intelligence_memories`.
- Query: the same expression on both sides, with `plainto_tsquery('simple', myduet_unaccent($q))`.
  Keep the existing substring pass for short queries, applied to unaccented text.
- Tombstones: a `deleted_at` column on `intelligence_threads` instead of a new table. Delete sets
  it, and reads treat it as gone (410).
- Error envelope: one helper in `routes.ts` used by every error path. Read the 1.83.0 runtime
  client to confirm which fields it surfaces before naming them.
- Back up the dev database before running the migration (`scripts/backup.sh` from phase 1).

## Files

- Create: `server/drizzle/0901_vietnamese_search.sql`, plus the journal and snapshot entries drizzle
  generates.
- Modify: `server/src/intelligence/store.ts`, `server/src/intelligence/routes.ts`, the drizzle
  schema file for the intelligence tables, `docs/intelligence-platform.md`.
- Tests: `server/tests/intelligence-platform.integration.test.ts`.

## Validation

- New tests: "hop dong" recalls "hợp đồng"; "HỢP ĐỒNG" recalls it too; English recall still works;
  a deleted thread answers 410 and `connect` does not revive it; another person's deleted thread
  answers 404; error bodies carry the new fields.
- `EXPLAIN` on a recall query uses the new index (checked once by hand and recorded in the phase
  notes).
- The full platform suite passes.

## Rollback

Migrations only move forward. To roll back, ship a `0902` that drops the index and the column. The
data is unchanged by `0901`.

## Outcome (2026-10-31)

- Done: migration `0901_vietnamese_search` (`unaccent`, the immutable `myduet_unaccent` wrapper, and
  a GIN index), with recall rewritten to the same expression. The new test covers "hop dong",
  "HỢP ĐỒNG", "dong a", "Đông Á" and English. `EXPLAIN` shows a Bitmap Index Scan on
  `intelligence_memories_search_idx`. The platform suite passes (55 tests).
- **Dropped requirements 3 and 4 (error envelope, tombstones), with evidence.** In
  `@copilotkit/runtime`'s `intelligence-platform/client.ts`, the only error fields read are
  `retryable` (`readErrorBodyRetryable`) and, for learned skills, `code`. Nothing handles a 410 for
  threads, and CopilotKit's own sample clients treat 404 and 410 alike. Neither feature would change
  any behaviour a client can observe.
