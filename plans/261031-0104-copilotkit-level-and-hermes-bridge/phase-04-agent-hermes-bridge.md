---
phase: 4
title: "agent-hermes bridge"
status: pending
effort: 1.5d
---

# Phase 4: agent-hermes bridge

## Context

- myduet coworkers speak AG-UI. Hermes speaks OpenAI Responses and Chat Completions only (research,
  "Hermes facts").
- Template: upstream `agent-dsh` on branch `claude/deepseek-harness-adapter-cl4cp8` (`a088a6e5`,
  MIT). It puts an agent that runs its own tools behind AG-UI and reports each tool as already
  completed. `src/translate.ts` is 325 lines. Fetch the branch with
  `git fetch upstream claude/deepseek-harness-adapter-cl4cp8`.
- Bun idles out quiet streams after 10 s, while Hermes only sends `: keepalive` every 10 s. The
  bridge must emit its own AG-UI heartbeat.

## Requirements

1. New service `agent-hermes/` (Bun + TypeScript, same layout as `agent-dsh`): `POST /` takes an
   AG-UI `RunAgentInput` and streams AG-UI events. `GET /health` reports its own health and the
   upstream Hermes `/health`.
2. Translate the Hermes stream to AG-UI. Text deltas become `TEXT_MESSAGE_*`. Hermes tool progress
   becomes completed `TOOL_CALL_START/ARGS/END/RESULT`, so the person sees what ran. Errors become
   `RUN_ERROR` with a human sentence. A run always ends with `RUN_FINISHED` or `RUN_ERROR`.
3. `X-Hermes-Session-Id` is the AG-UI `threadId`. Only the newest user message is sent, because
   Hermes keeps the transcript per session (confirmed in phase 3, question 2).
4. Configuration per coworker comes from myduet's existing coworker endpoint and write-only auth
   header (`docs/coworkers.md`). The bridge holds no user list. The Hermes base URL and profile
   come from the bridge's own env, or from a path segment, whichever phase 3 shows is simpler.
5. A heartbeat event every 5 s while Hermes is silent.
6. A cancelled AG-UI request aborts the Hermes request.

## Files

- Create: `agent-hermes/` (`src/index.ts`, `src/translate.ts`, tests, `Dockerfile`,
  `package.json`, `README.md`).
- Modify: `docker-compose.yml` (service behind profile `hermes`, loopback-published port),
  `.env.example` (variables documented, no values), root workspace config if `agent-dsh`-style
  services are listed there, `docs/coworkers.md`.

## Validation

- Unit tests replay the phase 3 fixtures through `translate.ts` and assert the AG-UI event
  sequence for: plain answer, native tool progress, Hermes error, and a stream silent for longer
  than 10 s.
- Smoke test against the real test profile: a coworker pointing at the bridge answers in the myduet
  UI with streaming, and the thread is still there after a server restart.
- `bun run typecheck` and `bun run lint` are clean.

## Risks

Hermes stream shapes drift. The fixtures pin what the bridge reads, and the bridge fails a run
loudly (`RUN_ERROR`) on an unknown required event instead of guessing.

## Outcome (2026-10-31)

- `agent-hermes/` (no runtime dependencies) passes 8 unit tests. Lint, format and typecheck are
  clean, and the compose suite passes 25 tests with the new `hermes` profile service.
- **Live test against myduet, using a stand-in Hermes that speaks the `/v1/runs` wire:**
  - The coworker answered with streaming in the app.
  - The stream survived 12 s of Hermes silence (bridge heartbeat, `idleTimeout: 255`).
  - Hermes received `session_id` set to the thread.
  - The thread reopened with its history.
- **Bug found and fixed:** message ids of the form `msg_<run>_<n>` made the answer show twice after
  a reload, while UUID ids (what every other Bot uses) show it once. Message ids are now UUIDs, and a
  test asserts it.
