---
title: "Bring myduet to CopilotKit level for a company deployment and bridge Hermes"
description: "Close the operational gaps of the local Intelligence platform that Hermes cannot cover, then plug Hermes Agent servers in as per-user coworkers whose side effects go through myduet's governed tools."
status: completed
priority: P1
effort: 6d
branch: adopt-local-intelligence
tags: [infra, backend, agents, hermes]
blockedBy: []
blocks: []
created: 2026-10-31
---

# Bring myduet to CopilotKit level and bridge Hermes

## Overview

myduet already runs without CopilotKit cloud
([previous plan](../261030-1510-local-intelligence-adoption/plan.md)). "CopilotKit level" here means
it can run for the whole company with the reliability the managed service gave. It does not mean
re-implementing every hosted feature. Learning and semantic memory belong to Hermes.

Inputs:
- [Fork and Hermes research](../reports/research-261031-0052-fork-ideas.md)
- [Local platform contract](../../docs/intelligence-platform.md)

## Decisions (user, 2026-10-31)

- **Governed tools required from v1.** Hermes must reach side effects only through myduet's
  `/api/agent-tools/call` (grants, policy, audit). Hermes' own side-effecting toolsets are disabled
  on every profile.
- **One server instance.** HA is designed for later, not built (pg_notify fan-out, see
  research rank 4).
- **Vietnamese search only.** `simple` + `unaccent`; no embeddings.
- **Vietnamese UI later.** Out of scope.
- One Hermes profile per user (`/p/<user>/`, its own key), one myduet coworker per user. This is the
  default the research recommends; the spike in phase 3 confirms it.

## Phases

| # | Phase | Effort | Status |
|---|---|---|---|
| 1 | [Operations baseline](phase-01-operations-baseline.md) | 1d | completed |
| 2 | [Vietnamese search](phase-02-vietnamese-search-and-platform-fidelity.md) | 0.5d | completed |
| 3 | [Hermes spike (gate)](phase-03-hermes-spike.md) | 0.5d | deferred by owner (2026-10-31): stay on the Claude plan on this machine; wire spec from source |
| 4 | [agent-hermes bridge](phase-04-agent-hermes-bridge.md) | 1.5d | completed (against source-built fixtures and a stand-in Hermes) |
| 5 | [Governed tools over MCP](phase-05-governed-tools-over-mcp.md) | 1.5d | completed (verified through the real `/api/agent-tools/call`) |
| 6 | [Per-user rollout and end-to-end verification](phase-06-per-user-rollout-and-e2e.md) | 0.75d | runbook done; live rollout deferred by owner (no SSO, no Hermes host yet) |

Dependencies: 1 and 2 are independent. 3 gates 4 to 6. 5 needs 4. 6 needs all.

## Acceptance criteria

1. Typing "hop dong" finds a memory that says "hợp đồng".
2. A backup made by the script restores into an empty database, and the chat history is intact.
3. `/ready` reports not-ready when Postgres is down and recovers on its own once it is back.
4. The Helm chart installs exactly one server replica.
5. A Hermes coworker answers in myduet with streaming, and the history survives a restart.
6. Every side effect a Hermes coworker takes appears in myduet's audit as an `mcp` tool call
   attributed to the right person and Bot. A call outside the Bot's grants is refused.
7. Two users on two Hermes profiles cannot see each other's threads, memory or coworker.
8. The platform, config and new bridge test suites pass. The full suite has no new failures
   compared with the branch's current baseline (12 known upstream failures).

## Non-goals

- Learning engine and semantic memory (Hermes owns them).
- Trajectory persistence: its only consumer is the Learning engine, which is not built. Tool
  activity is audited through governed tools instead.
- Multi-instance fan-out, Vietnamese UI, Slack and other channels.
- Changing the Hermes source code. Hermes is configured, not forked.
- Annotations analytics.

## Risks

- **Hermes MCP headers are static per profile**, while myduet's run assertion changes each run.
  The bridge holds the run assertion itself and serializes runs per profile (phase 5). Ceiling:
  one live run per user at a time. Phase 3 checks whether Hermes forwards a per-session header to
  MCP servers, which would remove the ceiling.
- Hermes changes quickly. The bridge pins the wire shapes it reads in tests built from captured
  real streams (phase 3).
- `@copilotkit/runtime` upgrades still need the platform suite re-run.

## Review (2026-10-31)

An independent code review found 3 high and 5 medium findings. All were fixed and tested:

- **High:**
  - A queue timeout let a later run overlap the live one and take its signed assertion. The timeout
    now leaves the queue tail alone, and a test covers the overlap.
  - Several exit paths freed a profile while its Hermes turn kept running, including leaving while
    queued, leaving before the run existed, a cut stream, and `run.queued`. Now the abort listener
    is attached before waiting, and every exit without a terminal event stops the turn and waits
    (up to 30 s) before freeing the profile. Shutdown stops live turns. Two tests cover this.
  - `/data` was root-owned in the image. It is now owned by `bun`, which the built image confirms,
    and catalog writes are atomic and cannot fail a run.
- **Medium:**
  - The approval auto-answer now only ever sends `deny`.
  - The chart README notes the replica default change.
  - `unaccent` and `myduet_unaccent` are pinned to `public`. The edited `0901` hash was re-recorded
    on the dev and test databases, which already ran it.
  - Backups are written with `umask 077`.
  - The new migration `0902` adds a trigram index, so recall's OR uses both indexes as a BitmapOr:
    4.7 ms with 20,000 memories for one person.
- **Low items also fixed:**
  - LIKE wildcards in queries are escaped.
  - The readiness probe no longer piles up queries while the database hangs.
  - The SSE parser handles a CRLF split across chunks.
  - Tool results use one ordered queue, which survives Hermes' clamped names.
  - `restore.sh` also refuses while the compose server or worker runs.
- **Accepted trade-off:** recall uses the `simple` configuration, so it no longer stems English
  ("morning meeting" does not find "meetings in the morning").
