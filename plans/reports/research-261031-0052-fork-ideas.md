# Fork ideas for a company-wide, cloud-free myduet with Hermes Agent servers

Date: 2026-10-31. Scope: forks of `CopilotKit/OpenBot` (upstream `main` at `743649ef`), the
upstream branches, and the `NousResearch/hermes-agent` API server (`main` at `7020ea3e`). This report
does not revisit the earlier "remove Intelligence" verdict in
`plans/reports/research-261030-2203-remove-intelligence.md`.

## Summary: top ideas, ranked

1. **Build the Hermes bridge from upstream's `agent-dsh` adapter. Verdict: borrow the idea (copy the
   structure).** Upstream branch `claude/deepseek-harness-adapter-cl4cp8` (commit `a088a6e5`, MIT,
   2 ahead and 585 behind) adds `agent-dsh/`. It is an AG-UI endpoint in front of an agent that runs
   its own tools. It streams text as `TEXT_MESSAGE_*` and reports every tool the harness ran as a
   completed `TOOL_CALL_START/ARGS/END/RESULT`. It maps one AG-UI thread to one harness session and
   forwards each message only once (`planPrompt` in `agent-dsh/src/translate.ts`). Its README also
   spells out the trust model: these actions skip the OpenBot gateway, the audit log and
   `AGENT_COMPUTER_POLICY`. Hermes is the same kind of agent. Swap the dsh stdio client for Hermes'
   `/v1/responses` SSE stream, whose `function_call` and `function_call_output` items map
   one-to-one onto completed AG-UI tool calls. Rough size: M, about 500–800 lines of TypeScript plus
   tests. It is a new `agent-hermes/` service and needs no server changes.
2. **Route per user with built-in features first. Verdict: adopt (no code).** OpenBot already
   stores a remote AG-UI endpoint, a write-only authorization header, visibility, and per-person or
   per-group publication for each coworker (`docs/coworkers.md`, "Data model" and "Register an
   external AG-UI agent"). Register one coworker per Hermes server (or per Hermes profile, see
   gap 7) and publish it only to the people allowed to use it. Rough size: S (configuration).
3. **Fix recall for Vietnamese and add semantic recall. Verdict: borrow the idea.** No fork changed
   `recallMemories`. Use `'simple'` plus `unaccent` in place of `'english'`
   (`server/src/intelligence/store.ts` lines 891–922). Add a pgvector embedding column and merge the
   two rankings with reciprocal-rank fusion. Fork `1123786563/OpenBot` instead moved memory to an
   external Hindsight service (`2ce901b8`, `0f1b941c`, about 25k lines) and pgvector to Qdrant
   (`d3c7c5a0`). That is far heavier than this gap needs. Rough size: M.
4. **Fan out across instances with a Postgres doorbell. Verdict: borrow the idea.** In
   `1123786563/OpenBot` commit `7f1562c1` (`server/src/workshop/bus.ts`, MIT), pub/sub carries only
   `{turnId, seq}` and subscribers re-read the rows from the database. A lost message therefore
   costs latency but never correctness, and when Redis is absent the bus falls back to polling.
   Swap Redis for `pg_notify`. myduet already uses it in `server/src/admin/settings-store.ts`
   line 116, so no new dependency is needed. Rough size: M–L, because the gateway's runner, client
   and lock state (`server/src/intelligence/gateway.ts` line 59, the `subscribers` map) must all
   work across processes. **Urgent and separate:** `charts/openbot/values.yaml` line 27 defaults
   `server.replicaCount: 2`. That contradicts the single-instance assumption in
   `docs/intelligence-platform.md` line 14. Set it to 1 until this lands.
5. **Translation layer plus titles in the user's language. Verdict: adopt (cherry-pick).**
   `ayakolin/OpenBot` (MIT) has two relevant commits. `13773a3b` (+2,290 lines) adds `t("English
   literal")` with English fallback, a `preferences.locale` setting, and browser-language detection.
   `e6bda2ed` (+57 lines) makes the conversation titler and the voice summary answer in the user's
   language, which myduet's `server/src/channels/titler.ts` line 11 does not do yet. Add a `vi`
   dictionary. Rough size: S for the titler, M for the layer (the fork is 39 commits behind, so
   expect conflicts), and L to translate every screen. The fork's zh-CN rounds show what that
   involves (`a2a74133` through `98548f90`).
