---
phase: 3
title: "Local-only binding and a generated platform key"
status: completed
priority: P1
effort: "1.5h"
dependencies: [1]
---

# Phase 3: Local-only binding and a generated platform key

## Goal
Under `start.sh` nothing listens beyond loopback, and the in-repo platform never runs on the
public placeholder key.

## Context
- `server/src/http-server.ts` calls `Bun.serve` with no `hostname` (binds all interfaces).
- `app/vite.config.ts` sets `host: "::"` (all interfaces).
- Every Docker port in `docker-compose.yml` is already loopback.
- The platform key is the whole credential for `/api/intelligence` (`docs/intelligence-platform.md`
  "Credentials"); the config refuses the placeholder only when sign-in is configured.
- Inside containers (compose `server`, one-container image) the server must keep binding all
  interfaces, or published ports stop working.

## Files to Modify
- `server/src/http-server.ts` — `hostname` from `BIND_HOST` when set (unset keeps today's behaviour).
- `app/vite.config.ts` — `host` from `BIND_HOST` (default unchanged), proxy target follows it.
- `scripts/start.sh` — default `BIND_HOST=127.0.0.1` for the processes it starts (overridable in
  `.env`); replace a placeholder/empty `CPK_INTELLIGENCE_API_KEY` with `openssl rand -hex 32`,
  written back to `.env` like `MANAGED_AGENT_TOKEN`.
- `.env.example`, `docs/configuration.md` — document `BIND_HOST`.
- Tests: one focused test for the `BIND_HOST` parsing if a helper is added.

## Tasks & Steps
1. Add `BIND_HOST` with validation at the config boundary (reject URLs/garbage, name the variable).
2. Wire server + Vite; keep Docker paths unaffected.
3. Key generation in `start.sh`, idempotent, never printed.

## Verification
- `lsof -nP -iTCP -sTCP:LISTEN` shows 127.0.0.1/::1 only for 3001/3010 and Docker ports.
- `curl http://<LAN-IP>:3001/` refused.
- `.env` key ≠ `local-intelligence` after first start; second start keeps it.

## Risks
- Linux hosts: Docker Bots calling back via `host.docker.internal` cannot reach a loopback-only
  server. Document: set `BIND_HOST` to the docker bridge address (or put a reverse proxy in front).

## Result (2026-10-30)
- `BIND_HOST` (config.ts `bindHost`, validated; http-server `hostname`; Vite `host` + proxy target).
  `start.sh` defaults it to 127.0.0.1; compose `server` pins `0.0.0.0` in its container.
- `start.sh` replaces an empty/placeholder `CPK_INTELLIGENCE_API_KEY` with `openssl rand -hex 32`
  (never printed); a hosted/self-hosted key is left alone.
- Fixed the Vite comment that called `::` "both loopbacks" (it is every interface).
- Verified: 3001/3010 and all Docker ports listen on 127.0.0.1/::1 only; LAN IP refused on all six;
  key replaced (64 hex chars). `config.test.ts` 155 pass incl. two new `BIND_HOST` tests.
