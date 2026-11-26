# ADR-0023: Profile service

Status: Accepted (2026-11-25, product owner approved decisions a–i, and that private mode is never paywalled).

## Context
- TASKS M1.5: profiles, prompts, preferences, approximate location (PostGIS) and private mode. AC: other members never receive coordinates; distance is rounded to at least 1 km.
- PRD: up to 6 photos, prompts, interests and relationship intent (P0). Approximate location only. Private mode is P1; ADR-0010 builds its data flag now.
- CLAUDE.md rules 1, 3 and 8: no health data outside the restricted zone, nothing that implies it in logs, and never another member's coordinates or a distance finer than 1 km.

## Decisions
- **a. Location is blurred before it is stored.**
  - **Storage:** coordinates are snapped to a grid of about 1 km, so the database never holds an exact location.
  - **Distance shown to others:** whole kilometres, at least 1 km. Above 10 km it is rounded to the nearest 5 km.
  - **Why:** rounding the displayed distance alone does not stop someone faking several positions and working out where a member is from the distances (trilateration).
- **b. Where the location comes from:** a single "Use my location" control. The browser blurs the position before sending it, and geolocation is allowed on that route only. No outside map or geocoding service is used. The area name is optional free text the member types.
- **c. Interests:** a fixed catalogue of tags, up to 5 per member.
- **d. Prompts:** a fixed catalogue of questions, none about health, up to 3 answers of 300 characters each. The catalogue (`services/profile/src/catalogue.ts`) is draft copy for the product owner. Ids are stable and never reused.
- **e. No database links to other services.**
  - **Storage:** the service owns the `profile` schema in the core database, keyed by account id.
  - **Deletion:** account erasure removes the rows through the erasure flow (M1.8).
  - **PostGIS:** installed by the first migration.
- **f. Age shown to others:** identity answers with whole years only (a new RPC, part 2). The profile service never stores a date of birth.
- **g. When a profile is created:** at the first save, which needs a display name and an intent. Until then `GetOwnProfile` answers `NOT_FOUND` ("Create your profile first."). Preferences start at their defaults.
- **h. Limits:**
  - **Text:** display name 1–30 characters, bio 500, gender and pronouns 30 each, area name 40. Characters are counted as people see them (grapheme clusters).
  - **Preferences:** ages 18–99, with 18 a hard floor enforced in code and by a database check. Distance 1–300 km.
  - **Defaults:** 18–99, 50 km, every intent, everyone.
- **i. Health in free text.**
  - **What we accept:** members may mention a condition in their bio or prompt answers. We do not scan or block it.
  - **What the app does:** says under those fields that health details have their own private section.
  - **Logs:** these texts are never logged (privacy test).
  - **Counsel:** told that this text sits outside the Health Vault.
- **Private mode is free.** It is a privacy control, and the PRD promises no paywalls on privacy controls, so it is not part of the Plus tier, at least for now.
- **Until M3, private means hidden.** Private mode shows a profile only to members the owner liked, which the profile service cannot know yet. So `GetPublicProfiles` leaves private profiles out entirely; discovery (M3) will show them to the members they liked. *Done in M3.2: matching now decides, so a private profile shows to the members its owner liked ([ADR-0026](0026-discovery-candidates.md) d).*
- **Grid size.** "About 1 km" is a 0.01-degree grid: about 1.1 km north to south and about 1 km east to west at South African latitudes. Distances are measured between snapped points in PostGIS, so two members in the same cell are shown as 1 km apart.

## Consequences
- Members' text is cleaned before storage: NFC normalisation, no control or direction-override characters, trimmed. Error messages never echo it.
- Photos arrive with M1.6, the editing screens with M1.7, and the discovery queries that use location and private mode with M3.
- M6 pricing must not list private mode as a paid feature.