6. **Verified backup and previewed restore. Verdict: borrow the idea.** `MrZealman/openbot`
   `75c42159` (+2,534 lines, MIT) writes a `pg_dump` archive under a temporary name, reopens it,
   checks it against its own manifest and only then renames it into place. Restore previews first
   and refuses to run while the server is answering. The code is tied to that fork's encrypted
   local edition. For a company deployment, a CronJob `pg_dump` with the same "verify before
   rename" rule plus a restore drill is enough. Rough size: S–M.
7. **Give Hermes OpenBot's governed tools over MCP. Verdict: borrow the idea, later.**
   `itsablabla/OpenBot-jada` `7dc5df65` (`agent-droid/src/mcp_proxy.py`, MIT) exposes the run's
   `forwardedProps.openbotDeploymentTools` to an agent with its own tool loop, as MCP tools. It calls
   them back through myduet's existing signed `/api/agent-tools/call` (`server/src/app.ts`
   line 1831), so grants, policy and audit still apply. Hermes accepts remote MCP servers with
   headers (`website/docs/reference/mcp-config-reference.md`). The catch is that Hermes' MCP config
   is static per profile, while the run assertion changes on every run. Rough size: M, with the
   per-run correlation risk described under gap 6.

Skip for this deployment: org multi-tenancy (`matthewdillon-commits/OpenBot2` `2cf64ebe`, +7,279
lines; the company is a single org), Grok OIDC (`scrya-com/OpenGrokBot` `7d12534d`; myduet already
has Google, Microsoft and Okta, runtime-registered SAML/OIDC, and SCIM per `docs/configuration.md`
lines 355–465), and the Learning engine (no fork implements one).

## Per-gap findings

### Gap 1: Vietnamese and semantic memory recall

- No fork touched local Intelligence recall. Only `lennartschoch/OpenBot` has the local platform,
  and its 6 new commits since adoption (`187cf2dd`..`6ece400b`) are release and CI changes.
- `1123786563/OpenBot` runs memory as a self-hosted Hindsight service (`2ce901b8`: compose pinned to
  `ghcr.io/vectorize-io/hindsight:1.0.0`, a backup script, and a four-state health check).
  `0f1b941c` adds scoped, degraded and preference recall. Hindsight is MIT
  (`github.com/vectorize-io/hindsight`). Verdict: skip. It adds a service and an LLM egress path,
  and its Vietnamese quality is unverified.
- Recommended in-repo change (no fork source): an expression index on
  `to_tsvector('simple', unaccent(content))`, an `embedding vector(n)` column filled when a memory
  is written, and a hybrid query that merges the lexical and cosine rankings. Postgres ships no
  Vietnamese stemmer, so `simple` plus `unaccent` is the practical lexical config. The embedding
  model must be multilingual. Near-duplicate absorption can then compare embeddings instead of
  normalised text (`docs/intelligence-platform.md` line 139).
- Effect of the Hermes plan: Hermes keeps its own long-term memory per `X-Hermes-Session-Key`
  (api-server.md line 762). For Hermes coworkers, this gap matters only for memories OpenBot itself
  stores.

### Gap 2: Multiple instances and HA

- Doorbell pattern: `1123786563/OpenBot` `7f1562c1` (TurnLock and TurnEventBus) plus `ce3e2645`
  (an ioredis port with a "require" mode guard). Verdict: borrow the idea and use `pg_notify`.
  NOTIFY payloads are capped at 8,000 bytes, so ids-only messages are the right shape anyway.
- `codaswin/Brooklyn` `d31e60af` replaces an `externallyLocked` flag with an idempotent lock
  re-acquire. That is relevant if the thread lock moves to Postgres advisory locks. Verdict: borrow
  the idea. Size: S.
- No fork runs the Phoenix gateway across replicas. The other in-process state in the server
  (channel sockets, routines) was not audited here.

### Gap 3: Trajectories, annotations, error envelope, tombstones

- No fork persists trajectories. `1123786563/OpenBot` sends model and tool spans to Opik, a
  tracing service (dozens of `opik` commits, for example `b21d255c`, `f00872e3`). Verdict: skip.
  It is too large and coupled to that fork's billing and tenancy.
