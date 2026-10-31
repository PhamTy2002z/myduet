---
title: "myduet operations baseline, Vietnamese recall and the Hermes bridge"
date: 2026-10-31
summary: "Helm/readiness/backup, unaccented Vietnamese recall with BitmapOr indexes, and agent-hermes (AG-UI to Hermes /v1/runs with governed tools over MCP), reviewed and fixed"
---

# myduet operations baseline, Vietnamese recall and the Hermes bridge

## What happened
Executed plans/261031-0104-copilotkit-level-and-hermes-bridge. Phases 1-2 (Helm accepts the built-in
platform at one replica, /ready, backup/restore, migration 0901 unaccented `simple` recall) and phases
4-5 (agent-hermes: AG-UI ↔ Hermes /v1/runs, plus an MCP endpoint that forwards Hermes' tool calls to
/api/agent-tools/call) are done. Phase 3 (live Hermes capture) and phase 6 (real per-user rollout) wait
for a Hermes host.

## Findings worth keeping
- CopilotKit's runtime client reads only `retryable`/`code` from error bodies and never handles 410, so
  the hosted error envelope and tombstones were dropped as unobservable.
- Hermes canonical mode: Responses never streams approvals; a closed stream does not stop a turn;
  approvals need exactly {request_id, execution_generation, choice}; MCP calls carry no per-session data.
- AG-UI message ids of the form msg_<run>_<n> rendered twice after a reload; UUID ids render once.
- Recall's OR only uses indexes when both sides have one: 0902 adds a trigram index, giving a BitmapOr.
- A "hung" test run was the laptop sleeping, not a test.

## Review
An independent review found a queue-timeout overlap and slot release while a Hermes turn still ran
(both could attribute tool calls to the wrong run), plus a root-owned /data in the image. All fixed
with tests; full suite shows only the pre-existing environmental failures.

## Next steps
Live Hermes profile: capture a real stream, confirm tool.completed carries no result and session_id
creates a session; then two-user rollout per agent-hermes/README.md.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
