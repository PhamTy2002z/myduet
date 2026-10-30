---
phase: 2
title: "Claude-plan model harness in the scripts"
status: pending
priority: P2
effort: "1.5h"
dependencies: [1]
---

# Phase 2: Claude-plan model harness in the scripts

## Goal
A person using a Claude Pro/Max plan (`CLAUDE_CODE_OAUTH_TOKEN`) can run myduet with the official
scripts alone: the harness starts and stops with the stack, sample Bots that need an API key can be
skipped, and the plan model is selectable.

## Context (proven in the ~/Dev/openbot trial)
- Built-in Bots route to the `agent-claude-sdk` harness when `CLAUDE_CODE_OAUTH_TOKEN` +
  `PICKED_HARNESS_IMAGE/URL/PORT` + `MANAGED_AGENT_TOKEN` are set
  (`server/src/agents/plan-model.ts:31-66`).
- `start.sh` hard-waits on `agent-bot` (OpenAI-only) and `agent-langgraph` (needs an API key) and
  never starts the `harness` profile; `stop.sh` never stops it.
- The harness picks Claude Code's default model unless `ANTHROPIC_MODEL` reaches the container.

## Files to Modify
- `scripts/start.sh` — `SKIP_SAMPLE_BOTS` flag (skip both sample Bots and leave
  `MANAGED_AGENT_AG_UI_URL` unset); start `agent-harness` (profile `harness`) when
  `PICKED_HARNESS_IMAGE` is set, build it when it is the local `openbot-agent-claude-sdk` image,
  wait for `/health`.
- `scripts/stop.sh` — also take down the `harness` profile.
- `docker-compose.yml` — pass `ANTHROPIC_MODEL` to `agent-harness`.
- `.env.example` — document `SKIP_SAMPLE_BOTS`, `ANTHROPIC_MODEL`, and the Claude-plan block.

## Tasks & Steps
1. Port the trial patches cleanly (no hard-coded values; read through `setting`).
2. Guard every use of `MANAGED_AGENT_AG_UI_URL` for the unset case.
3. Harness start happens after `MANAGED_AGENT_TOKEN` is ensured, before the server starts.

## Verification
- `bash -n scripts/start.sh scripts/stop.sh`.
- Stack up with `SKIP_SAMPLE_BOTS=true`: harness healthy on 127.0.0.1:4212; `stop.sh` removes it.
- Harness transcript shows the configured `ANTHROPIC_MODEL`.
