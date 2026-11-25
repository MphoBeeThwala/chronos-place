# ADR-0022: Liveness verification

Status: Accepted (2026-11-25, product owner approved decisions a–f). The items marked **needs counsel** must be cleared before production use.

## Context
- PRD: a mandatory selfie liveness check before messaging, a visible verified badge, and no paywall on verification. Vendors never receive health data.
- Spec section 8: liveness through Smile ID or Onfido. We store only the result and a reference, and delete selfie images after a retention period.
- ADR-0017: the vendor's web SDK must pass CLAUDE.md rule 7 (no phoning home beyond the verification itself). The camera is blocked by `Permissions-Policy` today and opens only on the routes that need it. M1.9 moves the CSP to nonces with `'strict-dynamic'` and keeps `connect-src 'self'`.
- POPIA treats biometric information as special personal information. On this platform, membership itself suggests a health condition, so a selfie tied to "a Chronos Place member" is sensitive even without any health field.

## Options compared

| | Smile ID | Onfido (now Entrust) |
| --- | --- | --- |
| Web capture | Open-source web component (`@smile_identity/smart-camera-web`) installed from npm and served from our own origin. It hands the images to our page; our server submits them. | `onfido-sdk-ui` from v14 loads its runtime from the Entrust CDN when it starts, so the code that runs is not the code we pinned and reviewed. |
| Browser talks to the vendor? | No. The browser only talks to our gateway. | Yes: capture, upload and analytics go from the browser to Entrust. |
| Analytics in the SDK | None we have found in the component (to be confirmed by reading the pinned source, see below). | "Behavioural events" for product research, plus device data for Entrust's device-intelligence service. Turning behavioural events off needs a support request. |
| Where data is processed | Africa-focused vendor with POPIA-specific terms. Storage location is not stated in its retention policy (**needs counsel**: ask). | EU, US or Canada only. No African region. |
| Biometric retention | POPIA policy: 90 days after verification by default when acting as operator; up to 5 years where it acts as responsible party. | Up to 365 days, or shorter if we set it; a delete-applicant API exists. |
| Our role under their terms | Its data processing agreement describes Smile ID as an "independent controller and data processor". **Needs counsel:** we need operator-only terms. | Processor for the service, but also uses biometric data for its own fraud checks. |
| Cost model | Pay as you go from a prepaid wallet. A free sandbox for development. | Sales-led contract. |
| Fit for our members | Built and tuned for African faces, low bandwidth and budget Android phones. | Strong global product (Motion). |

## Decisions
1. **Provider: Smile ID,** behind a `LivenessProvider` interface in the identity service, so we can switch providers without touching clients. A fake provider runs in development and tests.
2. **The browser never contacts the vendor.** The web app bundles a pinned version of the capture component from npm and serves it from our origin. The page posts the captured images to the gateway; identity submits them to Smile ID from the server. The CSP stays `connect-src 'self'` and no vendor script runs. Before adoption, we read the pinned component's source and add a test proving it makes no network requests.
3. **Minimum data to the vendor.** We send only the images and a random verification reference, created fresh for each attempt. We never send the account id, phone number, name, date of birth or anything health-related. Our side of the vendor account uses a neutral business name where the contract allows it.
4. **Upload path.** A dedicated gateway route, `POST /verification/capture` (not GraphQL, whose variables are capped at 16 KB), accepts one capture at a time:
   - signed-in, onboarded members only;
   - JSON with base64 images, the form the capture component already produces, so no upload library is needed. JSON also cannot be sent cross-site without a CORS preflight, which the gateway never allows;
   - at most 3 MB of images;
   - the gateway's usual rate limits, plus identity's 5 attempts an hour and 10 a day per account.

   The gateway forwards the bytes to identity over gRPC. 3 MB fits within gRPC's default 4 MB message limit, so no limit is raised.
5. **What we store** (identity database):
   - a `verification_attempts` table with the account, the provider, the provider's job reference (sealed with the account's key), the result, a coarse reason code and timestamps;
   - `accounts.verified_at` when a check passes.

   We store no scores, face templates or vendor response bodies.
6. **Selfie images.** Identity keeps the capture sealed with the member's account key (the same key as their phone number, so erasure shreds it too) in object storage for **30 days**, so a member can appeal a failed check. A retention job then deletes it. Account erasure deletes it at once (crypto-shred). Images never go into logs, events, errors or URLs.
7. **Getting the result.** Identity asks Smile ID for the job status with backoff until it has an answer, so we need no public webhook endpoint before hosting is decided. A signed webhook can be added later.
8. **Verified badge and the messaging gate.**
   - The client schema exposes `Account.verified` and the existing `verified` fields.
   - The gateway gets a `VERIFIED_FIELDS` list: it refuses those fields with `VERIFICATION_REQUIRED` until `verified_at` is set. Messaging mutations join this list when they arrive (M4), and a test locks the rule in now.
   - The gate reads the verified flag from the account state the gateway already fetches and caches for 15 seconds, not from a token claim. A pass opens the gate within 15 seconds, and a withdrawn consent closes it within 15 seconds rather than at the next token refresh. The token format is unchanged. (Changed from a `ver` claim during implementation, 2026-11-25.)
9. **A route for members who cannot pass.** Some members cannot pass an automated face check: for example, people with facial differences, facial palsy or treatment-related changes. A failed check never blocks anything except messaging. After 3 failed attempts, the member is offered a human review using the retained image. The review queue arrives with moderation (M5); until then the request goes to a support queue. Verification stays free.
10. **Consent.** A separate `biometric_verification` consent, at its own policy version, is asked right before the camera opens. It is recorded with the M1.2 consent records. Withdrawing it deletes the retained image and asks the vendor to delete its copy; the member keeps their account but loses the badge. **Needs counsel:** the consent text.

## Needs counsel (Dumisani Lukhele)
- Operator-only terms with Smile ID: no use of our members' images for its own purposes, no cross-customer face database, no model training, and deletion within a period we set.
- Where Smile ID stores and processes images, and whether a cross-border transfer of biometric data needs extra safeguards or prior authorisation under POPIA. Smile ID's own API documentation shows job uploads going to an Amazon S3 bucket in `us-west-2` (United States), so the images may leave South Africa.
- Whether the vendor knowing our brand reveals a member's likely health status, and whether the neutral-name and random-reference measures are enough.
- The `biometric_verification` consent text and our 30-day retention period.

## Consequences
- Smile ID's web component does not offer every liveness mode its mobile SDKs do. If its passive check proves too weak against spoofing in sandbox tests, we revisit this ADR before launch.
- Production needs a funded Smile ID wallet. Development runs on the free sandbox and the fake provider.
- The native app (M8) uses Smile ID's mobile SDK, which needs its own rule 7 review.
- Implementation (M1.4) is split into small PRs: contracts; identity storage and provider; gateway upload route and gate; web capture page and camera policy; retention job.
