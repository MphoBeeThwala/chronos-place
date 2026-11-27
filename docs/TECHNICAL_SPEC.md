# Chronos Place — Technical Specification

Version 0.1 · 2026-10-01 · Companion to `PRD.pdf`

This document defines how Chronos Place is built. The PRD defines what and why. Where this spec is silent, ask before inventing behaviour.

---

## 1. Architecture overview

Chronos Place is a set of domain services on Kubernetes (Amazon EKS) in AWS af-south-1 (Cape Town). Clients talk to a single GraphQL gateway. Services talk to each other over gRPC (synchronous) and Kafka (asynchronous). Health data is isolated in a **restricted zone**: a separate AWS account, VPC and database that only the Disclosure Service can reach.

```
Member web app (native app later) / Admin console / Partner portal
                  |
        API gateway + WAF (edge)
                  |
        GraphQL gateway (BFF)  ---- auth guard, rate limits
                  |
  +-------+-------+--------+---------+-----------+-----------+
  |       |       |        |         |           |           |
identity profile discovery matching messaging moderation notifications payments
  |       |       |        |         |           |
  +--- Core PostgreSQL/PostGIS, Redis, Kafka, S3 ----+
                  |
        (gRPC over private link, mTLS, allow-list)
                  |
   RESTRICTED ZONE: disclosure-service -> Health Vault DB -> KMS/CloudHSM
```

### 1.1 Zones and trust boundaries

| Zone | Contents | Who can reach it |
| --- | --- | --- |
| Edge | CloudFront, WAF, API gateway | Public internet |
| Core | All services except disclosure-service; core DB, Redis, Kafka, S3 | Gateway and other core services |
| Restricted | disclosure-service, Health Vault DB, vault KMS keys | Only named core services via PrivateLink + mTLS, through the gRPC allow-list |
| Staff | Admin console, break-glass tooling | Staff via SSO + phishing-resistant MFA |

---

## 2. Services

| Service | Responsibility | Owns data | Exposes |
| --- | --- | --- | --- |
| gateway | GraphQL BFF, session validation, rate limiting, request shaping | none | GraphQL |
| identity | Accounts, phone/email OTP, sessions, liveness verification status, consent records | accounts, sessions, consent_records, devices | gRPC |
| profile | Profiles, photos, prompts, preferences, approximate location | profiles, photos, preferences | gRPC |
| discovery | Candidate generation, geo filtering, ranking, feed precomputation | feed caches (Redis), ranking features | gRPC |
| matching | Likes, passes, matches, unmatches, blocks | likes, matches, blocks | gRPC, events |
| messaging | Signal prekey directory, encrypted message relay, delivery receipts | key bundles, message envelopes | WebSocket, gRPC |
| moderation | Reports, classifiers (image/text), review queues, enforcement | reports, actions | gRPC, admin API |
| notifications | Push (FCM/APNs), email, SMS with content templates that never include health data | device tokens, templates | gRPC, event consumer |
| payments | Entitlements from RevenueCat webhooks | entitlements | gRPC, webhook |
| disclosure-service | Health profiles, visibility, grants, access decisions, audit, erasure | Health Vault (all) | gRPC (restricted) |

---

## 3. Data model

### 3.1 Classification

| Class | Examples | Store |
| --- | --- | --- |
| Restricted | Conditions, status, health note, visibility, grants, health access log | Health Vault only |
| Confidential | Phone, email, verification selfies, exact location, message envelopes, reports, consent records | Core DB (encrypted columns where noted) |
| Internal | Profile text, photos, preferences, likes, matches | Core DB, S3 |
| Public | Marketing pages, partner content | CMS/CDN |

### 3.2 Core database (PostgreSQL + PostGIS)

Illustrative DDL; implement with Drizzle schema files. All tables have `created_at`, `updated_at` (timestamptz).

