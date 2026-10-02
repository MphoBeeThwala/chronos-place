# ADR-0012: Restricted-zone boundary enforcement

## Decision
A custom ESLint rule, `chronos/restricted-boundary` (`packages/eslint-config/rules/restricted-boundary.mjs`), enforces ADR-0002. It is a security control, so it is small, dependency-free and tested branch by branch, instead of being configured through `eslint-plugin-boundaries`.

## What it enforces
1. Nothing outside `restricted/` imports from `restricted/`, by path or by package name. Covers `import`, `import type`, `export … from`, `import()`, `require()`, `import x = require()` and `typeof import()`.
2. Code inside `restricted/` imports only Node built-ins, other `restricted/*` packages, and the allow-lists in the rule file (`RESTRICTED_ALLOWED_INTERNAL`, `RESTRICTED_ALLOWED_THIRD_PARTY`).
3. `@chronos/contracts/disclosure` (the generated client) is importable only from the gateway, discovery, identity and moderation services, `packages/contracts` and `restricted/`.
4. Dynamic `import()` and `require()` must take a string literal, except under `tools/`.

## It cannot be switched off
- `eslint-comments/no-restricted-disable` rejects disable comments naming any `chronos/*` rule; `no-unlimited-disable` rejects blanket disables.
- A test fails if any ESLint config other than the root `eslint.config.mjs` exists, so a workspace cannot drop the rule.

## Changing the allow-lists
Adding a package to a restricted allow-list or an importer to the Disclosure client list needs security-owner review, like a schema change.

## Known limits
The rule sees only literal specifiers. Path aliases that resolve into `restricted/` are not supported (none are configured; adding one needs an ADR). CI wiring lands in M0.9; the real `restricted/` tree arrives in M2.1, at which point the fixture tests should be re-run against it.
