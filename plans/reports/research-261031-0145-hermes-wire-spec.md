# Hermes Agent wire spec for the `agent-hermes` bridge

Date: 2026-10-31. Source: `NousResearch/hermes-agent` at `7020ea3e96c3fdbc768c5296493e186df46f075b` (read via `gh api`, never executed).
Citation form: `path:lines` at that SHA. "Doc" means `website/docs/...` at the same SHA; doc claims are weaker than source and are flagged when they disagree.

## Bottom line

- **Use `/v1/runs`, not either OpenAI endpoint.** `POST /v1/runs` returns a `run_id`. `GET /v1/runs/{id}/events` is a replayable SSE stream with `id:` sequence numbers. `POST /v1/runs/{id}/stop` and `/approval` work on a durable run id. Of the two endpoints you asked about, Chat Completions is second best. Responses is unsuitable because it never streams approval prompts.
- **Every `hermes gateway` process runs in "canonical" mode**, meaning a durable per-session admission queue (FIFO). `gateway/run_bootstrap.py:784-790` always calls `initialize_gateway_runtime`, which registers `runner.session_authority` (`gateway/run_runtime.py:196-198`, `gateway/session_authority.py:1497-1498`). The canonical code paths change approval bodies and cancellation, and the docs mostly describe the older "legacy" behaviour.
- **Closing the SSE connection does not stop a canonical turn.** Cancellation has to be an explicit `POST .../stop`.
- **Hermes sends nothing per-session to an MCP server.** It opens one shared HTTP connection per server per profile. Static headers are rendered at connect time, and calls are serialized per server. The bridge cannot tell from an MCP call which AG-UI run made it, unless each user gets their own profile.

Prior findings from `research-261031-0052-fork-ideas.md`: all six are confirmed, with corrections. Approvals in canonical mode need `request_id` plus `execution_generation`, not just `choice`. `/health` also returns `platform` and `version`. `X-Hermes-Session-Id` is honoured only by Chat Completions, not by Responses.

---

## 1. Which endpoint, request shape, and SSE sequence

### 1.1 Ranking

| Criterion | `/v1/runs` (recommended) | `/v1/chat/completions` stream | `/v1/responses` stream |
|---|---|---|---|
| Approval prompt on the stream | Yes, `approval.request` plus `approval.settled` | Yes, `event: approval.request` | **No.** There is no `__approval__` handler (`api_server_openai_routes.py:545-551`) and `_handle_responses` passes no `approval_notify_callback` (`:1438-1441`) |
| Cancel | `POST /v1/runs/{id}/stop`, durable | `POST /v1/runs/{chatcmpl-id}/stop`, only while the request is open | No run alias, so no stop |
| Reconnect/replay | `Last-Event-ID` or `?last_seq=`, 1000-event backlog (`api_server_runs.py:167,1272-1316`) | None | None |
| Tool args/results on the wire | `preview` only (see 1.2) | None: name, label, id, status | Full args and result |
| Session continuity | body `session_id` | `X-Hermes-Session-Id` header | `previous_response_id` / `conversation` / `X-Hermes-Session-Key` only |
| Event name location | JSON field `event`; the frame has **no** `event:` line | `event:` line for custom events only | `event:` line on every frame |

The bridge needs approvals, stop, and resumable streams more than tool payloads. MCP tool calls land on the bridge's own MCP endpoint, so the bridge already sees their full args and results there. That leaves `/v1/runs` as the clear first choice.

### 1.2 `/v1/runs` (chosen)

**Auth:** `Authorization: Bearer <API_SERVER_KEY>`, checked on every route (`api_server.py:1414-1436`, `:3881` decorator `_admit_api_agent_request`, `api_server_runs.py:1227,1254`). A failure returns 401 with `{"error":{"message":"Invalid gateway API key (API_SERVER_KEY)","type":"gateway_auth_error","code":"gateway_auth_failed"}}` (`api_server.py:1408-1412`).

**Create:** `POST {base}/v1/runs`, where `{base}` is `http://host:8642` or `http://host:8642/p/<profile>`.

Headers:
- `X-Hermes-Session-Key` (optional): long-term memory scope. Max 256 characters, no `\r\n\0` (`api_server.py:1656-1675`).
- `Idempotency-Key` (optional): 1-255 visible ASCII characters (`api_server_runs.py:781-785`).

Body fields read by `_handle_runs` (`api_server_runs.py:763-872`, `488-525`):

