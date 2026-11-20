# ADR-0020: Consent records

Status: Accepted (2026-11-20, product owner approved the M1.2 plan and decisions a–e).

## Decisions
- **Onboarding order:** code → terms and privacy → date of birth → active. `SetDateOfBirth` refuses until both are granted at their current versions.
- **Health processing** is a separate, optional consent. It is asked right before the first health question (M2), not during sign-up.
- **Withdrawing terms or privacy** starts account deletion: the account becomes `PENDING_ERASURE`, every session ends at once, and `account.erasure_requested` goes to the outbox. Full erasure across services arrives with M1.8.
- **Withdrawing health processing** queues erasure of the member's health data (`identity.vault_erasure_requests`, written in the same transaction). The queue is delivered to the Disclosure Service's `EraseSubject` with the row id as idempotency key, and retried until confirmed. The Disclosure Service arrives with M2; until then requests wait in the queue.
- **Marketing** consent is optional and off unless given.
- **Policy versions** are listed in `services/identity/src/consent/policies.ts`, and a consent must name the current version. Legal counsel (Dumisani Lukhele) approved the terms and health-consent texts on 2026-11-20. The privacy and marketing texts carry draft labels until they are final.

## Technical decisions
- History is **append-only**. A withdrawal is a new row, and a database trigger refuses updates. Rows are deleted only with the account (CLAUDE.md rule 10).
- **No events for consent changes, and logs never name the consent type.** Even "withdrew health consent" implies health data (CLAUDE.md rule 3). The only event is `account.erasure_requested`, which names no reason.
- Confirmed vault erasures are kept 30 days as proof, then deleted by the cleanup job.
