# CI, security scans and branch protection

Two workflows run on every pull request and on pushes to `main`. Each ends in a single gate job, and those two gates are what branch protection requires.

| Workflow | Jobs | Gate |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `verify` (lint, typecheck, unit tests, build, banned dependencies), `integration` (local stack, vault isolation, Testcontainers KMS tests, service template image and Trivy), `contracts-breaking` (Buf, PRs only) | **CI gate** |
| `.github/workflows/security.yml` | `semgrep`, `gitleaks`, `osv-scanner`, `trivy-fs`, `checkov` (also weekly, because advisories appear without code changes) | **Security gate** |

## First run

GitHub only registers a workflow once it is on the default branch or a pull request uses it, so the first real run happens when the first pull request is opened (or after the workflows reach `main`). If every job fails within a few seconds with no steps and no logs, the job never reached a runner: check **Settings > Actions** (Actions enabled for this repository) and the account's **Billing** (Actions minutes and spending limit). The job page shows the reason.

## Branch protection (set by a repository admin)

GitHub does not let this be set from the repository, so it has to be configured once in **Settings > Branches > Add branch ruleset** for `main`:

1. Require a pull request before merging; require at least 1 approval; dismiss stale approvals on new commits.
2. Require review from Code Owners (`.github/CODEOWNERS`).
3. Require status checks to pass, and require branches to be up to date: **CI gate** and **Security gate**.
4. Block force pushes and deletion; require linear history.
5. Optionally require signed commits.

Until this is done, a failing check is visible but does not block a merge.

## Conventions

- Third-party actions are not used. The workflows use GitHub's own `checkout`, `setup-node` and `cache`, pinned by commit SHA (Dependabot updates them), and run scanners as plain commands or version-pinned containers.
- Workflows have read-only permissions and use no secrets. Checkouts do not persist credentials.
- No Turborepo remote cache and no telemetry from build tools.
- Semgrep downloads its rule packs from the Semgrep registry (metrics off); source code never leaves the runner. Repo-specific rules live in `.semgrep/`.
- Checkov runs with `--skip-download` so it does not contact its vendor.
- Scanner exceptions: `.trivyignore` (reason, owner and an expiry date for every entry) and `.gitleaks.toml` (narrow allow-lists for synthetic test data). Keep both small.

## Running the checks locally

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm check:deps              # banned analytics, ads, attribution and replay SDKs
pnpm dev:infra && pnpm test:infra && pnpm test:integration && pnpm test:service-template
```

## Banned dependencies

`tools/repo-checks/banned-dependencies.json` lists SDKs that phone home (CLAUDE.md rule 7). A package can be allowed only by adding it to `allowed` with the ADR that approves it, and the check fails if that ADR does not exist. Self-hosted PostHog and Sentry are allowed through ADR-0005; session replay and vendor crash reporting stay banned.
