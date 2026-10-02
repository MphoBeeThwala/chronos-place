# ADR-0015: Contracts toolchain and Disclosure API design

## Decisions
**Toolchain**
- Protobuf is linted and compatibility-checked with Buf (`STANDARD` lint, `FILE` breaking rules). Breaking changes are checked against the base branch (`pnpm --filter @chronos/contracts contracts:breaking`, wired into CI in M0.9).
- TypeScript is generated with ts-proto using its NestJS option, which produces the controller and client interfaces NestJS gRPC expects. protobuf-es with Connect was considered; it is excellent but integrates poorly with NestJS microservices.
- Generated code is not committed. `contracts:gen` writes to a git-ignored `gen/` folder and runs as part of `build`, `typecheck` and `test`. The `.proto` file is the reviewed contract.
- Only `disclosure/v1` exists now. Other services' protos arrive with their own tasks (contracts first).

**Disclosure API**
- **Uniform denial.** `ViewHealthProfileResponse` carries no reason. "Hidden", "blocked" and "no profile" must look the same to a viewer, otherwise the difference reveals a condition. Reasons are recorded in the audit log only.
- **Filter preferences live in the vault.** The spec said filter settings live in the vault but gave no way to set them, and passed wanted condition codes on every `FilterEligibleSubjects` call. That would put condition interest into discovery's request path, caches and logs (CLAUDE.md rule 3). The API adds `SetFilterPreferences` and `GetFilterPreferences`, and `FilterEligibleSubjects` takes only the viewer and candidate ids. Taxonomy for the picker comes from `ListConditionTaxonomy`, which holds no member data.
- **Lease.** `HealthProfileView.lease_expires_at` implements ADR-0009.
- **Moderation.** `ViewHealthProfile` takes `report_id` and `staff_id` for `PURPOSE_MODERATION`. The Disclosure Service trusts the allow-listed moderation caller's mTLS identity for report validity, records both ids in the audit log, and moderation enforces the open-report check and the time limit. Verifying the report from inside the vault would create a dependency cycle.
- **Account ids only** cross the boundary; the vault id stays inside the restricted zone.
- Request ids and trace context travel in gRPC metadata.

## Consequences
- ts-proto's generated types are plain interfaces, so a later switch of generator is possible but not free.
- The generated disclosure client is the exception in ADR-0002 and is import-restricted by ADR-0012.
- `FilterEligibleSubjects` callers cannot ask ad-hoc "show me people with X" queries; they use the stored preferences. This is intentional.
