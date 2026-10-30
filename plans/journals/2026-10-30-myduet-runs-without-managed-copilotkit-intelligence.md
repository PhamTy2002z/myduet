---
title: myduet runs without managed CopilotKit Intelligence
date: 2026-10-30
summary: "Adopted lennartschoch/OpenBot's built-in Intelligence platform, fixed its tool-call message shape, hardened start/stop for loopback, platform key and Claude-plan harness"
---

# myduet runs without managed CopilotKit Intelligence

## What happened
- Goal: run the OpenBot fork `myduet` with no CopilotKit cloud account, multi-user safe.
- Fork scan (1,071 of 1,108 forks, 54 ahead): `lennartschoch/OpenBot` serves the Intelligence REST API
  and Phoenix gateway inside the API server over Postgres, verified against runtime 1.83.0, per-owner
  thread scoping. `codaswin/Brooklyn` (SSE + PostgresAgentRunner) is single-user only. Adopted the
  former on branch `adopt-local-intelligence` (fast-forward; reverted its registry/badge commits).
- Plan `plans/261030-1510-local-intelligence-adoption` (4 phases) executed and closed.

## Root causes found
- Built-in platform answered `GET /api/threads/:id/messages` with AG-UI tool calls
  (`{function:{name,arguments}}`); `approvals/wiring.ts savedToolCall` and `toolkit/src/run-turn.ts`
  expect hosted `{id,name,args}` → every approved computer action refused ("That unanswered tool call
  is not saved"). Fixed with `hostedMessage` in `server/src/intelligence/messages.ts` + test. The
  platform's 2,332-line suite never asserted tool-call shape.
- Review caught `stop.sh` passing `--profile harness` unconditionally: with `PICKED_HARNESS_IMAGE`
  empty compose rejects the project and stderr was discarded → nothing stopped.
- CopilotKit runtime telemetry was on by default (only `copilotkit.ai` in the server log).

## Changes
- `BIND_HOST` (config + http-server + Vite); `start.sh` defaults loopback on macOS only (Linux
  Docker Bots reach the host via the bridge gateway); image pins 0.0.0.0 in its s6 API run script.
- `start.sh` replaces the placeholder platform key once (built-in platform only); skips
  setup-learning on the built-in platform; `SKIP_SAMPLE_BOTS`; builds/starts/waits for the in-tree
  Claude Agent SDK harness; `ANTHROPIC_MODEL` passthrough. `stop.sh` downs the harness profile.
- `.env.example` ships `COPILOTKIT_TELEMETRY_DISABLED=true`.

## Verification
- Live: no CopilotKit key, licence valid, Bots answer on the Claude plan (`claude-sonnet-5-5`),
  browser + chart, history after restart, approval allow/deny, loopback-only, LAN refused.
- Full suite: 10,804 pass; 12 failures identical to untouched upstream `main` (environment).

## Known limits / next steps
- Single instance (platform's documented ceiling).
- Claude-plan harness: a resumed turn that hits a second approval ends the live query; queue retries
  5× then stops (upstream behaviour).
- A local `.env` with plan variables breaks `openai-compatible-endpoint.test.ts`; run tests with
  them cleared.
- Not pushed (repo is public). Hermes integration not started.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