```sql
CREATE TABLE accounts (
  id               uuid PRIMARY KEY,
  phone_e164       text UNIQUE,              -- stored sealed + keyed lookup hash (ADR-0018)
  email            citext UNIQUE,
  status           text NOT NULL,            -- active | suspended | pending_erasure | erased
  verified_at      timestamptz,              -- liveness passed
  date_of_birth    date,                     -- set straight after first sign-in; 18+ enforced (ADR-0018)
  locale           text NOT NULL DEFAULT 'en-ZA'
);

CREATE TABLE consent_records (
  id              uuid PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id),
  consent_type    text NOT NULL,             -- terms | privacy | health_processing | marketing
  policy_version  text NOT NULL,
  granted         boolean NOT NULL,
  recorded_at     timestamptz NOT NULL
);

CREATE TABLE profiles (
  account_id      uuid PRIMARY KEY REFERENCES accounts(id),
  display_name    text NOT NULL,
  bio             text,
  intent          text NOT NULL,             -- long_term | dating | friendship | open
  gender          text,                      -- free text + optional standard values
  pronouns        text,
  location        geography(Point, 4326),    -- never returned to other members
  area_label      text,                      -- e.g. "Johannesburg North"
  private_mode    boolean NOT NULL DEFAULT false,
  visible         boolean NOT NULL DEFAULT true
);
CREATE INDEX profiles_location_gix ON profiles USING gist(location);

CREATE TABLE profile_photos (
  id              uuid PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id),
  s3_key          text NOT NULL,             -- EXIF/GPS stripped on upload
  position        smallint NOT NULL,
  moderation      text NOT NULL              -- pending | approved | rejected
);

CREATE TABLE preferences (
  account_id      uuid PRIMARY KEY REFERENCES accounts(id),
  age_min         smallint NOT NULL,
  age_max         smallint NOT NULL,
  max_distance_km smallint NOT NULL,
  intents         text[] NOT NULL,
  genders         text[]
  -- condition-aware filter settings live in the Health Vault, NOT here
);

CREATE TABLE likes (
  from_id uuid NOT NULL, to_id uuid NOT NULL,
  kind text NOT NULL,                        -- like | pass
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE matches (
  id uuid PRIMARY KEY,
  a_id uuid NOT NULL, b_id uuid NOT NULL,    -- a_id < b_id
  status text NOT NULL,                      -- active | ended
  UNIQUE (a_id, b_id)
);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL, blocked_id uuid NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
-- Matching (M3.1, schema `matching`, approved rules): a block ends any match (ended_reason block)
-- and clears likes both ways; an unblock restores nothing; an unmatch is final (the ended row keeps
-- the pair from ever matching again). Two likes at once create one match (per-pair advisory lock).
-- Other services ask matching's GetRelationship / FilterVisible and treat "unreachable" as hidden.

CREATE TABLE reports (
  id uuid PRIMARY KEY,
  reporter_id uuid NOT NULL, subject_id uuid NOT NULL,
  category text NOT NULL,                    -- scam | harassment | outing_threat | fake | underage | other
  severity text NOT NULL,                    -- low | medium | high | critical
  evidence jsonb,                            -- references only; forwarded messages stored encrypted
  status text NOT NULL, outcome text
);
```

### 3.3 Health Vault database (separate cluster, restricted account)

All tables live in the `vault` schema. The source of truth is `restricted/vault-db/src/schema.ts` and its migrations; this section summarises them.

