# ADR-0011: Cloud provider and optional Cloudflare edge

## Decision
- The data plane (compute, databases, keys, queues, storage) stays on AWS af-south-1. Cloudflare is not a replacement for it.
- Cloudflare may be added in front of the gateway for CDN, DDoS protection, bot defence and staff sign-in (Access). This is optional and not part of M0 to M2.
- Key wrapping in `@chronos/crypto` (M0.6) sits behind a provider interface so a later move to another cloud's HSM-backed KMS does not touch vault code.

## Why not Cloudflare for the data plane
No in-country pinning of primary data for Workers, D1 or R2; no PostGIS; no Kafka; no HSM-backed custom key store or separate-account boundary equivalent to the restricted zone; Workers are a poor fit for NestJS and long-running gRPC. Verify against current Cloudflare documentation before any revisit.

## Open question (needs privacy counsel)
A proxying CDN decrypts traffic at its edge, so health responses would pass through it. Options: exclude the health GraphQL path from the proxy, or accept it under an operator agreement and transfer review. Until counsel decides, no health traffic goes through any third-party proxy.

## Alternatives if AWS is rejected
Azure (South Africa North/West) or Google Cloud (Johannesburg). Only M0.11 and the KMS adapter change.
