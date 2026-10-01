# @chronos/logger

The only way service code may log (CLAUDE.md rule 4). Built on pino, JSON lines to stdout.

```ts
import { createLogger, runWithRequestId } from '@chronos/logger';

const logger = createLogger({ service: 'profile' });
logger.info({ accountId, durationMs }, 'profile updated');
```

- **Redaction cannot be turned off.** Keys for credentials, contact details, location, health data and ciphertext are masked (`src/keys.ts`); values that look like emails, phone numbers, JWTs, bearer tokens are scrubbed; URL query strings are dropped. `extraRedactKeys` can only add to the list.
- **Allow-list mode** (`mode: 'allowlist'`, for `restricted/` services): only `allowedFields` and a small set of safe base fields are written. Everything else is dropped and counted in `droppedFields`. Error messages and stacks are never written.
- **No printf interpolation:** extra arguments are never formatted into the message.
- **Request and trace ids:** wrap request handling in `runWithRequestId(header, fn)`. Every line inside gets `requestId`, plus `traceId` and `spanId` from the active OpenTelemetry span. Incoming ids are accepted only if they are short and made of safe characters.
- Output is bounded: depth 6, 20 array items, 1000 characters per string.

Tests use synthetic markers only. Never log real personal or health data, even in tests.