```sql
-- Links the core account to a pseudonymous vault subject. Lives ONLY here.
CREATE TABLE subject_map (
  account_id      uuid PRIMARY KEY,
  vault_id        uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL
);

-- Per-member data key, wrapped by the KMS CMK. Deleting this row = crypto-shred.
-- Backs @chronos/crypto's WrappedKeyStore (subject id = vault_id).
CREATE TABLE subject_keys (
  vault_id        uuid PRIMARY KEY REFERENCES subject_map(vault_id) ON DELETE CASCADE,
  wrapped_dek     bytea NOT NULL,
  kms_key_arn     text NOT NULL,
  created_at      timestamptz NOT NULL,
  rotated_at      timestamptz                -- null until the first rotation
);

CREATE TABLE condition_taxonomy (            -- non-sensitive reference data, changed only by migrations
  code            text PRIMARY KEY,          -- e.g. hiv, t1d, t2d, cancer_survivor; ^[a-z][a-z0-9_]{0,39}$
  label_en        text NOT NULL,
  active          boolean NOT NULL DEFAULT true
);

CREATE TABLE health_profiles (
  vault_id        uuid PRIMARY KEY REFERENCES subject_map(vault_id) ON DELETE CASCADE,
  payload_ct      bytea NOT NULL,            -- AES-256-GCM ciphertext of JSON below
  payload_nonce   bytea NOT NULL,
  visibility      text NOT NULL DEFAULT 'hidden', -- CHECK: hidden | match_only | chat_grant | profile
  filter_opt_in   boolean NOT NULL DEFAULT false,
  version         integer NOT NULL DEFAULT 1, -- bumped on every write (optimistic concurrency)
  created_at, updated_at timestamptz NOT NULL
);
-- payload JSON: { conditions: [{code, status: living_with|in_remission|survivor}], freeText?: string, note?: string }

-- Conditions a member filters by (ADR-0015), sealed like the profile.
CREATE TABLE filter_preferences (
  vault_id        uuid PRIMARY KEY REFERENCES subject_map(vault_id) ON DELETE CASCADE,
  payload_ct      bytea NOT NULL,
  payload_nonce   bytea NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  created_at, updated_at timestamptz NOT NULL
);

CREATE TABLE disclosure_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id        uuid NOT NULL REFERENCES subject_map(vault_id) ON DELETE CASCADE,
  viewer_account_id uuid NOT NULL,
  scope           text NOT NULL,             -- CHECK: full | conditions_only
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz                -- CHECK: null or >= granted_at
);
-- At most one live grant per (vault_id, viewer_account_id): unique index WHERE revoked_at IS NULL.

CREATE TABLE health_access_log (             -- append-only; also streamed to immutable storage
  id              bigserial PRIMARY KEY,
  vault_id        uuid NOT NULL,             -- no FK: rows outlive erasure, pseudonymous only
  accessor        text NOT NULL,             -- CHECK: account:<uuid> | service:<name> | staff:<uuid>
  purpose         text NOT NULL,             -- CHECK: profile_view | chat_card | moderation | export | erasure | filter (M2.6)
  decision        text NOT NULL,             -- CHECK: allow | deny
  reason          text NOT NULL,             -- CHECK: short code ^[a-z][a-z0-9_]{0,39}$ (e.g. no_grant), never free text
  at              timestamptz NOT NULL DEFAULT now()
);
```

Database roles (migration `0001_roles.sql`), both created without login; infrastructure supplies authentication (a password from the environment locally, IAM auth when deployed), so no secret is in a migration:

- `vault_owner` owns the schema and tables and is used only to run migrations.
- `disclosure_service` is the runtime role: `SELECT/INSERT/UPDATE/DELETE` on `subject_map`, `subject_keys`, `health_profiles`, `filter_preferences` and `disclosure_grants` (DELETE serves erasure, M2.7); `SELECT` only on `condition_taxonomy`; `SELECT/INSERT` only on `health_access_log` (SELECT serves "who has seen my health information", M2.8). Nothing on any other schema.
- `health_access_log` is append-only twice over: no UPDATE, DELETE or TRUNCATE grant, and a trigger that refuses all three for every role, the owner included.
- Nothing is granted to `PUBLIC`. No human role has standing access.

Audit rows are kept after a member is erased: they hold only the pseudonymous vault id, which nothing links back to an account once `subject_map` is deleted. The retention period is for counsel to set; until then rows are kept.

