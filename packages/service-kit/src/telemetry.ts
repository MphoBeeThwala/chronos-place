import { sanitize } from '@chronos/logger';
import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { envDetector } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';

/** Attribute keys dropped outright: they carry query text or raw URLs with query strings. */
const EXTRA_REDACT = [
  'db.statement',
  'db.query.text',
  'db.query.parameter',
  'url.query',
  'http.target',
  // Error text and stacks can echo input values; the error type and the status code are kept.
  'exception.message',
  'exception.stacktrace',
];

/** Scrubs span attributes with the same rules as the logger (CLAUDE.md rule 3: no health data in traces). */
export function scrubAttributes(attributes: Attributes): Attributes {
  const clean = sanitize(attributes, { mode: 'redact', extraRedactKeys: EXTRA_REDACT }) as Record<
    string,
    unknown
  >;
  const out: Attributes = {};
  for (const [key, value] of Object.entries(clean)) {
    out[key] =
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      Array.isArray(value)
        ? (value as AttributeValue)
        : JSON.stringify(value);
  }
  return out;
}

function scrubSpan(span: ReadableSpan): ReadableSpan {
  const attributes = scrubAttributes(span.attributes);
  const events = span.events.map((event) => ({
    ...event,
    attributes: event.attributes ? scrubAttributes(event.attributes) : event.attributes,
  }));
  // Status messages are free text from error handlers; keep the code only.
  const spanStatus = { code: span.status.code };
  return new Proxy(span, {
    get(target, property) {
      if (property === 'attributes') return attributes;
      if (property === 'events') return events;
      if (property === 'status') return spanStatus;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** Wraps an exporter so nothing leaves the process without being scrubbed. */
export class ScrubbingSpanExporter implements SpanExporter {
  readonly #delegate: SpanExporter;

  constructor(delegate: SpanExporter) {
    this.#delegate = delegate;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.#delegate.export(spans.map(scrubSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.#delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#delegate.forceFlush?.() ?? Promise.resolve();
  }
}

export interface Telemetry {
  shutdown: () => Promise<void>;
}

/** Where `instrument.ts` leaves the telemetry it started, so the bootstrap does not start a second one. */
export const TELEMETRY_KEY = Symbol.for('chronos.service-kit.telemetry');

const PROBE_PATHS = new Set(['/healthz', '/readyz']);

/**
 * Starts OpenTelemetry tracing when an OTLP endpoint is configured. Only HTTP and gRPC are
 * instrumented. Database instrumentation is added with the database client, and must never capture
 * statements (they are also dropped by the scrubber).
 */
export function startTelemetry(options: {
  serviceName: string;
  endpoint?: string | undefined;
  exporter?: SpanExporter;
}): Telemetry {
  if (options.endpoint === undefined && options.exporter === undefined) {
    return { shutdown: () => Promise.resolve() };
  }
  const exporter =
    options.exporter ??
    new OTLPTraceExporter({ url: `${(options.endpoint ?? '').replace(/\/$/, '')}/v1/traces` });
  const sdk = new NodeSDK({
    serviceName: options.serviceName,
    // Only OTEL_RESOURCE_ATTRIBUTES. The default process detector would export command-line arguments,
    // which can carry secrets.
    resourceDetectors: [envDetector],
    spanProcessors: [new BatchSpanProcessor(new ScrubbingSpanExporter(exporter))],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) =>
          PROBE_PATHS.has((request.url ?? '').split('?')[0] ?? ''),
      }),
      new GrpcInstrumentation(),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
