# ADR-0010: PRD and spec conflicts resolved

| Topic | Conflict | Resolution |
| --- | --- | --- |
| Product name | PRD file and header read "Kindred" while the body says Chronos Place | Chronos Place is the development title (PRD open questions). Code uses the `@chronos/*` scope. The final name is a rename task, not an architecture issue. **Needs product owner:** confirm Kindred is retired. |
| Premium "message before matching" vs spec "messaging only between matched members" | Both cannot hold | Matched-only messaging stays the default. Premium pre-match messages are deferred and must be designed as a limited intro request that does not weaken the block and disclosure rules. **Needs product owner.** |
| Condition-aware filter flag | PRD lists it under Preference (Internal); spec puts filter settings in the vault | Vault wins. The wanted-condition list and opt-in imply health status, so they are Restricted. |
| Private mode | PRD marks P1; TASKS M1.5 includes it | Build the data flag in M1.5, ship the feature as P1. |
| OpenSearch | PRD lists it; spec does not | See ADR-0007. |
| Account deletion timing | PRD: vault crypto-shred immediately, profile data within 30 days | Adopted as the single rule: shred on request, erase everything else within 30 days. |
| Docs location | CLAUDE.md expects `docs/PRD.md` | PRD is stored as `docs/PRD.pdf`; CLAUDE.md updated. |
