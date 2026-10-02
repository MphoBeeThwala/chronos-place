# ADR-0008: Feature flags

## Decision
Use the OpenFeature API in services and the app, backed by self-hosted Unleash. The PRD requires a flag on every release. Flags and targeting rules never use health attributes; targeting is by opaque account cohort, platform and app version only.

## Why
OpenFeature avoids vendor lock-in; self-hosting keeps evaluation context in-region.
