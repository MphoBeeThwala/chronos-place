# ADR-0025: Account deletion and data export

Status: Accepted (2026-11-26, product owner approved decisions a–c, h, i and the M1.8 plan). Decision g is a proposal for M2.

## Context
- **TASKS M1.8:** an export bundle and erasure orchestrated through events. AC: erasure completes across services within the SLA in an integration test.
- **PRD:** members can download and delete their data in-app. Deletion erases profile data within 30 days and crypto-shreds Health Vault data at once, except records the law requires us to keep.
- **Spec 7:** identity sends `account.erasure_requested`. Every service deletes its data and confirms with `account.erasure_confirmed`. Identity marks the account `erased` after all confirm, or escalates after 7 days.
- **Published Privacy Policy (`privacy-2026-11-26`, section 7):**
  - On deletion, the profile stops showing at once and every session ends.
  - Everything is deleted within 30 days.
  - Health data becomes unreadable straight away.
  - Afterwards we keep only a one-way code of the number for under-18 and banned accounts, and records a law requires.
- **Already built:** withdrawing Terms or Privacy consent sets `pending_erasure`, ends sessions, writes `account.erasure_requested` to identity's outbox and queues vault erasure. Nothing publishes or consumes events yet (ADR-0019).

## Decisions
- **a. A fresh one-time code confirms deletion.**
  - **Code:** "Delete my account" texts a new code to the account's own number. The member enters it to confirm.
  - **Why:** someone holding an unlocked phone or a stolen session cannot delete the account alone.
  - **Separate purpose:** the code can only confirm deletion, and a sign-in code cannot confirm it. Both use the same rate limits and attempt counts as sign-in codes (ADR-0018).
- **b. No undo window.** Deletion starts the moment the code is accepted, as the Privacy Policy describes:
  - the account becomes `pending_erasure`;
  - every session and refresh token ends;
  - the profile is hidden from everyone;
  - health erasure is queued;
  - `account.erasure_requested` is sent.

  Signing in again with the same number later creates a new, empty account.
- **c. Instant JSON download.**
  - **What it is:** "Download my data" returns one JSON file straight away, in a versioned format (`chronos-export/1`) the gateway assembles from each service's export RPC.
  - **Photos:** shown as links that work for 24 hours, not embedded. Nothing is stored for the export: no bucket, no background job.
  - **Response:** `Cache-Control: no-store`.
  - **Rate limit:** at most 5 per member per hour.
- **d. Each service deletes its own data and confirms.**
  - **Profile:** deletes the profile, prompts, interests, preferences and photo rows, and every stored file (all sizes, plus any unfinished upload in quarantine), then sends `account.erasure_confirmed`.
  - **Matching (M3.1):** ends the member's active matches (`match.ended`, so chats close), deletes every like, pass, match and block that names them either way, and confirms through its outbox in the same transaction.
  - **Idempotent:** consumers skip duplicates by `eventId` (spec 7), and deleting what is already gone still confirms.
  - **Expected confirmations:** a list in identity's configuration, today `profile` and `matching`. Each new service that stores member data joins the list when it is built.
- **e. Identity goes last and leaves a tombstone.** After every expected confirmation, identity:
  - destroys the member's data key in `account_keys`. This crypto-shreds the encrypted number;
  - deletes their sessions, refresh tokens, code challenges, consent records and verification records;
  - clears the account row down to its id, status `erased` and the time of erasure;
  - sends `account.erased`.

  The bare random id holds nothing about the person; it lets late or repeated events be answered safely. The one-way number code is kept only for accounts closed as under 18 or banned, as the Privacy Policy says.
- **f. Time limits.**
  - **Target:** erasure finishes in minutes. Anything still waiting for a confirmation after 7 days is counted on a metric (`erasure_overdue`, no ids in labels) for staff to act on. The admin console arrives in M5.
  - **Hard limit:** 30 days, as promised to members.
  - **Test:** the M1.8 acceptance test runs identity and profile together and checks that nothing for the member is left in either database or in storage.
- **g. Health data in the export (proposal for M2, not decided).**
  - **Problem:** spec 4 has identity call the Disclosure Service's `ExportSubject` and receive the member's health data. That would put health data outside `restricted/` (CLAUDE.md rule 1).
  - **Proposal:** the Disclosure Service builds the health part of the export itself, and the member downloads it straight from the restricted zone, never through identity or the gateway.
  - **M1.8 scope:** the M1.8 export covers non-health data only, because no health data exists until M2.

- **h. The export is the one way a number and date of birth leave identity.**
  - **The rule it changes:** ADR-0018 lets a phone number cross into identity only, and no response echoes a date of birth.
  - **The exception:** `ExportAccountResponse` carries the member's own number and date of birth, because the right of access (POPIA s23) covers them. Approved by the product owner on 2026-11-26.
  - **Guarded by tests:** a contract test still fails if any other message carries them, and sessions are exported as dates only, never device ids.
  - **On the way through:** the gateway passes the export straight to the member. It never logs, caches or stores it (`@chronos/logger` redacts `phone` and `dateOfBirth` keys regardless).

- **i. The export includes the member's stored location.**
  - **The rule it changes:** profile (ADR-0023) never returns a stored location, not even to its owner, as its README and schema say.
  - **The exception:** "Download my data" includes it, because the right of access (POPIA s23) covers it. Approved by the product owner on 2026-11-26.
  - **What is exported:** the point as stored, already snapped to about 1 km, with when it was set.
  - **Still never:** shown in the app or returned to anyone else (CLAUDE.md rule 8).

## Consequences
- **GraphQL:** `requestAccountDeletionCode` and `deleteAccount(challengeId, code)` replace `deleteAccount(confirm)`, and the `myDataExport` query replaces `requestDataExport`. No client used either old field.
- **Identity gRPC:** adds `RequestDeletionCode`, `DeleteAccount` and `ExportAccount`.
- **Profile gRPC:** adds `ExportProfile`.
- **Events:** `@chronos/events` (ADR-0019) is built in this milestone, so the outbox finally publishes and profile can consume.
