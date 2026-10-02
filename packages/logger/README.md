# @chronos/logger

The only way service code may log (CLAUDE.md rule 4). Built on pino, JSON lines to stdout.

```ts
import { createLogger, runWithRequestId } from '@chronos/logger';

const logger = createLogger({ service: 'profile' });
logger.info({ accountId, durationMs }, 'profile updated');
```

- **Redaction cannot be turned off.** Keys for credentials, contact details, location, health data and ciphertext are masked (`src/keys.ts`); values that look like emails, phone numbers, JWTs, bearer tokens are scrubbed; URL query strings are dropped. `extraRedactKeys` can only add to the list.
- **Allow-list mode** (`mode: 'allowlist'`, for `restricted/` services): only `allowedFields` and a small set of safe base fields are written. Everything else is dropped and counted in `droppedFields`. Error messages and stacks are never written.
- **Static messages only:** the message text is free text in every mode, so it is never sanitised by key. The lint rule `chronos/static-log-messages` (enabled for `services/`, `restricted/`, `apps/` and `packages/service-kit/src`) rejects any message that is not a string literal, an expression-free template, a literal concatenation, or a same-file `const` string. Put variable data in the fields object:

  ```ts
  logger.info({ count }, 'items loaded'); // ok
  logger.info(`loaded ${count} items`); // error
  logger.error({ err }, 'request failed'); // ok: err goes through redaction
  logger.error(err.message); // error
  ```

  A logger call is recognised by receiver name (`log`, `logger`, `*Logger`, `*Log`, `this.logger`) or by being the result of `.child(...)`. A logger stored under any other name is not checked, so name loggers `logger`. The rule cannot be disabled inline.

- **No printf interpolation:** extra arguments are never formatted into the message.
- **Request and trace ids:** wrap request handling in `runWithRequestId(header, fn)`. Every line inside gets `requestId`, plus `traceId` and `spanId` from the active OpenTelemetry span. Incoming ids are accepted only if they are short and made of safe characters.
- Output is bounded: depth 6, 20 array items, 1000 characters per string.

Tests use synthetic markers only. Never log real personal or health data, even in tests.