---

## 4. Disclosure Service

### 4.1 gRPC contract (`packages/contracts/proto/disclosure/v1/disclosure.proto`)

```proto
syntax = "proto3";
package chronos.disclosure.v1;

service DisclosureService {
  rpc UpsertHealthProfile(UpsertHealthProfileRequest) returns (UpsertHealthProfileResponse);
  rpc GetOwnHealthProfile(GetOwnRequest) returns (HealthProfileView);
  rpc SetVisibility(SetVisibilityRequest) returns (SetVisibilityResponse);
  rpc GrantDisclosure(GrantRequest) returns (GrantResponse);
  rpc RevokeDisclosure(RevokeRequest) returns (RevokeResponse);
  rpc ViewHealthProfile(ViewRequest) returns (ViewResponse);        // viewer -> subject
  rpc ListHealthViewers(ListViewersRequest) returns (ListViewersResponse);
  rpc FilterEligibleSubjects(FilterRequest) returns (FilterResponse); // condition-aware discovery
  rpc ExportSubject(ExportRequest) returns (ExportResponse);
  rpc EraseSubject(EraseRequest) returns (EraseResponse);
}

message ViewRequest {
  string viewer_account_id = 1;
  string subject_account_id = 2;
  Purpose purpose = 3;
}
message ViewResponse {
  bool allowed = 1;
  HealthProfileView profile = 2;   // empty when not allowed
}
enum Purpose { PURPOSE_UNSPECIFIED = 0; PROFILE_VIEW = 1; CHAT_CARD = 2; MODERATION = 3; }
// The proto file in packages/contracts is the source of truth; message names there follow Buf lint
// (e.g. ViewHealthProfileRequest). This excerpt is illustrative. See ADR-0015.
```

Callers are authenticated by mTLS identity (`spiffe://chronos-place.internal/<service>`, ADR-0004). The allow-list is enforced in `restricted/disclosure-service/src/allow-list.ts` (M2.5), default deny, and a test keeps it equal to the `Caller` comments in the proto. Identity and profile have their own allow-lists. The gateway may call ViewHealthProfile only with a non-moderation purpose. ExportSubject has no caller until ADR-0025 decision g. Allow-list:

