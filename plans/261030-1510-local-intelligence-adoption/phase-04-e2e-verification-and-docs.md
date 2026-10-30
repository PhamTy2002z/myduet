---
phase: 4
title: "End-to-end verification and docs"
status: completed
priority: P1
effort: "2h"
dependencies: [2, 3]
---

# Phase 4: End-to-end verification and docs

## Goal
Prove in the running app that chat, browser tools, a component and approvals work with no
CopilotKit account, and leave a short operator note.

## Tasks & Steps
1. Full test suite against the dedicated test DB (`TEST_DATABASE_URL` on 127.0.0.1:5434); compare
   with the adopted baseline.
2. UI (Chrome): General Assistant opens a public site, reports something visible, draws a chart;
   a `computer_click` team rule raises an approval card; Deny stops the run; remove the rule.
3. Reopen the conversation after a server restart: history reloads from Postgres.
4. Port binding + LAN refusal check; server log has no `copilotkit.ai` calls.
5. Docs: README top note for myduet (what differs from upstream, how to run on a Claude plan),
   `docs/configuration.md` entries for new variables. Update the research report's Forks section.

## Verification
- Test summary (pass/fail counts) recorded in the phase report.
- Screenshots saved and paths reported.

## Success Criteria
All plan-level success criteria checked.

## Result (2026-10-30)

UI (Chrome, no CopilotKit account, built-in Bots on the Claude plan, model `claude-sonnet-5-5`):
- General Assistant opened news.ycombinator.com in its own browser, reported the top 3 with points
  and drew a bar chart.
- History (including the chart) reloaded after a server restart.
- Team rule `computer_click` → approval card; **Allow once** executed the click
  (`approval_requests` consumed, result `ok:true`); the resumed turn's next click raised a second
  approval on the Bot's "Needs you"; **Deny** recorded. Rule removed afterwards.

Bug found and fixed: the built-in platform answered `GET …/messages` with AG-UI tool calls
(`{function:{name,arguments}}`); server-side readers expect the hosted `{id,name,args}`, so every
computer action under an approval rule was refused ("That unanswered tool call is not saved").
`hostedMessage` in `server/src/intelligence/messages.ts` + integration test.

Also: CopilotKit runtime telemetry was on (the only `copilotkit.ai` reference in the server log);
`.env.example` now ships `COPILOTKIT_TELEMETRY_DISABLED=true`; after restart the log has none.
Platform REST refuses requests without the key (401). Loopback-only listeners, LAN refused.

Independent review (code-reviewer) found: `stop.sh` stopped nothing without a picked harness
(critical, fixed + verified); loopback default breaks Docker Bot callbacks on Linux (now
macOS-only default, documented); key generation ignored a hosted URL (fixed); image could bind its
own loopback via `--env-file` (pinned in the s6 API run script); empty `MANAGED_AGENT_AG_UI_URL`
exported when sample Bots are skipped. Not fixed (edge): a placeholder key exported in the shell.

Known limitation (upstream, not this plan): with the Claude-plan harness, a resumed turn that
suspends on a second approval ends the harness's live Claude query; the queue then retries the
continuation 5 times ("query no longer running") and stops. The second approval still appears and
can be decided; the conversation does not get a follow-up line.

Test note: a local `.env` with `CLAUDE_CODE_OAUTH_TOKEN`/`PICKED_HARNESS_*` makes
`openai-compatible-endpoint.test.ts` fail (Bun loads `.env`; built-in Bots route to the harness).
Run the suite with those cleared, as CI does.

Full suite (plan variables cleared): 10,804 pass, 127 skip, 12 distinct failures — the same 12 that
fail on untouched upstream `main` (agent-bot build, Recorder/Playwright browser, real-provider
learning tests). Baseline was 10,800 pass; the 4 extra are this plan's new tests.
