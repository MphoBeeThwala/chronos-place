import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Accepts only short ids made of safe characters, so a header can never inject data into logs. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** Returns `candidate` when it is a safe request id, otherwise a fresh UUID. */
export function resolveRequestId(candidate?: string | null): string {
  return candidate !== undefined && candidate !== null && SAFE_REQUEST_ID.test(candidate)
    ? candidate
    : randomUUID();
}

/** Runs `fn` with a request id attached to every log line written inside it (including async work). */
export function runWithRequestId<T>(requestId: string | undefined | null, fn: () => T): T {
  return storage.run({ requestId: resolveRequestId(requestId) }, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Fields added to every log line: request id and the active OpenTelemetry trace and span ids. */
export function contextFields(): Record<string, string> {
  const fields: Record<string, string> = {};
  const requestId = currentRequestId();
  if (requestId !== undefined) fields['requestId'] = requestId;
  const span = trace.getActiveSpan();
  if (span) {
    const { traceId, spanId } = span.spanContext();
    fields['traceId'] = traceId;
    fields['spanId'] = spanId;
  }
  return fields;
}