| Caller | Allowed RPCs |
| --- | --- |
| gateway | UpsertHealthProfile, GetOwnHealthProfile, SetVisibility, GrantDisclosure, RevokeDisclosure, ViewHealthProfile, ListHealthViewers, ListConditionTaxonomy, SetFilterPreferences, GetFilterPreferences |
| discovery | FilterEligibleSubjects |
| identity | EraseSubject (ExportSubject's caller is open: see ADR-0025 decision g) |
| moderation | ViewHealthProfile with purpose MODERATION only, requires a linked open report ID |

### 4.2 Access decision

```
canView(viewer, subject, purpose):
  if viewer == subject                         -> allow
  if blocked(viewer, subject) either way       -> deny "blocked"
  if subject.status != active                  -> deny "inactive"
  if purpose == MODERATION                     -> allow only with open report on subject, staff role, time-boxed
  switch subject.visibility:
    hidden       -> deny "hidden"
    match_only   -> allow if activeMatch(viewer, subject) else deny
    chat_grant   -> allow if activeGrant(subject, viewer) and activeMatch(viewer, subject) else deny
    profile      -> allow if viewer.verified else deny
  ALWAYS write health_access_log (allow or deny)
```

Implementation notes (M2.3, approved): the decision is a pure function (`restricted/disclosure-service/src/access/decide.ts`, 100% branch coverage enforced).

- A subject with no health profile is denied for everyone (`no_profile`). Self is allowed in full before any outside fact is needed.
- **Fail closed:** if matching or identity cannot answer, the view is denied (`relationship_unavailable`, `identity_unavailable`). Relationships come from matching's `GetRelationship` (M3.1); without `MATCHING_GRPC_ADDRESS` every view by another member is denied.
- Moderation is denied (`moderation_unavailable`) until M5 can prove an open report; the access log records the accessor as `staff:<id>`.
- **What is shown:** `match_only` and `profile` show conditions only. Free text and the note are shared only through a grant with FULL scope.
- **A share needs a live match** (M3.1, approved): when a match ends (unmatch or block) the viewer loses the share at once, even if the grant row has not been ended yet.
- Allowed views carry a 5-minute lease (`lease_expires_at`).
- The caller only learns `allowed`, never the reason. "No profile" and "hidden" answer identically, and a subject with nothing in the vault leaves no row behind.
- `SetVisibility` needs an existing profile and increments its version.
- Grants (M2.4): `GrantDisclosure` needs a saved profile and an active, unblocked match with an active viewer (one fixed refusal for all cases). A scope change revokes the live grant and inserts a new one. `RevokeDisclosure` takes effect on the viewer's next request; an open view lasts at most its lease.
- `ListHealthViewers` (M2.4) aggregates `allow` rows with `account:` accessors other than the member. Refused attempts, own views and moderator views are not listed. Pages use an opaque keyset token; reading the list is recorded as `self_viewers`.

Block and match state are fetched from matching via gRPC (or a short-TTL cache invalidated by `match.*` / `block.*` events). Revoking a grant or changing visibility takes effect immediately; clients must re-request rather than cache health views beyond the current screen.

### 4.3 Condition-aware discovery without leakage

1. Discovery calls `FilterEligibleSubjects(viewer, candidateIds[])`. The viewer's wanted condition codes are stored in the vault (`SetFilterPreferences`), so discovery, its caches and its logs never see them (ADR-0015).
2. The service returns only candidates whose visibility is `profile`, who set `filter_opt_in`, and who match the codes — **and only if the viewer also shares their own health profile** (`profile` visibility + opt-in).
3. If fewer than **k = 20** candidates pass, return an empty set with outcome `below_threshold` so counts cannot reveal individuals. A viewer with no wanted conditions gets `no_preferences` (M3.4), checked first so it says nothing about their own profile. A viewer with wanted conditions who does not share their own profile gets `viewer_not_sharing`.
4. The response contains account IDs only, never condition data.

Implementation notes (M2.6, approved):

- **Matching:** candidates are matched by decrypting their profiles in memory. There is no searchable index, so nothing new is stored. A candidate matches if they have **any** wanted condition, in any status.
- **Preferences:** sealed with the member's own key in `filter_preferences`. Up to 10 active codes, never `other`. An empty list deletes the row.
- **Audit:** each candidate profile opened is recorded with purpose `filter` before decryption. Those rows do not appear in `ListHealthViewers`, which counts profile views only.
- **Below threshold:** 19 matches and none answer the same. A candidate that cannot be opened does not match.
- **No preferences (M3.4):** decided from whether the viewer's `filter_preferences` row exists, before anything is opened; nothing is audited because nothing is read.
- **Speed (M3.4):** profiles are opened 32 at a time, since each may need a KMS unwrap (keys stay cached for at most 60 s). With 10 ms per unwrap, 500 candidates of whom 150 opted in answer in about 140 ms warm (`test/filter-speed.integration.test.ts`).
- **Known limit:** a compromised discovery service could probe a member by mixing them into a list of known matches. Discovery is allow-listed and runs over mTLS; detecting unusual call patterns is monitoring work.

### 4.4 Encryption

- Per-subject data encryption key (DEK), AES-256-GCM, generated with KMS `GenerateDataKey`.
- Wrapped DEK stored in `subject_keys`; plaintext DEK held in memory only for the request (optional short in-process cache, max 60 s).
- CMK in KMS backed by CloudHSM custom key store, rotation yearly, key policy limited to the disclosure-service IAM role.
- **Erasure:** record the subject in the erasure ledger, delete the `subject_keys` row (crypto-shred), then delete vault rows. Deleting the key alone does not protect backups taken earlier, because they still hold the wrapped key and KMS can unwrap it. The ledger (outside database backups) makes the keyring refuse to unwrap an erased subject, and restore procedures must replay it before going live. Backup retention is capped at 30 days. See ADR-0014.
- **Implementation (M2.7):**
  - **The ledger:** one write-once object `erased/<vault_id>` per subject in an S3-compatible bucket (`VAULT_LEDGER_BUCKET`), with Object Lock where the host supports it.
  - **The keyring check:** it consults the ledger on every key use. "Erased" is remembered for good; "not erased" for at most 30 s, which is within the 60 s key cache. If the ledger can't be reached, the keyring fails closed.
  - **What `EraseSubject` deletes:** shares other members gave to the erased account, then (via the ledger and shred) the key, then `subject_map`, which cascades to the profile, filter preferences and the member's own grants.
  - **What it keeps:** a `service:identity` / `erasure` row in the access log; the member's earlier audit rows stay (pseudonymous).
  - **After a restore:** `pnpm --filter @chronos/disclosure-service vault:replay-ledger` deletes the key and rows of every listed subject.

---

## 5. Messaging (end-to-end encrypted)

See ADR-0003. Summary:

- Signal Protocol (X3DH / PQXDH key agreement + Double Ratchet) via libsignal.
- **messaging** service stores only: identity keys, signed prekeys, one-time prekeys, and encrypted envelopes until delivered (max 30 days).
- Transport: WebSocket (authenticated with session token), with push wake-ups that carry **no content**.
- Messaging is allowed only between members with an active match and no block.
- **Disclosure card:** the sender's app requests its own health view, renders a preview, and on confirm calls `GrantDisclosure` for that viewer. The card itself contains a reference, not the health data; the recipient's app fetches via `ViewHealthProfile` (purpose CHAT_CARD), so revocation works.
- **Reporting:** the reporter's app decrypts selected messages locally and submits them with the report to moderation, encrypted to the moderation service key.
- **Risk:** React Native has no official libsignal binding. Task M4.1 is a spike to choose between a native module wrapping libsignal (Rust, via JSI/Turbo Module) and an audited community binding. Do not ship custom cryptography.

---

## 6. Client API (GraphQL, excerpt)

The schema in `packages/contracts/graphql/schema.graphql` is the source of truth; this excerpt is illustrative. The file adds `refreshSession`, `signOut`, `conditionTaxonomy`, `myHealthFilters` and `setHealthFilters`, and an optional `filterOptIn` argument on `setHealthVisibility` (ADR-0015), and the photo mutations `createPhotoUpload`, `completePhotoUpload`, `reorderPhotos` and `deletePhoto` (ADR-0024).

```graphql
type Query {
  me: Me!
  feed(first: Int = 20, after: String): FeedConnection!
  profile(id: ID!): PublicProfile
  matches(first: Int = 50, after: String): MatchConnection!
  myHealthProfile: HealthProfile          # own data only
  healthProfileOf(accountId: ID!): HealthProfileView   # null when not permitted
  healthViewers: [HealthViewer!]!
  myDataExport: DataExport!   # non-health data as JSON, ADR-0025
}

type Mutation {
  requestOtp(phone: String!): OtpChallenge!
  verifyOtp(challengeId: ID!, code: String!): Session!
  recordConsent(input: ConsentInput!): Boolean!
  updateProfile(input: ProfileInput!): Me!
  updatePreferences(input: PreferencesInput!): Me!
  like(accountId: ID!): LikeResult!
  pass(accountId: ID!): Boolean!
  unmatch(matchId: ID!): Boolean!
  block(accountId: ID!): Boolean!
  report(input: ReportInput!): Report!
  upsertHealthProfile(input: HealthProfileInput!): HealthProfile!
  setHealthVisibility(visibility: HealthVisibility!): HealthProfile!
  shareHealthCard(matchId: ID!, scope: GrantScope!): Boolean!
  revokeHealthShare(accountId: ID!): Boolean!
  requestAccountDeletionCode: OtpChallenge!
  deleteAccount(challengeId: ID!, code: String!): Account!   # ADR-0025
}

enum HealthVisibility { HIDDEN MATCH_ONLY CHAT_GRANT PROFILE }

type PublicProfile {
  id: ID!
  displayName: String!
  age: Int!
  areaLabel: String
  distanceKm: Int          # rounded, minimum 1
  photos: [Photo!]!
  prompts: [Prompt!]!
  verified: Boolean!
  # NOTE: no health fields here. Health comes only from healthProfileOf.
}
```

Rules: persisted queries only in production; query depth/complexity limits; per-account and per-IP rate limits (Redis token bucket); health fields resolved only through dedicated resolvers that call the Disclosure Service.

---

## 7. Events (Kafka)

Schemas live in `packages/contracts/events` (zod + JSON Schema). Health data is never published.

| Topic | Producer | Payload (summary) |
| --- | --- | --- |
| account.created | identity | accountId, createdAt |
| account.erasure_requested | identity | accountId, requestedAt |
| account.erased | identity | accountId |
| match.created / match.ended | matching | matchId, accountIds |
| block.created | matching | blockerId, blockedId |
| report.created | moderation | reportId, subjectId, severity |
| photo.uploaded | profile | photoId, accountId |
| entitlement.changed | payments | accountId, tier |

Consumers are idempotent (event ID + dedupe table). Erasure is orchestrated by identity: it emits `account.erasure_requested`; every service deletes its data and confirms; identity marks `erased` after all confirmations or escalates after 7 days.

---

## 8. Authentication and authorisation

- **Members:** phone OTP (SMS provider behind an interface; WhatsApp OTP later), optional email. Access token (JWT, 10 min, signed with KMS asymmetric key) + rotating refresh token (30 days, device-bound, stored hashed). Passkeys as a follow-up.
- **Verification:** liveness via Smile ID (or Onfido) SDK; we store only the result and a reference, deleting selfie images after the retention period.
- **Staff:** OIDC SSO with phishing-resistant MFA; role-based access (support, moderator, senior moderator, compliance, admin); just-in-time elevation with approval and expiry; every admin action audited.
- **Service-to-service:** mTLS via service mesh identities; gRPC interceptors enforce per-method allow-lists.

---

## 9. Mobile app specifics

The member app ships first on the web (ADR-0017). This section is the target for the native app (M8); ADR-0017 lists the web equivalents that apply until then.

- Expo dev client, EAS Build/Submit, OTA updates restricted to JS-only fixes.
- Secure storage: Expo SecureStore (Keychain/Keystore) for tokens and Signal keys.
- **Screen protection** on any screen showing health data: Android `FLAG_SECURE`; iOS blur on app switcher plus screenshot detection notice.
- App lock: PIN/biometrics (expo-local-authentication); quick-exit gesture; alternate neutral app icons.
- Notifications: generic text only ("You have a new message"). Never names or content.
- Offline/low-data: image size variants, lite mode, request batching.
- Accessibility: Dynamic Type/font scaling to 200%, VoiceOver/TalkBack labels, reduced motion, 44 pt targets, button alternatives to swipes.
- i18n: i18next; English first, keys ready for isiZulu, isiXhosa, Afrikaans, Sesotho.

---

## 10. Infrastructure

### 10.1 AWS accounts (AWS Organizations)

| Account | Purpose |
| --- | --- |
| management | Organizations, billing, SCPs |
| security | GuardDuty, Security Hub, CloudTrail org trail, log archive (S3 Object Lock) |
| shared-services | ECR, CI roles, Terraform state |
| dev / staging / prod | Core workloads per environment |
| restricted-dev / restricted-staging / restricted-prod | Disclosure service + Health Vault per environment |

SCPs deny resource creation outside af-south-1 (except global services) and deny disabling CloudTrail/GuardDuty.

### 10.2 Per-environment stack (Terraform modules)

- VPC across 3 AZs, private subnets for workloads, no public DB endpoints.
- EKS with managed node groups (Karpenter for scaling), service mesh with mTLS (Istio ambient or Linkerd — decide in ADR).
- Aurora PostgreSQL (core, PostGIS enabled) and Aurora PostgreSQL (vault, in restricted account).
- ElastiCache Redis, Amazon MSK, S3 + CloudFront, WAF.
- KMS keys per data domain; CloudHSM custom key store for vault CMK (prod).
- PrivateLink endpoint exposing disclosure-service from restricted account to core account only.
- Secrets Manager; External Secrets Operator in-cluster.

### 10.3 Local development

`tools/docker-compose.yml`: postgres-core (PostGIS), postgres-vault, redis, redpanda, s3 (SeaweedFS, ADR-0013), localstack (KMS, S3, Secrets Manager), mailpit. The vault database runs on a separate network that only the disclosure-service container joins.

### 10.4 Delivery pipeline

GitHub Actions → build, lint, typecheck, test, scan → container images to ECR (signed with cosign, SBOM attached) → Argo CD syncs Helm charts per environment. Prod deploys need approval; restricted-zone deploys need approval from a security owner.

---

## 11. Observability

- OpenTelemetry SDK in every service; traces to a self-hosted Grafana stack (Tempo, Loki, Mimir) or managed equivalents in af-south-1.
- `@chronos/logger` (pino) with mandatory redaction list and an allow-list approach for restricted services (log only whitelisted fields).
- Sentry self-hosted for errors with PII scrubbing; no session replay.
- SLOs: availability 99.9% (APIs), 99.95% (messaging, disclosure); p95 latency 300 ms; alerts on error-budget burn.

---

## 12. Security controls checklist

- [ ] Threat model per epic (STRIDE) stored in `docs/threat-models/`
- [ ] ESLint boundary rule: nothing outside `restricted/` imports from it
- [ ] Privacy test suite: asserts no health strings/codes appear in logs, events, notification payloads or error responses
- [ ] Dependency, SAST, secret, container and IaC scanning gate merges
- [ ] Signed images; admission policy only runs signed images
- [ ] WAF rules, bot defence, rate limits at gateway
- [ ] Encryption in transit (TLS 1.3, mTLS internal) and at rest (KMS)
- [ ] Immutable audit trail for vault access and admin actions
- [ ] Quarterly restore drills; annual external penetration test; bug bounty after GA

---

## 13. Testing strategy

| Level | Tooling | Must cover |
| --- | --- | --- |
| Unit | Vitest | Domain logic, especially `canView` decision table (every visibility x relationship case) |
| Integration | Testcontainers | Real Postgres/Redis/Kafka; migrations; gRPC allow-lists |
| Contract | Buf breaking-change checks, GraphQL schema diff | No unreviewed breaking changes |
| Privacy | Custom suite | Leakage through logs, events, notifications, errors, analytics |
| E2E web | Playwright | Onboarding, consent, health profile, disclosure card, block/report |
| E2E native (M8) | Maestro | Same journeys on iOS and Android |
| E2E web | Playwright | Moderation console flows |
| Load | k6 | Feed, like, messaging at 10x expected peak |
| Security | ZAP baseline, pen test | OWASP Top 10, OWASP MASVS for mobile |

---

## 14. Open technical decisions (become ADRs)

1. Service mesh: Istio ambient vs Linkerd.
2. libsignal React Native integration approach (spike M4.1).
3. Ranking: rules-based at GA vs learned ranking later.
4. SMS/OTP provider for South Africa and fallback.
5. Self-hosted observability vs managed.