- Recommended: write the `trajectory:` topic events the gateway already relays into one
  append-only table, keyed by thread and run. Size: S. Annotations can share that table. No fork
  has the hosted error envelope or tombstones.

### Gap 4: Learning engine

- No fork implements `POST .../runs`. Verdict: skip. Hermes coworkers learn inside Hermes, which
  has its own skills and memory, so the engine only matters for OpenBot-native Bots.

### Gap 5: Backup, health, metrics

- Backup: `MrZealman/openbot` `75c42159` (above). The Hindsight `backup.sh` in `2ce901b8` uses a
  flock-plus-PID lock and a retention window of 1–30 days. Verdict: borrow the idea.
- Health: myduet has only liveness (`server/src/app.ts` line 481 returns `{status:"ok"}`).
  `1123786563/OpenBot` `62ee6a43`/`acd78f4a` show that a readiness latch must re-arm after a
  cooldown, otherwise one failed probe during an outage reports not-ready for the life of the
  process. Recommended: a `/ready` route that checks the database and calls each Hermes server's
  authenticated `/health/detailed` (api-server.md lines 456–470). Size: S.
- Metrics and traces: myduet exports audit rows as OTLP logs only (`docs/configuration.md`
  line 644). `1123786563/OpenBot` `a7022b7b` adds an OTel trace context helper (`shared/trace.ts`,
  125 lines) and initialises tracing in the server. Verdict: borrow the idea. Size: S–M.

### Gap 6: Bridging Hermes (OpenAI-compatible) into OpenBot's AG-UI model

- **Template:** upstream `agent-dsh` (rank 1). `cgallic/OpenBot` `e5251940` raises Bun's
  `idleTimeout` to 120 s for remote agent streams. myduet handles Bun's 10 s idle limit per route
  instead (`server/src/browser/routes.ts` line 139). The bridge should keep emitting AG-UI events
  while Hermes is quiet, because Hermes only sends `: keepalive` comments every 10 s.
- **Client-side tools (OpenBot browser):** Hermes does not accept caller-defined tools (see
  "Hermes facts"). Browser tools with an `execute` follow the AG-UI client round-trip
  (`server/src/copilot.ts` lines 1384–1395), which Hermes cannot take part in. Options, best first:
  1. Let Hermes use its own tools inside its own sandbox. State plainly that this bypasses
     OpenBot's audit, as `agent-dsh` does.
  2. Point Hermes at a governed browser over CDP (`browser.cdp_url`, api-server.md line 381). Note
     that this also skips OpenBot's per-action policy.
  3. Use the MCP proxy pattern (rank 7). It covers deployment tools (MCP grants, `message_bot`,
     `ask_person`) through `/api/agent-tools/call`, not surface-drawn tools.
- **Approvals:** Hermes streams `event: approval.request` and resumes on
  `POST /v1/runs/{completion_id}/approval` (`gateway/platforms/api_server_openai_routes.py`
  lines 797–811 and 1186–1187; api-server.md line 656). Hermes MCP servers marked
  `trust: untrusted` trigger the same prompt for every write tool. Mapping this onto OpenBot's
  approval UI is the open design question. No fork bridges an external agent's approval.
  `Ascentwright-Capital/OpenBot` `f12b63ed`/`c78daea9` only show late-approval edge cases for
  OpenBot's own approvals.
- Other agent adapters in forks: `faulknerpearce/OpenBot` `9b63ee8f` (`agent-acp/`, a bridge for
  ACP, the Agent Client Protocol, plus `agent-claude-code/`, +9,564 lines) and
  `itsablabla/OpenBot-jada` (`agent-droid/`, ACP transport `acp.py`). Hermes ships an ACP adapter
  (`acp_adapter/` in hermes-agent), so an ACP-based bridge is possible. Verdict: skip in favour of
  the HTTP Responses API. ACP is stdio-oriented and needs the bridge to run beside each Hermes
  install.

### Gap 7: Per-user routing to separate agent servers

