# ADR-0007: Ranking and search

## Decision
- Ranking v1 is rules-based and deterministic (recency, activity, profile completeness, mutual preference fit). Ranking features never include health data.
- Candidate generation uses PostGIS (distance, GiST index) plus Postgres filters, with precomputed feeds cached in Redis. The PRD's OpenSearch is deferred; it is not needed to reach 150k DAU and adds a second store holding profile data that would need the same erasure and privacy controls.
- Revisit when feed p95 exceeds 800 ms under load or filter combinations outgrow Postgres.

## Why
Fewer data stores means fewer places for personal data to leak, simpler erasure, and less to run on day one. Moving to OpenSearch later is a contained change behind the discovery service.