| Field | Meaning |
|---|---|
| `input` | Required. A string, or a message array. For an array, the last item's `content` is the turn (`:713-723`) and earlier items become history if `conversation_history` is absent (`:517-524`). |
| `session_id` | Optional. Continues that API-owned session, whose history loads server-side (`:801, 834-847`). Without it the session id is the `run_id` (`:836`). A session owned by another surface (CLI, TUI and so on) returns 409 `permission_denied` (`gateway/session_api_turn.py:177-179`; doc `api-server.md:502-512`). |
| `instructions` | Optional. Layered on top of the core system prompt (doc `api-server.md:779`). |
| `conversation_history` | Optional `[{role, content}]`. Authoritative when set; content is coerced to `str` (`:496-506`). |
| `previous_response_id` | Optional. |
| `model`, `provider`, `model_options` | Optional per-request overrides (`:802-803`). |

Caller `tools` are not read anywhere. They appear only in the Chat and Responses idempotency fingerprints (`api_server_openai_routes.py:92-95,1012`).

Response: `202 {"run_id":"run_<32hex>","status":"started","replayed":false}` (`api_server_runs.py:544-550, 822`).

**Subscribe:** `GET {base}/v1/runs/{run_id}/events`, with an optional `Last-Event-ID: <seq>` header or `?last_seq=<seq>` (`api_server_runs.py:1251-1341`).

Framing:
- The first frame is the comment `: open` (`:1302`).
- Each event is `id: <seq>\ndata: <json>\n\n`. The JSON is `{"event": <name>, "run_id", "timestamp", ...fields, "seq": <seq>}` (`:224-226`, `:1289-1292`, `api_server.py:196-202`), encoded with `json.dumps` defaults: ASCII-escaped, `", "` / `": "` separators.
- If the backlog was trimmed, a `replay.truncated` event with `oldest_retained_seq` is sent (`:1303-1311`).
- `: keepalive` is sent after 10 s idle (`:1321-1326`; `api_server.py:174` sets `CHAT_COMPLETIONS_SSE_KEEPALIVE_SECONDS = 10.0`).
- End of stream is the comment `: stream closed` (`:1314,1318,1331`).
- A slow subscriber (queue over 256) is silently disconnected (`:168,1327-1329`). Reconnect with `Last-Event-ID`.

Events in canonical mode. The run is driven by `_execute_run`, canonical branch at `api_server_runs.py:1107-1133`:

| `event` | Extra fields (wire order) | Source |
|---|---|---|
| `message.delta` | `delta` (string) | `:1068-1072` |
| `tool.started` | `tool`, `preview` (argument preview text), `tool_call_id` | `:1117-1119`, `:140-141` |
| `tool.completed` | `tool`, `duration`, `error` (bool), `tool_call_id`, `preview` | `:1121-1124`, `:142-144`, `:386-388` |
| `approval.request` | `kind:"approval"`, `prompt_id`, `execution_generation`, `command`, `description`, `choices`, optionally `edit` | `:1111-1115`; prompt built at `gateway/session_pending_controls.py:18-38` |
| `approval.settled` | `prompt_id`, `execution_generation` | `gateway/session_api_turn.py:397,420-423`; `session_pending_controls.py:62-63,84-85` |
| `clarify.request` / `clarify.settled` | `prompt_id`, `execution_generation`, `question`, `choices`, `multi_select` | `session_pending_controls.py:40-51` |
| `run.completed` | `completed`, `partial`, `interrupted`, optionally `turn_exit_reason` / `pending_steer`, then `output`, `usage`, `runtime` | `:1149-1163`, `:229-248` |
| `run.failed` | the same flag fields, then `error` | `:1152-1154,1180` |
| `run.cancelled` | the same flag fields | `:1150-1151,1165` |
| `run.interrupted` | `error: "Gateway shutdown interrupted the run."` | `:1087-1090` |
| `run.queued` | `message` (owner retiring; the input is saved and must not be resent) | `:1172-1178` |
| `subagent.start` / `subagent.complete` | delegation fields | `:390-400` (legacy path only; see below) |

Canonical-mode gaps. These come from source and the docs do not mention them:
- `tool.completed.duration` is always `0` and `preview` is always `""`. The canonical `_tool_complete` passes neither `duration` nor `result` (`:1121-1124`), so `kw.get("duration", 0)` applies and `_tool_completed_preview(None) == ""` (`:149-153`). The doc claim of a 500-character result preview (`api-server.md:548-555`) holds only for legacy mode.
- `message.interim` (commentary) and `subagent.*` are wired only on the legacy `_create_agent` path (`:1134-1138`). Canonical `observe_api_turn` receives only delta and tool callbacks (`:1127-1129`).
- Native and MCP tools emit identical events. MCP tools are named `mcp__<server>__<tool>`, sanitized and clamped to 64 characters with a hash suffix (`tools/mcp_tool_schema.py:172-182`).

