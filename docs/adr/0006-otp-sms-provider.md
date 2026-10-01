# ADR-0006: OTP and SMS provider

## Decision
Define an `OtpSender` interface in the identity service. Primary provider: a South African aggregator (Clickatell or Infobip, chosen on price and delivery rate in a short bake-off). Fallback: a second provider on a different route. Message text is fixed ("Your code is 123456") and never mentions the app name, a condition or a health term, so a message on a lock screen does not out the member.

## Rules
- Phone numbers are Confidential: encrypted at rest, never logged in full (last 2 digits only).
- Rate limits per number, per device and per IP; code hashed server-side, 5-minute expiry, 5 attempts.
- Email OTP (PRD allows phone or email) uses the same interface via SES in af-south-1.
- WhatsApp OTP is a later provider behind the same interface.

## Needs external input
Commercial terms, sender-ID registration and delivery rates per network must be validated with the shortlisted providers.
