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

## Addendum: static log messages (`chronos/static-log-messages`)
The redacting logger masks field names and scrubs recognisable values, but the message text is free text in every mode, including `allowlist`. A health string interpolated into a message, or planted under a harmless field name, therefore reached the logs. `packages/eslint-config/rules/static-log-messages.mjs` closes the message half of that gap: in `services/`, `restricted/`, `apps/` and `packages/service-kit/src`, the message passed to `trace`/`debug`/`info`/`warn`/`error`/`fatal` must be a literal or a same-file `const` string.

**How errors are logged:** error text never goes in the message. Pass the error in the fields object (`logger.error({ err }, 'request failed')`), where the logger redacts it, and in allowlist mode never writes error messages or stacks. Like the boundary rule, it cannot be disabled inline.

**Limits:** the rule cannot see through a logger held under an unrelated name or passed as a parameter named otherwise, and it does not check field values. A health string under a harmless field name (e.g. `detail`) is still written in `redact` mode; the privacy harness covers that, not lint.
