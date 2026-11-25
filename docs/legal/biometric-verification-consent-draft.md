# Selfie check consent: DRAFT for counsel

Policy version: `biometric-verification-2026-11-draft` (ADR-0022, decision 10). **Not approved.** A real verification vendor cannot be switched on outside development while this text is a draft: identity refuses to start.

The in-app wording below is what members see before the camera opens (`apps/web/src/components/verification/BiometricConsent.tsx`). When counsel approves it, give it a dated version (for example `biometric-verification-2026-12-01`) in `services/identity/src/consent/policies.ts` and in that component.

## In-app text

**Before you take a selfie**

We ask every member to take a short selfie check. It shows other members you are a real person, and you need it before you can send messages. You can still use the rest of Chronos Place without it.

- **What we take:** a selfie and a few photos from a short video, taken with your camera. We do not ask for an ID document.
- **Who checks it:** our verification provider, Smile ID, checks the photos for us. They receive only the photos and a random code. They do not receive your name, phone number or anything about your health.
- **How long we keep it:** we keep the photos locked (encrypted) for up to 30 days, so a person can review them if the automatic check does not work for you. Then we delete them and ask Smile ID to delete their copy. We keep only whether the check passed.
- **Your choice:** you can withdraw this consent at any time. We then delete the photos straight away, ask Smile ID to delete their copy and remove your verified badge.

[ ] I agree to the selfie check as described above.

## Questions for counsel

1. Where Smile ID stores and processes the photos, and what the text must say about it (POPIA section 72, cross-border transfers of special personal information).
2. Whether "you need it before you can send messages" makes the consent conditional in a way POPIA section 27 allows, or whether another lawful basis should be stated.
3. Whether the text must name Smile ID's own retention (its POPIA policy states 90 days by default) until operator-only terms are signed.
4. Wording for members under the age of 18: none can hold an account (ADR-0018), so no wording is proposed.
