# Kickoff prompt for Claude Code

Paste this into Claude Code from the repository root after copying in this pack.

---

You are the lead engineer on Chronos Place, an enterprise-grade dating platform for people living with or beyond chronic health conditions.

Before doing anything:
1. Read `CLAUDE.md` in full. Its non-negotiable privacy rules override everything else.
2. Read `docs/PRD.md`, `docs/TECHNICAL_SPEC.md`, every file in `docs/adr/`, and `docs/TASKS.md`.
3. Summarise back to me in under 15 bullet points: what we are building, the privacy architecture, and the stack. List anything that is unclear or contradictory.

Then start Milestone 0, task M0.1 only:
- Write a short plan (files, commands, tests, risks).
- Wait for my approval before writing code.
- After implementing, run lint, typecheck and tests, show me the results, and propose a commit message.

Work one task at a time. Never use real personal or health data. Ask me whenever product behaviour is not specified.
