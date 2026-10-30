---
phase: 1
title: "Boot with no CopilotKit account"
status: completed
priority: P1
effort: "2h"
dependencies: []
---

# Phase 1: Boot with no CopilotKit account

## Goal
`bash scripts/start.sh` on a fresh `.env` (copied from `.env.example`, no CopilotKit-issued key)
reaches "Ready" using only the in-repo platform.

## Context
- `.env.example:123-132` already points `INTELLIGENCE_API_URL`/`INTELLIGENCE_GATEWAY_WS_URL` at
  `localhost:3001` and ships placeholder `CPK_INTELLIGENCE_API_KEY=local-intelligence`.
- `scripts/start.sh:300-305` still calls `scripts/setup-learning.ts` whenever a key is set, and
  `:405-424` requires `licenseStatus == "valid"` from `/api/copilotkit/info`.
- The old trial stack in `~/Dev/openbot` holds ports 3001, 3010, 4100, 4212, 4500, 5433 and must be
  stopped first (`bash scripts/stop.sh` there, plus its harness container).

## Files to Modify
- `scripts/start.sh` — only if a step assumes managed Intelligence (setup-learning call, licence
  check message).
- `.env` (local, git-ignored) — created from `.env.example`.

## Tasks & Steps
1. Stop the `~/Dev/openbot` stack and its `agent-harness` container; confirm ports free.
2. `cp .env.example .env` in `~/Dev/myduet`; set `POSTGRES_PORT=5433` + matching `DATABASE_URL`
   (host Postgres holds 5432); generate `KEY_ENCRYPTION_KEY`.
3. User adds the model credential (Claude plan token) — never echoed.
4. Run `start.sh`; fix any step that requires the managed service. Keep fixes minimal and
   behaviour-preserving when managed Intelligence *is* configured.
5. Confirm `/api/capabilities` and `/api/copilotkit/info` (licence status, Bots list).

## Verification
- `curl -s 127.0.0.1:3001/api/capabilities` → `"mode":"intelligence"`.
- `grep -i copilotkit.ai .logs/server.log` shows no managed endpoint use.
- `bun run typecheck && bunx biome lint --error-on-warnings .`

## Risks
- setup-learning may try CopilotKit sign-in; skip it when the API URL is the local platform.

## Result (2026-10-30)
- Old `~/Dev/openbot` stack stopped (volumes kept); myduet `.env` created, Postgres on 5433.
- Server booted with no CopilotKit-issued key: `/api/capabilities` → `"mode":"intelligence"`,
  `/api/copilotkit/info` → licence `valid`, Bots `general-assistant`, `knowledge`; no
  `copilotkit.ai` in the log.
- `scripts/start.sh`: skip `setup-learning.ts` when `INTELLIGENCE_API_URL` is the built-in platform
  (it printed a misleading "use an HTTPS origin" line; the migration seeds `openbot`).
