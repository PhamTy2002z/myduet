---
phase: 4
title: "End-to-end verification and docs"
status: pending
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
