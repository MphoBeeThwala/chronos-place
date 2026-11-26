# Synthetic seed data

Synthetic members only (CLAUDE.md rule 6): no real person, number or health detail, ever. Every id starts with `5eed`, so seeded rows can be found and removed.

- **Who:** 200,000 members by default, deterministic from a seed:
  - 25,000 around Johannesburg, 15,000 in Ekurhuleni and 15,000 in Pretoria;
  - Cape Town, Durban and other metros;
  - the rest rural.
- **What each member gets:**
  - an active (or occasionally suspended) account with a date of birth and no phone;
  - a profile with a location snapped to the 1 km grid (5% share none);
  - preferences, private mode for 5% and paused for 4%.
- **Likes and passes:** one member in ten has decided on about 30 others nearby.
- **Health data is never seeded here.** The vault has its own synthetic fixtures behind the Disclosure Service.

```
pnpm db:migrate                  # first
pnpm seed                        # 200,000 members
pnpm seed --members 5000         # fewer
pnpm seed --reset                # replace earlier seeded members (removes only 5eed… rows)
```

It refuses any database not on this machine or in the local Docker stack, and refuses `NODE_ENV=production`.

The M3.2 speed test (`pnpm test:speed`, in `tools/acceptance`) seeds a fresh database with the same generator.
