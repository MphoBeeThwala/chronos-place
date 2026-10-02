# @chronos/privacy-harness

Plants synthetic markers and fails if they reach anything that leaves the system (CLAUDE.md rule 3). Run it with `pnpm test:privacy`.

```ts
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';

describe('profile service', () => {
  const privacy = usePrivacyHarness(); // fresh sinks per test; the test fails if a sink saw a leak

  it('does not leak a condition', async () => {
    const code = privacy.markers.conditionCode();
    const logger = createLogger({ service: 'profile', destination: privacy.logs.destination });
    await handleRequest({ logger, conditions: [code] });
    // no assertions needed: afterEach scans every sink
  });
});
```

## What it watches

| Sink            | Captures                                        | Notes                                             |
| --------------- | ----------------------------------------------- | ------------------------------------------------- |
| `logs`          | log lines                                       | pass `logs.destination` to `createLogger`         |
| `events`        | what would go to Kafka                          | `events.publish(topic, event)`                    |
| `http`          | response bodies, request URLs and query strings | `http.recordingFetch()`                           |
| `grpc`          | gRPC error code, details and message            | `grpc.recordError(error)`                         |
| `traces`        | exported spans or raw OTLP bytes                | `traces.exporter`, `traces.capture(body)`         |
| `notifications` | push, email, SMS                                | generic texts and id-only data enforced by policy |

Add more with `harness.addSink(...)` (cache keys, metrics) when those features exist.

## How it detects

- **Marker scan:** values from `privacy.markers` (health text, condition code, email, phone, coordinate, secret) are searched for raw, in any case, percent- and form-encoded, hex, JSON-escaped, base64 and base64url at every alignment, and digits-only for phones. Markers are random per run; a failure prints `PRIVACY_SEED=...` to reproduce it.
- **Structural scan:** any captured JSON field whose name is sensitive (health, contact, credentials, location, ciphertext) must hold a redacted value. This catches data the test did not plant.
- **Notification policy:** only the approved generic texts, and `data` limited to ids and a plain type.

## Limits

It cannot see a leak that was never captured, or an exotic transform (splitting a value, ROT13). Health text under an innocent field name such as `detail` is invisible to the logger: that is exactly the case this harness exists for, and `harness.privacy.test.ts` plants it on purpose.

## Conventions

- Files named `*.privacy.test.ts` are excluded from `pnpm test` and run by `pnpm test:privacy`, which is its own CI job.
- `harness.privacy.test.ts` plants one leak per sink in a real service and asserts each is caught. If that file fails, the harness is broken, not the code under test.
- Only synthetic values, ever (rule 6).
