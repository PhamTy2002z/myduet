# Research: removing CopilotKit Intelligence from myduet

Date: 2026-10-30 · Base: upstream `9ff9618` · `@copilotkit/runtime` 1.83.0

## Outcome

Removal is feasible on a path CopilotKit itself supports: `CopilotRuntime` in **SSE mode** with a
runner we own (`runtime.ts` v1.83.0 :313-340, :590-625). Intelligence-only features that cannot
exist in SSE mode: Intelligence Channels and Learning Containers. Neither is needed once Hermes owns
memory and skills.

## What Intelligence does today (and the replacement)

| Concern | Today | Replacement |
|---|---|---|
| Run execution + live streaming | `IntelligenceAgentRunner` over gateway WS (`copilot.ts:1784-1900`, `index.ts:1761`, `agents/handoff-wiring.ts:128`) | `PostgresAgentRunner extends AgentRunner` (port of `@copilotkit/sqlite-runner` 1.83.0, 753 lines), in-process live fan-out |
| Message history | `getThreadMessages` (8 call sites, see inventory) | Postgres tables; messages rebuilt from stored run events |
| Thread existence | `getThread` (`channels/thread-status.ts:23`) | DB lookup |
| Thread create | `getOrCreateThread` (`toolkit/src/run-turn.ts:645`, `toolkit/src/copilotkit/thread-lock.ts:52`) | DB upsert |
| Run locks | `ɵacquire/renew/cleanupThreadLock` (`thread-lock.ts`, `run-turn.ts:389-409`) | Postgres row lease with TTL |
| Per-user thread isolation | Platform scopes by `userId` | `identifyUser` + runner `isThreadAccessible` (owner recorded on first run) |
| Memory | `memory/intelligence.ts` mirror | Remove; local tables already serve this path (`memory/store.ts:95-114`) |
| Automatic Learning, skill publishing | `learning/*` (~3k lines), 5 tables | Remove (Hermes owns skills) |
| Recorder → Learning trajectories | `recorder/*` | Decision needed |
| Entitlement / self-host banner / licence | `intelligence-entitlement-check.ts`, `self-host-banner.ts` | Remove |
| Boot gate | `config.ts:1003-1021` | Remove; `mode: "sse"` |

## Seams that keep the diff small

- `toolkit/src/run-turn.ts:122` `IntelligenceLike` and `:166` `RunnerLike` already isolate every
  headless-turn call. A Postgres object that satisfies `IntelligenceLike` plus the new runner
  replaces Intelligence for routines, approvals resume, handoffs, and wake-ups without touching
  the turn engine logic.
- Frontend talks only to the OpenBot origin (`app/src/lib/copilot/provider.tsx:37`
  `runtimeUrl="/api/copilotkit"`). Sidebar and channels are already Postgres
  (`channels/summary.ts`, `/api/channels/events` WS). The rail derives from `agent.messages`.

## Gotchas found

1. **Local thread endpoints are synchronous.** In SSE mode the runtime calls
   `runtime.runner.getThreadMessages(...)` without `await` (`handlers/intelligence/threads.ts`
   v1.83.0 :365-375). A Postgres runner cannot satisfy that. Fix: OpenBot serves
   `GET /api/copilotkit/threads/:id/messages` itself (same `{messages}` shape as
   `app/src/lib/copilot/thread-messages.ts:186-210`), mounted before the runtime handler. The
   runner does not implement `LocalThreadEndpointRunner`; thread listing is not used by the app.
2. **`isThreadAccessible` may be async** (`agent-runner.ts` :`boolean | Promise<boolean>`), so owner
   enforcement can hit Postgres.
3. **Single replica.** Live `connect()` to an in-flight run is in-process. Multi-replica needs
   Postgres LISTEN/NOTIFY fan-out. Known ceiling; acceptable for one company server.
4. **Event durability semantics** (`run-turn.ts:37-46`: 60 s ack, "Thread already running") come from
   the Intelligence runner. Our runner throws `ThreadAlreadyRunningError` and persists events at run
   end like the SQLite runner.
5. No existing OpenBot table holds chat message bodies; `intelligenceChannelMappings`
   (`db/schema/core.ts:490-506`) is the natural key and becomes a plain channel-thread mapping.
6. Existing Intelligence-held history cannot be exported; myduet starts with empty history.

## Size

~447 matching lines across server/toolkit/shared/scripts/app; 64 server test files mention
Intelligence (21 call client methods). Learning module removal is the largest deletion.
Out of scope: `desktop/src-tauri` local-Intelligence (desktop app), `charts/` Helm values beyond
removing required keys.

## Forks

Scanned 1,071 of 1,108 forks of `CopilotKit/OpenBot` via the compare API; 54 have commits ahead of
upstream. Relevant ones (all MIT):

| Fork | Ahead / behind | Approach | Verdict |
|---|---|---|---|
| `lennartschoch/OpenBot` | 44 / 0 | Serves the Intelligence REST API + Phoenix gateway inside the API server over Postgres (`server/src/intelligence/*`, migration band `09xx`), verified against runtime 1.83.0; per-owner thread scoping; refuses the placeholder key with sign-in; 2,332-line integration suite | **Adopted** |
| `codaswin/Brooklyn` | 42 / 29 | SSE mode + `PostgresAgentRunner` (our original design) | Single-user only (all threads owned by `DEV_ACTOR`), runtime 1.77, history route answers 422 |
| `bitcloud-labs/openbot`, `cgallic/OpenBot`, `julien2613/OpenBot`, `matheussl22/openbot` | ≥400 behind | standalone boot / local runtime / SQLite threads | Too stale to merge |
| `ocodista/free-bot` | 2 / 47 | desktop local mode | Desktop-focused |

Adoption: fast-forwarded `lennart/main` onto branch `adopt-local-intelligence`, reverted
`f3a9d77` (publishes images to that fork's registry) and `0af5308` (badges). Typecheck and lint
clean; 236 tests across the platform, config, thread and memory suites pass against a dedicated
test database.

Because the adopted platform keeps the Intelligence wire contract, the SSE-mode gotchas above (sync
local thread endpoints, owner enforcement) no longer apply; Recorder and Learning keep working in
the platform's documented reduced form.

## Unresolved questions

1. Confirm single-replica deployment is acceptable.
