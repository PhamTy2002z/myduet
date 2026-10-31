---
phase: 1
title: "Operations baseline"
status: completed
effort: 1d
---

# Phase 1: Operations baseline

## Context

- `charts/openbot/values.yaml:27` sets `server.replicaCount: 2`. The local platform's realtime
  fan-out lives in one process (`docs/intelligence-platform.md`, "Deployment assumption"), so a
  second replica splits streams.
- `server/src/app.ts:481` `/health` is liveness only. Nothing checks the database.
- No backup or restore tooling exists.
- Ideas: readiness latch that re-arms after a cooldown (`1123786563/OpenBot` `62ee6a43`), backup
  that is verified before it is kept and a restore that previews first (`MrZealman/openbot`
  `75c42159`). Borrow the ideas, not the code.

## Requirements

1. Helm defaults to one server replica, and the chart says why.
2. `GET /ready`: 200 when a `select 1` against Postgres succeeds within 2 s, otherwise 503. The
   result is cached for a few seconds and re-checked after that, so one failed probe never sticks.
   No auth, no detail beyond `{status}`.
3. `scripts/backup.sh`: `pg_dump -Fc` of the compose database into `BACKUP_DIR` (default
   `./backups`, git-ignored). Verify with `pg_restore --list` before keeping it. Keep N days
   (`BACKUP_RETAIN_DAYS`, default 7). Never print credentials.
4. `scripts/restore.sh <file>`: list what the dump contains and require `--yes` before restoring.
   Refuse while the server is running, so a restore never races live writes.
5. Point compose and the Helm chart readiness probes at `/ready`.

## Files

- Modify: `charts/openbot/values.yaml`, chart probe template, `server/src/app.ts`,
  `docker-compose.yml` (server healthcheck), `.gitignore`, `docs/deployment.md`.
- Create: `scripts/backup.sh`, `scripts/restore.sh`, plus one test for `/ready`.

## Steps

1. Set `replicaCount: 1` with a comment that names the single-instance platform.
2. Add `/ready` next to `/health`, reusing the server's existing database handle.
3. Write the two scripts, following the style of `scripts/start.sh`.
4. Document backup, restore and readiness in `docs/deployment.md`.

## Validation

- `bun test` for the new `/ready` test (up, down, recovered).
- Manual: back up, drop and recreate the dev database, restore, and open an old thread in the app.
- `helm template charts/openbot | grep -c "kind: Deployment"` together with the replica count.

## Rollback

Revert the commit. Backups are files and are left in place.

## Outcome (2026-10-31)

- The Helm chart now accepts the built-in platform (both Intelligence URLs empty), defaults to one
  replica, and refuses more than one replica or autoscaling on the built-in platform. CI asserts
  both refusals. `helm` is not installed locally, so the chart was not rendered here, and CI is
  what checks it.
- `/ready` lives in `server/src/readiness.ts` and `http-server.ts`, wired with `select 1`. The Helm
  readiness probe and the compose healthcheck use it.
- `scripts/backup.sh` and `scripts/restore.sh`: a real backup restored into a scratch database gave
  identical counts (4 threads, 2,769 events, 84 audit rows). Restore refuses while the server
  answers.