**Poll:** `GET /v1/runs/{id}` returns `{"object":"hermes.run","run_id","status","session_id","model","output","usage","runtime",...}`. Status values are `queued`, `running`, `completed`, `failed`, `cancelled`, `interrupted`, `unknown` (`api_server_runs.py:1244-1248`; `api_server_authority_runs.py:68-82`; doc `api-server.md:518-535`).

### 1.3 Example stream fixture (`/v1/runs/{id}/events`, canonical). Constructed from source, not captured.

Values are invented. Keys, key order, framing and JSON spacing follow the cited source. The `command` text follows the MCP trust-gate message format (`tools/mcp_tool_handlers.py:167-178`), on the assumption that the consent text becomes the prompt `command`. That mapping goes through `tools/approval_prompt.py`, which was not read.

```text
: open

id: 0
data: {"event": "message.delta", "run_id": "run_5f1c9a0e7b2d4c6f8a1b3c5d7e9f0a12", "timestamp": 1761900000.101, "delta": "I'll send that to the ops bot.", "seq": 0}

id: 1
data: {"event": "tool.started", "run_id": "run_5f1c9a0e7b2d4c6f8a1b3c5d7e9f0a12", "timestamp": 1761900001.250, "tool": "mcp__openbot__message_bot", "preview": "message_bot(bot=ops, text=Restart staging)", "tool_call_id": "call_01HZX9", "seq": 1}

id: 2
data: {"event": "approval.request", "run_id": "run_5f1c9a0e7b2d4c6f8a1b3c5d7e9f0a12", "timestamp": 1761900001.262, "kind": "approval", "prompt_id": "apr_7c2e", "execution_generation": 3, "command": "MCP tool 'message_bot' on UNTRUSTED server 'openbot' wants to run. This tool is write-capable (no readOnlyHint=true annotation) and may modify external state.\n\nArguments:\n...", "description": "Server 'openbot' is configured 'trust: untrusted'. Approve to run 'message_bot' once, for this session, or always, or deny to block it.", "choices": ["once", "deny", "session", "always"], "seq": 2}

: keepalive

id: 3
data: {"event": "approval.settled", "run_id": "run_5f1c9a0e7b2d4c6f8a1b3c5d7e9f0a12", "timestamp": 1761900014.880, "prompt_id": "apr_7c2e", "execution_generation": 3, "seq": 3}

id: 4
data: {"event": "tool.completed", "run_id": "run_5f1c9a0e7b2d4c6f8a1b3c5d7e9f0a12", "timestamp": 1761900015.402, "tool": "mcp__openbot__message_bot", "duration": 0, "error": false, "tool_call_id": "call_01HZX9", "preview": "", "seq": 4}

id: 5
data: {"event": "message.delta", "run_id": "run_5f1c9a0e7b2d4c6f8a1b3c5d7e9f0a12", "timestamp": 1761900016.010, "delta": "Done, the ops bot has it.", "seq": 5}

id: 6
data: {"event": "run.completed", "run_id": "run_5f1c9a0e7b2d4c6f8a1b3c5d7e9f0a12", "timestamp": 1761900016.300, "completed": true, "partial": false, "interrupted": false, "output": "I'll send that to the ops bot.Done, the ops bot has it.", "usage": {"input_tokens": 4120, "output_tokens": 96, "total_tokens": 4216}, "runtime": {"provider": "openrouter", "model": "anthropic/claude-sonnet-4", "route_source": "global"}, "seq": 6}

: stream closed

```

Also save these failure fixtures:
- A failed run: `{"event": "run.failed", ..., "completed": false, "partial": false, "interrupted": false, "error": "<redacted text>"}`.
- A stopped run: `{"event": "run.cancelled", ..., "completed": false, "partial": false, "interrupted": true, "turn_exit_reason": "interrupted_by_user"}` (doc `programmatic-integration.md:191`).

### 1.4 `/v1/chat/completions` stream (fallback)

**Request:** `POST {base}/v1/chat/completions` with `{"model":"hermes-agent","messages":[...],"stream":true}` plus optional `provider` and `model_options`. System messages are joined and layered on top of the core prompt. Only `user`/`assistant` roles are kept, and the last message is the turn (`api_server_openai_routes.py:712-733, 881-892`).

A bare `model` without `provider` is ignored unless `direct_model_requests: true` (`api_server.py:270-292`).

Body `metadata` passes into LLM relay metadata only (`api_server.py:295-302`, `agent/turn_facade.py:118-119`). It never reaches tools.

