---
phase: 5
title: "Governed tools over MCP"
status: pending
effort: 1.5d
---

# Phase 5: Governed tools over MCP

## Context

- User decision: Hermes reaches side effects only through myduet's governed tools.
- `server/src/app.ts:1831` `POST /api/agent-tools/call` needs two credentials: the agent's own
  token (`x-openbot-agent-token`) and the signed per-run assertion from
  `forwardedProps.openbotRun`. It checks them against each other, then runs the call through grants,
  policy and audit.
- `server/src/copilot.ts:1395-1415` puts `openbotDeploymentTools` (the tools this deployment runs)
  and `openbotRun` into `forwardedProps` for each run.
- Prior art: `itsablabla/OpenBot-jada` `7dc5df65` (`agent-droid/src/mcp_proxy.py`, MIT) exposes
  deployment tools as MCP and calls back through the same route. Borrow the idea.
- Hermes MCP config is static per profile, while `openbotRun` changes every run.

## Design

The bridge from phase 4 also serves an MCP endpoint (`/mcp`, streamable HTTP). Each Hermes profile
is configured once to use it, with a static header that names the profile and carries a
bridge-issued secret.

Per run:
1. The AG-UI request arrives with `openbotRun` and `openbotDeploymentTools`. The bridge records it
   as the profile's active run.
2. Hermes lists tools: the bridge returns that run's deployment tools. Phase 3 question 4 decides
   whether the list is refreshed per run (`list_changed`) or is the union of the coworker's grants.
   Either way myduet enforces grants on every call.
3. Hermes calls a tool: the bridge forwards it to `/api/agent-tools/call` with the coworker's agent
   token and the active run's assertion, and returns the result or refusal to Hermes as the MCP
   result.
4. The run ends: the active-run record is cleared. A tool call with no active run is refused.

Serialization: one active run per profile. A second run for the same profile waits until the first
ends (bounded wait, then `RUN_ERROR` "another conversation is still running"). Mark it with a
`ponytail:` comment naming the ceiling (one live run per user) and the upgrade path (a per-session
header, if phase 3 found one).

Approvals: myduet's own approval flow runs inside `/api/agent-tools/call` for governed tools. Any
Hermes `approval.request` that still arrives is denied by the bridge and shown to the person as a
completed step that says what was refused and why.

Hermes profile config: native side-effecting toolsets disabled per phase 3 question 5; the bridge
MCP server added with `trust` set so Hermes does not prompt again for every call (myduet already
governs it).

## Requirements

1. Every Hermes side effect appears in myduet's audit with the right person, Bot and tool.
2. A tool outside the Bot's grants is refused, and the refusal is audited (existing
   `mcp.callback_refused` / grant-refusal paths).
3. The bridge never stores or logs an assertion or token beyond the live run.
4. The bridge MCP endpoint rejects requests without the profile secret.

## Files

- Modify: `agent-hermes/src/` (new `mcp.ts`, `runs.ts`), `agent-hermes/README.md`,
  `docs/coworkers.md`.
- No server changes expected. If `/api/agent-tools/call` turns out to lack something the bridge
  needs, stop and record it in the phase notes before changing the server.

## Validation

- Unit: an active run maps tool calls to the right assertion; a call with no active run is refused;
  a second run on the same profile waits; a bad profile secret is rejected.
- Integration against a test server: a granted tool succeeds and leaves an audit row naming the
  person and Bot; an ungranted tool is refused and audited.
- Live: on the test profile, ask Hermes for something that needs a governed tool, and see the step
  in the thread and the row in the audit page.

## Outcome (2026-10-31)

- **MCP endpoint, tested against the official MCP client (SDK 1.30):**
  - `tools/list` serves the coworker's catalog, which is kept on disk.
  - `tools/list_changed` reaches the client over the GET stream.
  - A call runs only inside a live run, and only for a tool that run was given.
- **Live:** the stand-in Hermes called `ask_person` through `/mcp/test`. myduet verified the
  callback token together with the run's assertion and ran it. Audit recorded `agent.escalated` for
  the coworker and run, and the app showed the "Asked you" step.
- No server changes were needed.
