# agent-hermes

Puts Nous Research [Hermes Agent](https://github.com/NousResearch/hermes-agent) profiles in myduet
as coworkers. Each person gets their own Hermes profile and their own coworker. Every side effect
Hermes takes goes through myduet's governed tools, so grants, policy and the audit trail apply.

```
myduet ──AG-UI──▶ /c/<route> ──/v1/runs──▶ Hermes profile
                                            │ (its model reaches for a tool)
myduet ◀─/api/agent-tools/call── /mcp/<route> ◀──MCP── Hermes profile
```

- **Conversation:** myduet POSTs an AG-UI run to `/c/<route>`. The bridge creates a Hermes run with
  `session_id` set to the thread, so Hermes keeps the transcript. It then streams Hermes' events
  back as AG-UI. Hermes' own tool calls appear as completed steps.
- **Tools:** Hermes ignores tools a caller sends, so myduet's tools reach it as a remote MCP
  server at `/mcp/<route>`. A call is allowed only while that coworker has a run in progress, and
  only for a tool that run was given. The call goes to `/api/agent-tools/call` with the coworker's
  callback token and the run's signed assertion.
- **One run at a time per profile.** Hermes sends nothing per conversation to an MCP server, so
  the bridge holds the in-progress run for each profile. A second conversation with the same
  coworker waits up to 60 s, then gets an error.
- **Approvals:** governed tools carry myduet's own approval. If Hermes asks for approval itself, the
  profile is doing something it should not, such as running a native tool that was left enabled.
  The bridge declines the request and shows it as a step.
- **Stop:** when the person stops a run, the bridge calls `POST /v1/runs/{id}/stop`. In Hermes,
  closing the stream alone does not stop the turn.

Wire details: [Hermes wire spec](../plans/reports/research-261031-0145-hermes-wire-spec.md), read
from Hermes source at `7020ea3e`.

## Configure

`HERMES_ROUTES_FILE` names a JSON array with one route per coworker. The file holds every
credential the bridge uses. Keep it at mode 600, out of git (`agent-hermes/routes.json` is
ignored), and never paste it anywhere.

```json
[{ "id": "an", "inboundToken": "…", "hermesUrl": "http://hermes-1:8642", "profile": "an",
   "hermesKey": "…", "toolToken": "…", "mcpToken": "…" }]
```

| Field | What it is |
| --- | --- |
| `id` | The route name in `/c/<id>` and `/mcp/<id>` |
| `inboundToken` | What myduet sends. In the coworker's Setup, set header `Authorization`, value `Bearer <inboundToken>` |
| `hermesUrl`, `profile` | The Hermes gateway and the profile it serves under `/p/<profile>/` |
| `hermesKey` | That profile's `API_SERVER_KEY`, at least 16 characters |
| `toolToken` | The coworker's callback token: `POST /api/agents/<id>/callback-token`, shown once |
| `mcpToken` | What the Hermes profile presents to `/mcp/<id>` |

Generate the secrets with `openssl rand -hex 32`.

| Variable | Default | |
| --- | --- | --- |
| `HERMES_ROUTES_FILE` | required | The routes file |
| `OPENBOT_TOOL_URL` | `http://127.0.0.1:3001/api/agent-tools/call` | myduet's governed tool callback |
| `HERMES_MCP_SERVER_NAME` | `openbot` | The name each profile gives the bridge under `mcp_servers:` |
| `HERMES_BRIDGE_DATA_DIR` | `.agent-hermes` (`/data` in the image) | Where each coworker's tool catalog is kept |
| `PORT`, `BIND_HOST` | `4230`, `0.0.0.0` | |

## Each Hermes profile

The gateway needs `gateway.multiplex_profiles: true`. In the profile's `config.yaml`:

```yaml
mcp_servers:
  openbot:
    url: "http://<bridge, reachable from the Hermes host>:4230/mcp/<route id>"
    headers:
      Authorization: "Bearer ${OPENBOT_BRIDGE_TOKEN}"   # = mcpToken, in this profile's .env
    trust: full          # myduet governs every call; Hermes prompting too would ask twice
platform_toolsets:
  api_server: [openbot]  # only myduet's governed tools on the API server
agent:
  disabled_toolsets: [terminal, file, browser, code_execution, web, image_gen, delegation, cronjob, skills, memory, kanban, connections]
```

Check the result with `GET /p/<profile>/v1/toolsets`. It should list only `mcp__openbot__*`
tools and whatever the runtime itself adds.

Hermes loads a server's tool list when it connects and again when the bridge sends
`tools/list_changed`, which the bridge does whenever a run brings a tool it has not seen before.
An agent sees the new list from its next turn onward. So on a brand-new coworker, the first turn may
run without myduet's tools.

## Run

```sh
docker compose --profile hermes up -d agent-hermes   # HERMES_ROUTES_FILE=/path/to/routes.json
bun test                                             # in agent-hermes/
```

Then add the bridge's address to myduet's `AGENT_ENDPOINT_ALLOWED_HOSTS` (for example
`127.0.0.1:4230`). Create the coworker with endpoint `http://<bridge>:4230/c/<route id>` and its
authorization header, and publish it only to the person it belongs to.

## Not yet checked against a live Hermes

Tests replay a stream built from Hermes source, not one captured from a running Hermes. On first
contact with a real profile, capture a stream into `tests/fixtures/`, and check two things.
First, that `tool.completed` really carries no result. The bridge takes the result from its own MCP
endpoint either way. Second, that `session_id` creates a session on first use.
