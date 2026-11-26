# ADR-0026: Discovery candidates

Status: Accepted (2026-11-26, product owner approved decisions a–d and the M3.2 plan).

## Context
- **TASKS M3.2:** candidate generation with geo, age and intent filters. It must exclude members already seen, blocked members and members in private mode. AC: p95 under 300 ms at seeded scale.
- **Spec 2:** discovery owns "candidate generation, geo filtering, ranking, feed precomputation", stored as feed caches (Redis) and ranking features. It lists no database of its own.
- **Where the data already lives:**
  - Locations (snapped to about 1 km), intents, genders and preferences are in profile (ADR-0023).
  - Dates of birth are in identity.
  - Likes, passes, matches and blocks are in matching (M3.1).
- **Private mode (ADR-0023):** a private profile is shown only to members its owner liked. Until matching existed, private profiles were hidden from everyone.

## Decisions
- **a. No new copy of member data.** Each service filters with what it already holds:
  1. **Profile `FindCandidates`** returns visible members with a location within the viewer's distance, the viewer's intents, and gender fitting both members' preferences. They are ordered nearest first and paged by distance and id. Each comes with the private-mode flag only: no coordinates, no distances.
  2. **Identity `GetMemberFacts`** (now up to 1000 ids) gives ages. Profile keeps those inside the viewer's age range, and only active accounts.
  3. **Matching `FilterCandidates`** removes:
     - anyone blocked either way;
     - anyone the viewer already liked or passed;
     - anyone the viewer was ever matched with (an unmatch is final);
     - private members who have not liked the viewer.
  4. **Discovery** caches the resulting id list in Redis and pages through it (M3.2 PR2).

  The rejected alternative was a read model in discovery, fed by events. It would copy locations and dates of birth into another store and onto Kafka, add a place erasure must reach, and need its own sync. This design adds no table and sends no member data over Kafka.
- **b. Age and gender must fit both ways.**
  - A candidate is offered only when the viewer is inside the candidate's age range, and the candidate inside the viewer's.
  - The same holds for gender: an empty gender list means everyone. A member with no gender set fits only those who accept everyone.
  - Intent and distance use the viewer's settings only. Mutual fit beyond these hard filters is ranking (M3.3).
- **c. No location, no feed.** A viewer without a location gets outcome `NO_LOCATION`, and the app asks them to share their area. Members without a location are never candidates, because distance matters on a dating app.
- **d. Private mode is enforced by matching.** `FilterVisible` takes the private candidates' ids and keeps them only if they liked the viewer. `GetPublicProfiles` therefore shows a private profile to the members its owner liked, everywhere: feed, matches and health viewers. Nobody is told that a profile is private.

## Consequences
- **Several calls per page.** A discovery page costs one PostGIS query, one identity call and one matching call. The speed test in M3.2 PR3 checks this against the 300 ms target.
- **A member who has seen everyone nearby** can need several candidate pages before new faces appear. Discovery fetches pages until it has enough or none are left.
- **Rule 8 holds.** Profile never returns a coordinate or a distance to discovery, only the order, and the cursor discovery passes back is opaque.
- **The feed cache holds only account ids** and expires (15 minutes, approved), so discovery is not on identity's erasure confirmation list. An erased member drops out of every feed when the cache expires, and profile stops showing them at once.
