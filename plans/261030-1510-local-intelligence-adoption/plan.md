---
title: "Run myduet without managed CopilotKit Intelligence"
description: "Adopt the in-repo Intelligence platform from lennartschoch/OpenBot, verify it end to end with no CopilotKit account, and harden it for a multi-user company deployment."
status: in-progress
priority: P1
effort: 7h
branch: adopt-local-intelligence
tags: [infra, backend, auth, critical]
blockedBy: []
blocks: []
created: 2026-10-30
---

# Run myduet without managed CopilotKit Intelligence

## Overview

myduet must run on company infrastructure with no CopilotKit cloud account. Research
(`plans/reports/research-261030-2203-remove-intelligence.md`) found an existing fork,
`lennartschoch/OpenBot`, that serves the Intelligence REST API and Phoenix gateway from inside the
API server over the same Postgres, verified against `@copilotkit/runtime` 1.83.0, with per-owner
thread scoping. It is already fast-forwarded onto branch `adopt-local-intelligence`; its two
fork-only commits (publish to its registry, badges) are reverted. Typecheck and lint are clean and
236 related tests pass.

This plan finishes the job: boot it with no CopilotKit account, carry over the Claude-plan model
path the user runs, make the default local-only and keyed, then verify in the real app.

## Decisions

- Adopt the in-repo platform instead of an SSE-mode rewrite: near-zero diff to OpenBot core keeps
  upstream merges cheap; multi-user ownership is already implemented and tested.
- Keep the Learning code: the platform serves its surfaces as stubs; deleting it would only add
  merge conflicts. Hermes owns memory and skills (out of scope here).
- Single server instance (the platform's documented ceiling). Fine for one company server.

## Non-goals

Hermes integration, branding rename, removing Learning/Recorder code, the desktop app's
local-Intelligence code, multi-replica fan-out, Helm chart changes.

## Phases

| # | Phase | Status | Effort |
|---|-------|--------|--------|
| 1 | [Boot with no CopilotKit account](./phase-01-boot-without-copilotkit-account.md) | Completed | 2h |
| 2 | [Claude-plan model harness in the scripts](./phase-02-claude-plan-harness.md) | Completed | 1.5h |
| 3 | [Local-only binding and a generated platform key](./phase-03-local-binding-and-platform-key.md) | Pending | 1.5h |
| 4 | [End-to-end verification and docs](./phase-04-e2e-verification-and-docs.md) | Pending | 2h |

Phases run in order; each leaves the branch green (typecheck, lint, touched tests).

## Success Criteria

- [ ] `.env` with no CopilotKit-issued key: `bash scripts/start.sh` reaches "Ready" and
      `/api/capabilities` answers `"mode":"intelligence"` served by the in-repo platform.
- [ ] No outbound request to `*.copilotkit.ai` from the server during a chat (checked in logs /
      by unset managed URLs).
- [ ] A built-in Bot answers through the Claude-plan harness; browser tool, chart component and an
      approval card all work in the UI.
- [ ] Every listening port binds loopback under `start.sh`; LAN IP is refused.
- [ ] `start.sh` never runs with the placeholder platform key.
- [ ] Another person's thread is refused (covered by the platform integration suite).
- [ ] Full test suite result recorded; no new failures versus the adopted baseline.
