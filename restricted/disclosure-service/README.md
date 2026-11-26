# @chronos/disclosure-service

The only door to the Health Vault (CLAUDE.md rules 1 and 2, ADR-0002). Other services reach health
information only through its gRPC API (`packages/contracts/proto/chronos/disclosure/v1`) and get
back only what the viewer may see.

- **Restricted zone:** it starts with the allow-list logger and **no telemetry** (ADR-0016). The
  kit refuses to start it if tracing was preloaded.
- **Database:** `VAULT_DATABASE_URL` connects as a login in the `disclosure_service` role
  (`restricted/vault-db`). Members appear only by a pseudonymous vault id.
- **Keys:** each member's data key is wrapped by KMS and stored in `vault.subject_keys`. Deleting
  that row is the crypto-shred.

## What it does so far (M2.2 to M2.6)

- `UpsertHealthProfile` saves a member's whole profile, sealed with their data key and bound to
  their vault id. `expected_version` (0 to create) stops two devices overwriting each other:
  a mismatch is `ABORTED`.
- Rules: codes must be active in the condition list, or `other` with the member's own words; no
  duplicates; a status is required; at most 10 conditions; own words and note up to 500
  characters each. Errors use fixed messages and never repeat what was sent.
- `GetOwnHealthProfile` records `account:<id>` / `profile_view` / `allow` / `self` in the access
  log **before** returning anything; if that fails, nothing is returned. A member with nothing
  in the vault gets an empty answer, and no vault id is created for them.
- `ListConditionTaxonomy` lists active entries in label order, "other" last.
- `SetVisibility` (M2.3) sets who may see the profile and the filter opt-in; it needs a profile.
- `ViewHealthProfile` (M2.3) runs the access decision (`src/access/decide.ts`, TECHNICAL_SPEC
  4.2), records it, and only then opens the profile. Allowed views carry a 5-minute lease.
  Until matching exists (M3.1) every view by another member is denied; moderation is denied
  until M5.
- `GrantDisclosure` (M2.4) shares with one viewer: full or conditions only. It needs a saved
  profile and an active, unblocked match with an active viewer; the refusal is the same in every
  case. A scope change ends the old grant and creates a new one. Until matching exists (M3.1)
  every share is refused.
- `RevokeDisclosure` (M2.4) ends the share; the viewer's next request is refused. A view already
  on their screen lasts at most until its 5-minute lease.
- `ListHealthViewers` (M2.4): successful views by other members, newest first, with a count and
  whether the share is still live. Own and moderator views are not listed. Reading it is recorded
  (`self_viewers`).
- `SetFilterPreferences` and `GetFilterPreferences` (M2.6) store and return the conditions a member
  filters for, sealed with their own key: up to 10 active codes, not `other`. An empty list deletes
  them.
- `FilterEligibleSubjects` (M2.6, discovery only) returns account ids of candidates who chose
  "Everyone", opted in, and have any wanted condition. The viewer must share the same way
  (`viewer_not_sharing` otherwise), and fewer than 20 matches return nothing (`below_threshold`).
  Each candidate profile opened is recorded with purpose `filter`.
- Every other call answers `UNIMPLEMENTED` until M2.7.

**Retired conditions:** entries are retired, never deleted. A member who already has a retired
condition keeps it and can still save other changes (that check reads their stored profile, audited
as `self_update`); nobody can newly add it. `ListConditionTaxonomy` returns retired entries only
with `include_retired`, so a member's own profile can still show their label.

## Who may call it

`src/allow-list.ts` (M2.5): callers are identified by mTLS certificate and everything not listed is
refused. The gateway gets the member-facing calls and never the moderation purpose. Moderation
gets ViewHealthProfile with purpose moderation and a report id only. Discovery gets
FilterEligibleSubjects, and identity gets EraseSubject. ExportSubject has no caller until ADR-0025
decision g.

## Configuration

`VAULT_DATABASE_URL`, `VAULT_DATA_KEY_ID` (the KMS key that wraps members' data keys),
`IDENTITY_GRPC_ADDRESS` (default `127.0.0.1:50052`) and, locally, `KMS_ENDPOINT` for the KMS
stand-in.

## Tests

```
pnpm --filter @chronos/disclosure-service test               # unit, with 100% coverage of the access decision
pnpm --filter @chronos/disclosure-service test:integration   # Testcontainers, or TEST_VAULT_POSTGRES_URL
pnpm --filter @chronos/disclosure-service test:privacy       # leakage: logs and gRPC errors
```

Integration tests connect with `-c role=disclosure_service`, so they run with the service's real
privileges.