**Headers:**
- `X-Hermes-Session-Id`: the transcript id. History then loads from `state.db` and the body history is ignored (`:899-930`). This requires a configured key (403 otherwise), must be path-safe, max 256 characters.
- `X-Hermes-Session-Key`: memory scope.

Without `X-Hermes-Session-Id`, the session id is derived from the system prompt plus the first user message (`:931-939`). The response echoes `X-Hermes-Session-Id` and `X-Hermes-Session-Key` (`:1141-1153`).

**SSE sequence** (`_write_sse_chat_completion`, `:1155-1247`):

1. `data: {"id":"chatcmpl-<29hex>","object":"chat.completion.chunk","created","model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}` (`:1165-1171`, `:940`).
2. Text: the same envelope with `delta: {"content": "..."}` (`:1188-1191`).
3. Reasoning: `delta: {"reasoning_content": "..."}` (`:1180-1183`).
4. Tool start: `event: hermes.tool.progress` with data `{"tool","emoji","label","toolCallId","status":"running"}` (`:970-979`).
5. Tool finish: `event: hermes.tool.progress` with data `{"tool","toolCallId","status":"completed"}` (`:981-986`). There are no args, results or error flag. Tools whose names start with `_` are hidden, and these events can be disabled with `tool_progress_events: false` (`:1177`).
6. Status: `event: hermes.status` with `{"kind","text"}` (`:843-849,1184-1185`).
7. Approval: `event: approval.request` with data built at `gateway/session_api_turn.py:325-331` and then `api_server.py:90-103`, in this key order:
   - `execution_generation`, `command`, `description`, optionally `edit`
   - `request_id` (= prompt_id), `allow_session`, `allow_permanent`
   - `event:"approval.request"`, `run_id:<chatcmpl id>`, `timestamp`, `session_id`
   - `choices`: by default `["once","session","always","deny"]`, or `["once","deny"]` (`api_server.py:84-87`).

   `approval.settled` is not forwarded on this stream; the sink handles only `approval.request` (`session_api_turn.py:325-326`).
8. Final chunk: `delta: {}` with `finish_reason` set to `stop`, `length`, `error` or `cancelled`, plus `usage: {prompt_tokens, completion_tokens, total_tokens}`. When the finish is not `stop`, the chunk also carries `error: {message, type}` and `hermes: {completed, partial, failed, error, error_code}` (`:1194-1235`, `:77-89`, `:146-151`).
9. `data: [DONE]` (`:1236`).

A mid-stream crash sends `delta: {}` with `finish_reason: "error"` followed by `[DONE]` (`:1240-1246`). An idempotency conflict arrives as an `error` finish chunk on an HTTP 200 stream (doc `api-server.md:100-103`). Keepalive is `: keepalive` every 10 s (`:29-55`).

### 1.5 `/v1/responses` stream (not recommended)

Frames are `event: <type>\ndata: {...,"sequence_number":n}` (`:324-348`). The sequence is:
- `response.created`
- Message text: `response.output_item.added` (type `message`), then `response.output_text.delta` (batched every 50 ms), then `response.output_text.done`, then `response.output_item.done`.
- Tools: `response.output_item.added` with `{type:"function_call", status:"in_progress", name, call_id, arguments}`. On finish, `output_item.done` for the call, then `added`/`done` for `{type:"function_call_output", call_id, output:[{type:"input_text", text}]}`.
- Optionally reasoning-summary events, commentary `message` items with `phase:"commentary"`, and `event: hermes.status`.
- The final event is `response.completed`, `response.failed`, `response.cancelled` or `response.incomplete` (`:416-709`).

It has no approval event, ignores `X-Hermes-Session-Id`, and has no stop endpoint.

---

## 2. Cancelling a run

- **`/v1/runs`:** call `POST /v1/runs/{run_id}/stop` with no body. In canonical mode this calls `stop_run`. A queued admission is cancelled outright. A started admission is interrupted and the response is `{"run_id","status":"stopping","admission_id"}`. An `unknown` admission returns 409 `unknown_execution` (`api_server_runs.py:1492-1508`; `api_server_authority_runs.py:138-167`). The stream later ends with `run.cancelled`.
- **Disconnecting the events SSE** only detaches that subscriber and the run continues (`api_server_runs.py:1338-1340`).
- **Chat Completions, canonical mode:** closing the connection calls `_abandon_agent_task` (`api_server_openai_routes.py:1237-1238`). That function interrupts `agent_ref[0]` only if it is set (`api_server.py:609-624`), and the canonical path never sets it. It also cancels the observer task, but the turn itself runs behind `asyncio.shield` (`gateway/session_api_turn.py:369,378-379`: "Shielding keeps the canonical turn alive past a cancelled request"). **A disconnect does not stop the turn.**

  To stop, call `POST /v1/runs/{chatcmpl-id}/stop` while the stream is still open. The alias exists only during the request: it is registered at `session_api_turn.py:322-323` and removed at `:335-337` (`api_server_authority_runs.py:56-59`).