- Built-in: one coworker per endpoint, a write-only auth header, and publication to named people
  or groups (`docs/coworkers.md`). Hermes side: one gateway can serve many profiles under
  `/p/<profile>/`. Each profile has its own `API_SERVER_KEY`, and runs are scoped to the profile
  (api-server.md line 795). So "N users on 5 servers" can be "one Hermes profile and one OpenBot
  coworker per user", with a private key each.
- Passing the OpenBot user into Hermes: the bridge sees only AG-UI input. The person is named
  inside the signed `forwardedProps.openbotRun` (`server/src/agents/callback-token.ts`). Whether
  that assertion is readable without the signing key was not checked. Sending
  `X-Hermes-Session-Id = threadId` scopes transcripts per thread. Per-user memory needs
  `X-Hermes-Session-Key`, or the one-profile-per-user layout.
- No fork does per-user routing. `cgallic/OpenBot` (`a4478538`, `71984fe5`) isolates fleet
  endpoints on a tailnet with a pinned bridge subnet. That is useful as a network pattern for 5
  Hermes hosts. Verdict: borrow the idea.

### Other company-relevant ideas

| Idea | Source | Verdict | Size |
|---|---|---|---|
| Titles in the user's language | `ayakolin/OpenBot` `e6bda2ed` | adopt (cherry-pick) | S |
| i18n layer, locale preference | `ayakolin/OpenBot` `13773a3b` | adopt (cherry-pick) and add `vi` | M |
| Per-conversation model selector, admin-gated | upstream branch `codex/openbot-model-selector` (`374f48d5`..`6316d7d7`, 6 ahead, 17 behind) | borrow the idea (an upstream branch; wait for it to land) | M |
| DeepSeek / OpenAI-compatible base URL for the shipped Bots | `TBROS68/OpenBot` `fbae6e51` (+132) | borrow the idea if an internal LLM gateway is used | S |
| Unknown provider crash in per-agent overrides | `rudolph-46/OpenBot` `1560f264` | borrow the idea (check whether myduet offers those providers) | S |
| Slack through OpenTag, with approval buttons | `Ascentwright-Capital/OpenBot` `fe4d7353`, `f12b63ed` | skip unless Slack is in scope | M |
| Push notification when a Bot is blocked (APNs/FCM) | `mahdi-salmanzade/OpenBot` `8dc622d9` | skip (573 behind) | M |
| VPS installer, Caddy TLS | `TBROS68/OpenBot` `7287bf55`, `11c11964` | skip (the Helm chart exists) | S |
| Opt-in hosted Intelligence memory | `m3ta-a3y3-inT3LLiG3nc3/openbot-tmw` `f6211561` | skip (memory is local now) | S |

## Hermes Agent integration facts

Source: `NousResearch/hermes-agent` (MIT, `main` at `7020ea3e`). "api-server.md" means
`website/docs/user-guide/features/api-server.md`, and "routes.py" means
`gateway/platforms/api_server_openai_routes.py`.

