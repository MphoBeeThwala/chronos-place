# ADR-0024: Photo pipeline

Status: Accepted (2026-11-25, product owner approved decisions a–f).

## Context
- TASKS M1.6: signed uploads, EXIF and GPS stripping, size variants and a moderation status hook. AC: GPS metadata absent in stored images (test).
- PRD: up to 6 profile photos. Metadata such as GPS is stripped from photos, and uploads are moderated.
- A photo's metadata can hold the exact place it was taken, often the member's home. On this platform that can out someone (CLAUDE.md rules 3 and 8).
- Hosting is undecided (ADR-0011 still says AWS), so storage is plain S3-compatible: SeaweedFS locally (ADR-0013).

## Decisions
- **a. Upload straight to storage, into quarantine.**
  - **Upload link:** the profile service issues a presigned `PUT` for a random key in a private quarantine bucket. It is valid for 5 minutes and signs the content type and exact byte length (at most 10 MB), so nothing else can be sent with it.
  - **Finishing:** the member then calls "complete", and nothing is used until the server has processed the file.
  - **Browser rule:** the web app must be allowed to `PUT` to that one storage origin (`connect-src`, M1.9). It is our own bucket, not a third party.
- **b. Every photo is re-encoded, never copied.**
  - **Processing:** the server decodes the upload with **sharp** (libvips, Apache-2.0, the standard Node image library) and applies the orientation. It then writes new files from the pixels alone, so EXIF (including GPS), XMP, IPTC, comments, thumbnails and colour profiles are not carried over.
  - **The original** is deleted from quarantine straight after processing.
  - **Accepted input:** JPEG, PNG and WebP, sniffed from the bytes rather than the stated type. At most 40 megapixels (decompression-bomb guard), at least 200 pixels on the short side, and one frame only.
- **c. Three sizes:** 320, 640 and 1280 px on the long side, WebP quality 80, never upscaled.
- **d. Private storage, short-lived links.**
  - **Storage:** processed files go to a private media bucket under random keys (`photos/<random id>/<size>.webp`), with nothing about the member in the key.
  - **Viewing:** clients get presigned `GET` links valid for 1 hour, so a leaked link stops working and a deleted photo cannot be fetched. A CDN with signed URLs can replace this when hosting is chosen.
- **e. Moderation hook.**
  - **Status:** every photo starts `pending`. Other members only ever see `approved` photos; the owner sees all of theirs, with the status.
  - **Approval:** a `PhotoModerator` interface decides. Development approves automatically; elsewhere photos stay `pending` until moderation (M5) plugs in.
  - **Consequence:** no photo is public outside development until M5 exists.
- **f. Limits:** up to 6 photos per member, in positions 0–5. They can be reordered and deleted; deletion removes every size at once.
  - **Upload rate (approved 2026-11-25):** at most 20 photo uploads started per member per hour, counted at the gateway in Redis on top of the ADR-0021 limits. Processing costs CPU, and the 6-photo cap alone does not stop delete-and-re-upload loops. Over the limit: `RATE_LIMITED` with `retryAfterSeconds`.

## Consequences
- New dependencies: `sharp` (native libvips, prebuilt for linux-x64 and arm64) and `@aws-sdk/s3-request-presigner` (the same SDK family as `@aws-sdk/client-s3`). The service image must use glibc or sharp's musl build; Trivy scans cover libvips.
- Buckets need lifecycle rules when infra creates them: quarantine objects expire after 1 day, as a backstop to the deletion after processing.
- The `photo.uploaded` event in the spec is emitted once Kafka is wired (ADR-0019); the moderation hook covers M1.6 without it.
- Account erasure (M1.8) must delete a member's media objects as well as their rows.