- **Legacy mode** (not reachable via `hermes gateway`): a disconnect does interrupt the agent, and stop calls `request_hard_interrupt` (`api_server_runs.py:1509-1523`).

## 3. Approvals

**Endpoint:** `POST {base}/v1/runs/{run_id}/approval`, authenticated, owner-scoped (`api_server_runs.py:1356-1408`).

**Canonical body:** exactly three keys. Any other key set returns 400 `invalid_params` (`api_server_authority_runs.py:113-135`):

```json
{"request_id": "<prompt_id>", "execution_generation": 3, "choice": "once"}
```

- `choice` must be one of the prompt's `choices`: `once`, `deny`, `session`, `always` (`gateway/session_pending_controls.py:22-26,95-96`). The legacy aliases `approve`, `approved` and `allow` are **not** accepted in canonical mode; they are mapped only on the legacy path (`api_server_runs.py:1353,1371-1372`).
- Use `prompt_id` from a `/v1/runs` event, or `request_id` from a Chat event.

**Responses:**

| Case | Status and body |
|---|---|
| Success | `200 {"run_id": "...", "status": "resolved" or "already_resolved", "prompt_id": "..."}` (`api_server_runs.py:1411-1418`; `session_pending_controls.py:66-101`) |
| Stale generation, run not started | 409 `stale_generation` (`api_server_authority_runs.py:124-125`) |
| Foreign prompt id | 409 `approval_not_pending` (`:131-132`) |
| Unknown run | 409 `not_found` (`:116-117`) |
| Malformed body | 400 `invalid_params` |

Error envelopes are `{"error":{"message":<code>,"type":"invalid_request_error","param":null,"code":<code>}}` (`api_server_authority_runs.py:18-34`, `api_server.py:741-744`).

The legacy body is `{"choice", "request_id"?, "all"?}`, with response `{"object":"hermes.run.approval_response","run_id","choice","request_id"?,"resolved":n}` (`api_server_runs.py:1371-1408`).

**Timeout:**
- The wait lasts `approvals.timeout` seconds, default 300 (`tools/approval_context.py:305-315`; `tools/approval_gateway_wait.py:49-75,170`).
- When it expires unanswered, the tool returns a denial with `outcome:"timeout"` and reason "timed out without user response ... Silence is not consent." (`tools/approval.py:893-896,551-557`). The command does not run.
- The run continues and the model sees the denial. On `/v1/runs` this shows up as `tool.completed` with `error: true`.
- `approval.settled` is published only when pending controls are next reconciled (`session_pending_controls.py:53-64`). The bridge should run its own timer rather than rely on `approval.settled`.
- The API prompt carries no `timeout_s`, because `prompt_timeout_s` returns `None` for non-local turns (`gateway/local_viewer_events.py:243-258`).
- An interrupt withdraws the prompt with outcome `cancelled` (`tools/approval.py:887-892`).

**What triggers approvals for this bridge:**
- Dangerous-command detection on native tools (moot if terminal and file tools are disabled).
- MCP servers with `trust: untrusted`, for every tool lacking `readOnlyHint: true` (`tools/mcp_tool_handlers.py:123-147,167-178`).
- A declared `spend_limit`.

## 4. MCP client config for a remote server

- **Location:** `mcp_servers:` in the profile's `config.yaml` (`tools/mcp_tool_config.py:690-718`). That is `~/.hermes/config.yaml` for the default profile and `~/.hermes/profiles/<name>/config.yaml` for a named one (doc `api-server.md:802-803`). Secrets for `${VAR}` go in that profile's `.env`.
- **Keys** (doc `mcp-config-reference.md:44-75`):
  - `url`: Streamable HTTP by default; `transport: sse` switches to SSE.
  - `headers`, `timeout` (tool call, default 300 s), `connect_timeout` (60 s).
  - `ssl_verify`, `client_cert`/`client_key`, `enabled`, `lazy`, `keepalive_interval` (HTTP default 180 s), `protocol`, `skip_preflight`.
  - `supports_parallel_tool_calls`, `tools.include`/`exclude`/`resources`/`prompts`, `auth: oauth`.
  - `trust`, `tool_costs`, `spend_limit`.
  - `identity_header: {name, value_from: static|profile, value}` (`tools/mcp_tool_errors.py:245-283`).
