# ADR-0027: Ranking v1

Status: Accepted (2026-11-26, product owner approved decisions a–c and the M3.3 plan).

## Context
- **TASKS M3.3:** rules-based ranking from recency, activity, completeness and mutual preference fit. AC: deterministic tests; ranking features contain no health data.
- **ADR-0007** chose rules-based, deterministic ranking.
- **ADR-0026** builds the feed from profile's candidates, filtered by matching, and keeps it for 15 minutes as account ids.
- **Some members may avoid photos** for safety, for example so they aren't recognised as living with a condition.

## Decisions
- **a. Five signals, each 0 to 100, with balanced weights (points out of 100):**

  | Signal | Weight | Score |
  |---|---|---|
  | Closeness | 30 | 100 next door, 0 at the viewer's distance limit |
  | Activity | 25 | 100 active today, 60 this week, 30 this month, 0 longer ago |
  | Mutual fit | 20 | 50 if the candidate's own intents include the viewer's, 50 if the viewer is within the candidate's own distance |
  | Completeness | 15 | Bio 20, prompts 25 (by count, of 3), interests 10 (of 3), verified 25, photo 20 |
  | New member | 10 | 100 on the day they joined, fading to 0 after 14 days |

  The score is the weighted sum. A signal outside 0 to 100 is held to it. Equal scores keep profile's nearest-first order, so the same candidates always come out in the same order.
- **b. Photos count lightly.** One approved photo earns the photo's 20 points; more add nothing. A pending or rejected photo earns none. Bio, prompts and the verified badge carry the rest.
- **c. Activity is used for ordering only.**
  - Identity works it out from its sessions' `last_used_at`, the signal sign-in already keeps (ADR-0018), in four coarse buckets.
  - It only does so when asked (`include_activity`), and only discovery's candidate path asks.
  - It is never shown to anyone, never returned with a profile, and never stored. The feed cache keeps only the order.
- **Where the signals are worked out:**
  - Profile computes closeness, mutual fit, newness and most of completeness in the candidate query, for the page's rows only.
  - Identity's verified badge and activity are added from member facts.
  - Discovery holds the weights (`services/discovery/src/feed/ranking.ts`) and ranks.
- **Pool:** discovery ranks everyone on the candidate pages it reads (up to 500 a page) and keeps the top 200. It reads another page only while fewer than 200 remain, as before. A second page would cost more than ranking gains: a pool of 600 put the first page at p95 432 ms.

## Consequences
- **No health data, no distance and no date is a signal.** Profile sends discovery five integers per candidate; tests check the keys.
- **Speed is unchanged.** With 200,000 synthetic members, a first page (with cards) is p95 143 ms and the next is p95 10 ms (target 300 ms).
- **Changing the weights is a product decision.** They're constants, and tests pin them.
- **Learned ranking** stays out of scope (ADR-0001 and ADR-0007).
