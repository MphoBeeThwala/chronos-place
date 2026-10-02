# ADR-0003: End-to-end encrypted messaging

## Decision
- Protocol: Signal Protocol (PQXDH + Double Ratchet) using Signal's official `libsignal` (Rust core).
- Mobile integration: a first-party Expo native module (Turbo Module) that wraps the official libsignal Swift (iOS) and Java/Kotlin (Android) bindings. No JavaScript re-implementation and no unaudited community port.
- Server: the messaging service stores identity keys, signed prekeys, one-time prekeys and encrypted envelopes until delivered (30 days maximum). It sees no content.
- Key storage on device: Keychain/Keystore via Expo SecureStore, with the app lock layered on top.
- Reporting: the reporter's app decrypts selected messages locally and submits them to moderation, encrypted to a moderation public key. Only those messages are ever readable by staff.
- Multi-device is out of scope at GA (one device per account); the key directory schema must allow adding devices later (device ID in every key record).
- Media (photos, voice notes) is encrypted client-side with a per-file key sent inside the message; S3 holds ciphertext only.

## Spike (M4.1)
M4.1 is retained but narrowed to verify build and size on Android 9 with 2 GB RAM, and to confirm libsignal licensing (AGPL-3.0) obligations with counsel. **Needs external input:** libsignal is AGPL; legal must confirm how that applies to a closed-source app before M4.2 starts.

## Consequences
We take on a native module to maintain. This is the cost of avoiding custom crypto.