- **`trust`:** `full` is the default and never prompts. `untrusted` routes every tool without `readOnlyHint: true` through the approval surface, offering Once, Session or Always. Always is persisted to `command_allowlist` as `mcp:<server>/<tool>`. Unknown values are treated as `untrusted`. YOLO mode and `approvals.mode: off` skip the prompt. The source is the gate at `tools/mcp_tool_handlers.py:123-147` and the doc at `mcp-config-reference.md:72`.
  - Side effect: only `readOnlyHint` tools are retried after the transport session expires. Write tools return `outcome_uncertain` instead (same doc line).
- **Substitution in headers:**
  - `${VAR}` and `${env:VAR}` resolve from the profile's secret scope.
  - The context variables `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}` and `${/}` also resolve (`tools/mcp_tool_config.py:179-181,554-582`).
  - Rendering happens when the config is loaded and connected, never per call.
  - An unresolved `${VAR}` in `url` or `headers` fails the connect, with the variable named (`:585-599`).
  - With `identity_header`, `value_from: profile` sends the profile name, resolved once at connect time (`mcp_tool_errors.py:260-263`).

Example for the bridge, in each profile's `config.yaml`:

```yaml
mcp_servers:
  openbot:
    url: "https://bridge.internal/mcp"
    headers:
      Authorization: "Bearer ${OPENBOT_BRIDGE_TOKEN}"   # from this profile's .env
    identity_header: {name: "X-Hermes-Profile", value_from: profile}
    timeout: 120
    trust: untrusted        # write tools need approval through the run's approval.request
```

## 5. Per-call data sent to a remote MCP tool

Only the static headers go out. Nothing per-session or per-run is added.

- The call site is `server.session.call_tool(tool_name, arguments=args, **extra)` (`tools/mcp_tool_handlers.py:519-522`). `extra` holds only `progress_callback`. When that callback is present the SDK adds `_meta.progressToken`, and nothing else is added to `_meta`.
- `args` are exactly what the model produced (`:699-729`).
- `clientInfo` is the fixed `{"name":"hermes-agent","version":<hermes version>}` (`tools/mcp_tool_transport.py:181-185`).
- HTTP headers are the configured `headers` plus the identity header, computed once per connection (`mcp_tool_transport.py:117-151`).
- The connection is per server per profile. Profiles with identical entries share one connection (doc `multi-profile-gateways.md:584-591`).
- RPCs to one server are serialized behind `_rpc_lock` (`tools/mcp_tool.py:427-429`, `mcp_tool_handlers.py:725`). Concurrent sessions therefore queue on the same server.
- The only per-transport identifier is the Streamable HTTP `Mcp-Session-Id`, and it is per connection, not per Hermes session.

## 6. Tool-list refresh and caching

- **Live refresh:** on `notifications/tools/list_changed`, Hermes re-runs `tools/list` and updates the registry, deregistering only stale names (`tools/mcp_tool_health.py:99-169`). `prompts/` and `resources/list_changed` are ignored (`:117-120`).
- **Effect on running agents:**
  - An agent's tool list is snapshotted when it is constructed (`agent/agent_init.py:1024-1036`).
  - The tool-definition cache key and the gateway agent-cache signature both include `registry._generation` (`model_tools.py:254-277`; `gateway/run_agent_cache.py:54-70`).
  - So a changed list takes effect on the next agent build, normally the next turn, and never mid-turn. This is inferred from the generation-keyed caches; I did not trace a per-turn rebuild end to end.
- **`mcp_schema_cache`:** it is used only for `lazy: true` startup registration. It is stored at `<HERMES_HOME>/cache/mcp_schema_cache.json`, keyed by server name and a fingerprint of `command`/`args`/`url`/`transport`/`tools.include`/`exclude`, and written on every live connect (`tools/mcp_schema_cache.py:22-38,75-94`).
  - Entries never expire unless the server's `tools/list` returned a `ttlMs` hint (SEP-2549) (`:59-72`).
  - Headers are not part of the fingerprint.

## 7. Disabling native side-effecting toolsets while keeping MCP

- **Per-platform list:** `platform_toolsets.api_server: [...]` in `config.yaml`, read by `_get_platform_tools(user_config, "api_server")`.
  - In legacy mode the reader is `gateway/platforms/api_server.py:2216`. In canonical mode it is `gateway/run_turn.py:1016-1017` → `:457-480`, with `platform_key = Platform.API_SERVER.value` (`gateway/run.py:2854-2856`).
  - An explicit list is authoritative (`hermes_cli/tools_config.py:571-581,613-614,488-503`).
  - MCP servers are merged in: if the list names no MCP server, every enabled server is added. If it names some, only those are added. The sentinel `no_mcp` disables all of them (`tools_config.py:733-753`).
