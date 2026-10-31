---
phase: 6
title: "Per-user rollout and end-to-end verification"
status: pending
effort: 0.75d
---

# Phase 6: Per-user rollout and end-to-end verification

## Context

- Layout: one Hermes profile per user (`/p/<user>/`, its own `API_SERVER_KEY`), and one myduet
  coworker per user, published only to that person (`docs/coworkers.md`, publication to named
  people).
- Network idea from `cgallic/OpenBot` (`a4478538`, `71984fe5`): reach the Hermes hosts over a
  private network, and allow only those hosts in `AGENT_ENDPOINT_ALLOWED_HOSTS`.
- Changing company systems needs explicit approval. This phase writes the runbook and verifies
  it on test profiles. Rolling it out to real users is a separate, approved step.

## Requirements

1. A runbook in `docs/coworkers.md` (a Hermes section): create a profile, disable native side
   effects, add the bridge MCP server, create the coworker in myduet, publish it to the person.
   Every step names the variable or file, never a value.
2. `AGENT_ENDPOINT_ALLOWED_HOSTS` lists only the bridge, and the bridge reaches only the Hermes
   hosts.
3. Two test users on two profiles, end to end.

## Validation (the plan's acceptance criteria)

- User A and user B each chat with their own Hermes coworker. Neither sees the other's coworker,
  threads or memory.
- A governed tool call by A appears in the audit as A's. An ungranted call is refused.
- Restart the stack: both histories are still there.
- Run phase 1 and 2 checks once more on the integrated branch: `/ready`, backup and restore,
  "hop dong" recall.
- Full `bun test` (with Claude-plan variables cleared): no new failures against the 12 known
  upstream failures.
- Code review of the bridge and migration before merge.

## Finish

- Update `README.md` "myduet additions" and the plan status.
- Write the journal entry.
- Commit and push only when the user asks.

## Outcome so far (2026-10-31)

- Runbook: `agent-hermes/README.md`, linked from `docs/coworkers.md`.
- Not done: two real users on two real Hermes profiles. This needs a Hermes host and approval to
  configure it.
- Bridge-side isolation between two people is verified by a test.
  - Binh's inbound token cannot open An's coworker.
  - Binh's MCP token is refused on An's endpoint.
  - On Binh's own endpoint, nothing runs while only An has a live run.
  - An's signed assertion is never used by anyone else.
- Coworker visibility per person is myduet's existing publication model and was not changed.
- Still needed:
  - Two real Hermes profiles on a Hermes host.
  - Two signed-in people. This deployment runs `OPENBOT_SINGLE_USER=true`, so a second person
    needs an identity provider.
