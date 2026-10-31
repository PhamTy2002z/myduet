---
phase: 3
title: "Hermes spike (gate)"
status: pending
effort: 0.5d
---

# Phase 3: Hermes spike (gate)

## Context

The Hermes facts in the [research](../reports/research-261031-0052-fork-ideas.md) were read from
source and docs. Nothing has been run yet. Phases 4 to 6 depend on wire shapes that must be
observed first.

Approval needed: this phase touches one company Hermes server. Confirm which server, and that a
test profile may be created on it, before starting. Credentials stay in `.env` or on the server,
and are never pasted into chat or printed.

## Questions to answer with captured evidence

1. **Responses stream.** The exact SSE event sequence from `POST /p/<profile>/v1/responses` with
   `stream: true` for a plain answer, a native tool call, and an MCP tool call. Save sanitized
   captures as test fixtures.
2. **Session scoping.** `X-Hermes-Session-Id` keeps a per-thread transcript. Does a second turn with
   the same id see the first?
3. **MCP header forwarding.** When Hermes calls a remote MCP server, does it send anything
   per-session (session id, request id) beyond the static configured headers? If yes, phase 5
   drops per-profile serialization.
4. **Tool list refresh.** Does Hermes honour MCP `notifications/tools/list_changed`, or does it
   cache the tool list per profile until restart?
5. **Disabling native side effects.** Which profile config disables terminal, file, browser and
   code execution while keeping MCP tools? Confirm a disabled tool cannot be called.
6. **Approvals.** When does `approval.request` still fire once native side effects are disabled,
   and what does `POST /v1/runs/{id}/approval` take?
7. **Profiles.** Create a profile, set its key, and confirm one profile's key cannot reach another
   profile's runs.

## Output

`plans/reports/spike-<date>-hermes-wire.md` answering each question with evidence, plus fixtures
under `agent-hermes/test/fixtures/`. Each answer either confirms the plan or names the phase file
that changes.

## Gate

Do not start phase 4 until questions 1, 3 and 5 are answered. If question 5 cannot be met (native
side effects cannot be disabled), stop and bring the trade-off back to the user, because the
governed-tools decision then cannot hold.

## Outcome (2026-10-31)

- Answered from source instead of a live server:
  [Hermes wire spec](../reports/research-261031-0145-hermes-wire-spec.md) (Hermes `7020ea3e`).
- **Changed decisions:**
  - Use `/v1/runs`, not `/v1/responses`. Responses never streams approvals, has no stop route, and
    ignores the session header.
  - Closing a stream does not stop a canonical Hermes turn, so the bridge calls `/stop`.
  - Approval answers take exactly `{request_id, execution_generation, choice}`.
  - Hermes sends nothing per session to MCP servers (question 3: no), so one-live-run-per-profile
    stays.
  - Tool lists refresh on `tools/list_changed` and take effect from the next turn (question 4).
  - `platform_toolsets.api_server: [openbot]` plus `agent.disabled_toolsets` locks a profile to
    governed tools (question 5: yes).
- **Still to do on a live profile:** capture a real stream into the fixtures. Confirm that
  `tool.completed` has no result and that `session_id` creates a session on first use.