- **Global subtraction:** `agent.disabled_toolsets: [...]` applies last, to all platforms in that profile (`tools_config.py:636-642`, `run_turn.py:479`).
- **Default for `api_server`:** `hermes-api-server`, which is the core tools minus `text_to_speech`, `clarify` and `computer_use` (`toolsets.py:193-197`, `11-36`).
- **Side-effecting toolset names** (`toolsets.py:73-153`): `terminal`, `file`, `browser`, `code_execution`, `web`/`search`, `image_gen`, `delegation`, `cronjob`, `memory`, `skills` (because `skill_manage` writes), `kanban`, `connections`, `todo`.

Recommended config for a bridge profile:

```yaml
platform_toolsets:
  api_server: [openbot]          # MCP server name; only this server's mcp__openbot__* tools
agent:
  disabled_toolsets: [terminal, file, browser, code_execution, web, image_gen, delegation, cronjob, skills, memory, kanban, connections]
```

The `agent.disabled_toolsets` line is a guard. `_enable_recently_shipped_toolsets` can auto-add newly shipped toolsets to explicit lists. The set is empty at this SHA, but future releases may populate it (`tools_config.py:431-454`).

Runtime-provided tools outside static toolsets may still appear: memory-provider and context-engine tools appended by the agent (`model_tools.py:227-233`), and `context_engine`, which is kept unless the explicit list is empty (`tools_config.py:622-625`). Verify the result with `GET {base}/v1/toolsets` (`api_server.py:2398-2420`; doc `api-server.md:745-760`).

## 8. Profiles and API keys

- **Enabling profile routing:** set `gateway.multiplex_profiles: true`. Every route is then mirrored at `/p/{profile}/...` (`api_server.py:3974-3976`). An unknown or unserved profile returns 404 (`api_server_profile_prefix.py:49-76`, `api_server.py:1535-1550`).
- **Key source:**
  - Named profiles use `API_SERVER_KEY` from that profile's secret scope (`~/.hermes/profiles/<name>/.env`). It must be usable and at least 16 characters, otherwise the prefix fails closed with 401 (`api_server.py:1390-1405,1418-1427`).
  - The default profile and unprefixed routes use the listener's own key (`:1393-1394`).
  - The comparison is a constant-time bytes compare (`:1428-1434`).
- **Cross-profile isolation:**
  - Run ownership is `sha256(profile || key)` (`api_server_runs.py:419-430`). Every run control and the events stream check `_request_owns_run` and return 404 `run_not_found` on mismatch (`:1207-1233,1258-1259`). Two profiles that share one key value still get different scopes.
  - In canonical mode the run lookup uses the routed profile's own authority and `state.db` (`api_server_authority_runs.py:9-12,52-65`), and ownership is re-checked against the persisted `run_owner_scope` (`gateway/session_api_turn.py:261-277`).
  - The doc matches: "another profile's run id returns 404, never 403" (`api-server.md:808-811`).
  - **Confirmed:** one profile's key cannot reach another profile's runs.

## 9. Health endpoints

- **`GET /health` and `GET /v1/health`:** no auth. Returns `{"status":"ok","platform":"hermes-agent","version":"<ver>"}` (`api_server.py:1556-1558,2267-2269`). The doc shows only `{"status":"ok"}` (`api-server.md:456-458`). `/p/<profile>/health` also works, and a bad prefix returns 404.
- **`GET /health/detailed`:** Bearer auth (`api_server.py:2271-2314`). It returns HTTP 200 even when degraded. Body keys:
  - `status`: `ok` or `degraded`.
  - `readiness`: `{status, checks:{state_db, session_store, config, model, disk, gateway, background_queues:{status, active_api_runs, process_completions, active_delegations}}}`, where each check is `{status, detail?}` (`gateway/readiness.py:18-19,100-122`).
  - `platform`, `version`, `gateway_state`, `platforms`, `api_server`, `metrics_today`, `last_heartbeat`, `active_agents`, `gateway_busy`, `gateway_drainable`, `exit_reason`, `updated_at` (RFC3339 or null), `pid`.
- **`GET /v1/capabilities`:** useful as a startup feature probe, for example `run_approval_response`, `approval_events` and `session_key_header` (`api_server.py:49-81`).

---

## Implications for the bridge