- **AG-UI support: none.** The 23,133-path tree has no `ag-ui`, `agui` or `copilotkit` paths.
  Issue #10689 ("Supports integration with CopilotKit", opened 2026-04-16) is open with no reply
  (https://github.com/NousResearch/hermes-agent/issues/10689).
- **Client-defined `tools`: not supported.** In Chat Completions, `tools` and `tool_choice` appear
  only in the idempotency fingerprint (routes.py line 1012). The agent's run arguments omit them
  (routes.py lines 948–958). `finish_reason` is only `stop`, `length`, `error` or `cancelled`,
  never `tool_calls` (routes.py lines 77–89). The docs say the agent "handles requests with its full
  toolset … and returns the final response" (api-server.md line 11). Hermes runs its own tools and
  returns no tool calls for the caller to run.
- **Tool visibility:** Chat Completions emits `event: hermes.tool.progress` frames
  (`toolCallId`, `tool`, `status` running or completed; routes.py lines 970–986 and 1176–1179).
  The Responses API emits spec-native `function_call` and `function_call_output` items and
  `reasoning` items (api-server.md lines 218–224). That makes `/v1/responses` the better source for
  completed AG-UI tool calls.
- **Session and user identifiers:** `X-Hermes-Session-Id` (the transcript; without it, a session
  is derived from the system prompt and first message, api-server.md line 155),
  `X-Hermes-Session-Key` (the stable long-term memory scope, at most 256 characters, line 762),
  `previous_response_id` and `conversation` on Responses, and `session_id` on `/v1/runs`. There is
  no per-request user field. Users are separated by profile and key under `/p/<profile>/`
  (line 795).
- **Streaming:** SSE on every surface, with a `: keepalive` comment after 10 s of silence
  (api-server.md line 216). `/v1/runs/{id}/events` supports attaching and detaching (line 537).
- **Approvals:** `approval.request` SSE event, `POST /v1/runs/{id}/approval` with
  `{request_id, execution_generation, choice}`, advertised as `run_approval` in
  `/v1/capabilities` (api-server.md line 656; routes.py lines 797–811).
- **Auth and health:** `API_SERVER_KEY` is a required bearer token, even on loopback. `/health` is
  cheap liveness. `/health/detailed` is authenticated readiness (api-server.md lines 456–470).
  Idempotency keys are available on runs, Chat Completions and Responses (line 79).
- **Existing third-party adapters:** a GitHub search found no AG-UI ↔ OpenAI-chat or AG-UI ↔
  Hermes adapter. `daniprol/ag-ui-openai` (1 star) targets the OpenAI Agents SDK. Hermes web UIs
  such as `1941s/hermes-agent-ui` speak Hermes' own API. The official AG-UI repo
  (`ag-ui-protocol/ag-ui`, MIT) has a `vercel-ai-sdk` integration. Pointing it at Hermes through an
  OpenAI-compatible provider would stream text but lose Hermes' tool events, so `agent-dsh` is the
  better base.

## Fork table

Method: listed 1,118 forks (`gh api repos/CopilotKit/OpenBot/forks --paginate`). 243 had
`pushed_at > created_at` and were compared with `compare/main...{owner}:{default_branch}`. 56 are
ahead (the earlier scan found 54). Six compares failed: 5 return 404 (deleted or private) and
`darbotlabs/Darbot` has no common ancestor. Non-default branches were checked for `lennartschoch`,
`1123786563`, `jerelvelarde`, `ayakolin`, `codaswin`, `itsablabla`, `Ascentwright-Capital`,
`MrZealman`, `matthewdillon-commits` and `m3ta-a3y3-inT3LLiG3nc3`. Most of the extra branches on
`lennartschoch` and `jerelvelarde` are upstream branches. Every fork named below is MIT.

| Fork | Ahead / behind | Content | Verdict |
|---|---|---|---|
| `1123786563/OpenBot` | 3157 / 591 | Chinese enterprise rebuild: Casdoor SSO, tenancy and billing, Hindsight memory, Opik, Redis bus, OTel, Go runtime (`runtime-go/`) | borrow ideas (bus, trace helper, health latch). Not cherry-pickable. |
| `lennartschoch/OpenBot` | 50 / 1 | local Intelligence (already adopted); 6 new release/CI commits | skip the new commits |
| upstream branch `claude/deepseek-harness-adapter-cl4cp8` | 2 / 585 | `agent-dsh` self-tooling agent → AG-UI | borrow the structure (rank 1) |
| `ayakolin/OpenBot` | 18 / 39 | i18n layer, zh-CN, titles in the user's language, wait for Postgres before migrating | adopt `13773a3b`, `e6bda2ed` |
| `MrZealman/openbot` | 39 / 580 | local edition: encrypted storage, device pairing, backup and restore | borrow the backup idea |
| `itsablabla/OpenBot-jada` | 7 / 147 | Factory Droid harness, MCP tool bridge, ACP | borrow the MCP proxy idea |
| `faulknerpearce/OpenBot` | 1 / 428 | ACP and Claude Code bring-your-own harness | skip (stale, stdio) |
| `codaswin/Brooklyn` | 42 / 30 | `PostgresAgentRunner`, idempotent lock re-acquire | borrow the lock idea |
| `cgallic/OpenBot` | 11 / 409 | company fleet tenant, tailnet isolation, stream idle timeout | borrow the network and keepalive ideas |
| `matthewdillon-commits/OpenBot2` | 133 / 539 | org multi-tenancy, CRM, Composio, Tavily | skip |
| `jerelvelarde/openbot` | 112 / 428 | managed Slack channel, Bot templates | skip |
| `Ascentwright-Capital/OpenBot` | 23 / 20 | DigitalOcean kit, Slack via OpenTag, approvals in Slack | skip unless Slack is in scope |
| `TBROS68/OpenBot` | 5 / 563 | DeepSeek provider, VPS installer, Caddy TLS | borrow the provider idea if needed |
| `rudolph-46/OpenBot` | 10 / 280 | skills discover tab, model picker fix, dashboard | borrow the provider-crash fix idea |
| `scrya-com/OpenGrokBot` | 1 / 459 | Grok Build OIDC | skip (SSO exists) |
| `m3ta-a3y3-inT3LLiG3nc3/openbot-tmw` | 6 / 32 | opt-in hosted memory | skip |
| `mahdi-salmanzade/OpenBot` | 6 / 573 | phone companion, APNs/FCM | skip |
| `Dreydrey9000/OpenBot` | 2 / 165 | per-Bot approval levels, phone pairing | skip |
| `duke1str/OpenBot` | 67 / 176 | tenant package, Windows and Ollama scripts, Cua MCP transport | skip |
| `Halewwang/EagerBot` | 43 / 290 | zh localization (hard-coded), sync handoff docs | skip (ayakolin's layer is better) |
| `bitcloud-labs/openbot`, `julien2613/OpenBot`, `matheussl22/openbot`, `bryangarcia831/openbot`, `opndrm/OpenBot`, `mariodelgado/tinybot` | ≥409 behind | standalone boot, local threads, product rebrands | skip (stale, as the earlier report found) |
| `ocodista/free-bot`, `hugolapicamiravet-hue/openbot`, `shrideep-tamboli/OpenBot`, `MrKaizen7/OpenBot`, `kampeynco/OpenBot`, `ZMAWline/OpenBot`, `plutospp/OpenBot`, `loupsatoshi/OpenBot`, `findigital/OpenBot`, `HaipingShi/OpenBot`, `agnx-lab/OpenBot`, `Solizardking/SolanaBot`, `TiagoAlmeidaS/cortex-bot`, `Bala-BSD/OpenBot`, `PythonLearn5/OpenBot`, `hardik-kgp/OpenBot`, `kytelc-ux/openbot` | 1–16 ahead | desktop local mode, Ollama, local Chrome, Railway, Tailscale install, Windows script, OpenRouter, product packages | skip (single-machine or product-specific) |
| 19 others (`G356`, `saxster`, `nwabisamasoka`, `ayhan139106206`, `bab321-AI`, `HermesUi325`, `alessandropcostabr`, `EmilynnJ`, `Malikkewebsite`, `lllTheGodlll`, `danieliudi`, `hoangkien07051`, `erbhardwaj11`, `MantisShrimpdev`, …) | 1–17 ahead | CI, Docker publish, sync workflows, uploads, `.DS_Store`, one aria fix | skip (noise) |

## Limitations

- Forks with `pushed_at <= created_at` were assumed to be 0 ahead and were not compared.
- For `1123786563/OpenBot`, only commit headlines (3,159 of them) and six key commits were read.
  Its i18n, Casdoor and Go runtime were not evaluated in depth.
- Hermes behaviour was read from source and docs. It was not run, and its exact wire shapes can
  change, since the repo is very active.

## Unresolved questions

1. Is it acceptable that Hermes coworkers act outside OpenBot's policy and audit (their own
   sandbox), or must every browser and file action go through the OpenBot gateway? The answer
   decides whether rank 7 (the MCP proxy) is needed before launch.
2. Which layout do you want: one Hermes profile per user (`/p/<user>/`, a key each, and a coworker
   per user per server), or shared profiles with `X-Hermes-Session-Key` per user? The second needs
   the bridge to learn the person's identity, possibly through a small server change that forwards
   it.
3. How should a Hermes `approval.request` appear in OpenBot's UI? Options include an AG-UI custom
   event, an interrupt, or a synthetic `ask_person`-style tool, and none of them has prior art.
4. Is the Helm chart the deployment path? If so, `replicaCount` must drop to 1 now.
5. Which embedding model and endpoint should semantic recall use? It must be multilingual and
   self-hosted, given the no-cloud goal.