- Drive Hermes through `/v1/runs`: create, then subscribe to events, then send `/approval` and `/stop` as needed. Parse event names from the JSON `event` field, track `id:` for `Last-Event-ID` resume, skip `:`-comment lines, and treat `: stream closed` as end of stream.
- Map AG-UI to Hermes as follows: `threadId` becomes `session_id`. Send `X-Hermes-Session-Key` only if you want memory scoped independently of transcripts. Send the AG-UI user message as `input`. Do not send history when using `session_id`, because Hermes owns the transcript and a non-empty `conversation_history` overrides it.
- Map Hermes to AG-UI as follows:
  - `message.delta` becomes `TEXT_MESSAGE_CONTENT`.
  - `tool.started` becomes `TOOL_CALL_START`, then `TOOL_CALL_ARGS` (only the `preview` text is available), then `TOOL_CALL_END`.
  - `tool.completed` becomes `TOOL_CALL_RESULT` with an error flag. The result body is empty in canonical mode, so take MCP results from the bridge's own MCP handler when needed.
  - `run.completed` becomes `RUN_FINISHED`. `run.failed` becomes `RUN_ERROR`. `run.cancelled` and `run.interrupted` become `RUN_FINISHED` with a cancelled marker.
- For approvals, surface `approval.request` as an OpenBot approval and answer with `{request_id: prompt_id, execution_generation, choice}`. Offer only the prompt's `choices`. Enforce a client timer shorter than `approvals.timeout`, or raise `approvals.timeout`, because silence is a denial after 300 s.
- An AG-UI abort must call `POST /v1/runs/{id}/stop`. Dropping the HTTP connection does nothing to the turn.
- Unit-test fixtures to cover:
  - the stream in 1.3;
  - `replay.truncated`, `run.failed`, `run.cancelled`, `run.queued`;
  - a 409 `stale_generation` approval;
  - a 401 on a wrong profile key;
  - a 404 `run_not_found` across profiles;
  - a 429 `rate_limit_exceeded` with `Retry-After: 1` (`api_server.py:3554-3568`).
- MCP identity is the hard constraint. Calls carry only static, per-connection headers and are serialized per server, so the MCP endpoint cannot attribute a call to an AG-UI run. Options, best first:
  1. One Hermes profile per OpenBot user, each with its own bridge token in that profile's `.env`. Attribute calls by token, or by `identity_header: profile`. Accept that concurrent runs of the same user are indistinguishable.
  2. Allow one in-flight run per profile in the bridge, so "the active run of this profile" is unambiguous.
  3. Do not rely on the model passing a correlation token in tool args.
- Set `trust: untrusted` on the bridge MCP server only if Hermes-side approval is wanted. Otherwise use `trust: full` and keep approval inside OpenBot's `/api/agent-tools/call` policy, which avoids double prompts.
- Lock the profile down with `platform_toolsets.api_server: [<mcp server>]` plus the `agent.disabled_toolsets` guard, and assert the result with `GET /v1/toolsets` at bridge startup.
- Use `/health` for liveness and `/health/detailed` with the key for readiness, keyed on top-level `status`.

## Limitations

- Nothing was executed. The fixture is constructed from source, and exact `usage` keys, `preview` strings and the MCP trust-gate `command` text (whose routing through `tools/approval_prompt.py` was not read) may differ live.
- The legacy (non-canonical) paths are documented only where they differ. They should not occur under `hermes gateway`, but embedded hosts may still use them.
- The per-turn tool-list rebuild (section 6) and the equality of the prompt's `execution_generation` with the admission `generation` (which `respond_run` compares) are inferred, not traced end to end.
- `/api/sessions/{id}/chat/stream` and the gateway WebSocket (ACP-style `prompt.submit`) were not evaluated as bridge transports.

## Unresolved questions

1. Does a live canonical `/v1/runs` stream really emit `tool.completed` with `duration: 0` and an empty `preview`? Verify on first live contact. If so, an upstream issue is worth filing.
2. Does `approval.settled` arrive promptly after an approval times out, or only on the next reconcile? This decides whether the bridge can clear the OpenBot prompt from the stream or must use its own timer.
3. Which user identity model is acceptable: one Hermes profile per OpenBot user, or one shared profile with no per-user MCP attribution? This is a product decision and it determines the MCP auth design.
4. Should Hermes-side approvals (`trust: untrusted`) be used at all, given that OpenBot already gates `/api/agent-tools/call`?

Status: DONE_WITH_CONCERNS
Summary: Wrote the source-cited wire spec. The recommendation is `/v1/runs` rather than either OpenAI endpoint, because canonical mode makes Responses approval-blind and ignores client disconnects.
Concerns/Blockers: Canonical `tool.completed` appears to carry no duration or result preview, and MCP calls carry no per-run identity. Both shape the bridge design and should be checked on first live contact.
