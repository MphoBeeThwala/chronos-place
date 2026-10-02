import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { Finding } from './finding.js';
import { parseJsonValues } from './scan.js';

/**
 * A place data can leave the system through. Every sink records the exact text that left, so the
 * scans see what an attacker or an operator would see.
 */
export interface Sink {
  readonly name: string;
  /** Everything captured, as text. */
  texts: () => string[];
  /** Captured JSON documents, for the structural scan. */
  documents: () => unknown[];
  /** Findings that are not about markers (for example a notification policy breach). */
  policyFindings?: () => Finding[];
}

/** Base for sinks that simply collect text. */
export class TextSink implements Sink {
  readonly name: string;
  protected readonly captured: string[] = [];

  constructor(name: string) {
    this.name = name;
  }

  capture(text: string): void {
    this.captured.push(text);
  }

  texts(): string[] {
    return [...this.captured];
  }

  documents(): unknown[] {
    return this.captured.flatMap((text) => parseJsonValues(text));
  }

  clear(): void {
    this.captured.length = 0;
  }
}

/** Collects log lines. Pass `destination` to `createLogger`, or to pino for a deliberately leaky logger. */
export class LogSink extends TextSink {
  readonly destination = {
    write: (chunk: string): void => {
      this.capture(chunk);
    },
  };

  constructor() {
    super('logs');
  }
}

/** Collects what would be published to Kafka: the topic, the key and the encoded event. */
export class EventSink extends TextSink {
  constructor() {
    super('events');
  }

  publish(topic: string, event: unknown, key?: string): void {
    this.capture(JSON.stringify({ topic, key: key ?? null, event }));
  }
}

export interface RecordedResponse {
  method: string;
  url: string;
  status: number;
  body: string;
}

/** Collects HTTP traffic: request URLs (including query strings) and response bodies. */
export class HttpSink extends TextSink {
  constructor() {
    super('http');
  }

  record(response: RecordedResponse, options: { recordRequestUrl?: boolean } = {}): void {
    // The URL is recorded separately: query strings are a leak path of their own (CLAUDE.md rule 3).
    if (options.recordRequestUrl !== false) this.capture(`${response.method} ${response.url}`);
    this.capture(response.body);
  }

  /**
   * A `fetch` that records what it receives. By default it records the request URL as well, which is
   * right for code that calls other services. Pass `recordRequestUrl: false` when the test itself
   * chooses the URL (it is then an input, not something the service emitted).
   */
  recordingFetch(options: { recordRequestUrl?: boolean } = {}): typeof fetch {
    return async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const response = await fetch(input, init);
      this.record(
        {
          method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
          url,
          status: response.status,
          body: await response.clone().text(),
        },
        options,
      );
      return response;
    };
  }
}

/** Collects gRPC error responses (code, details and message). */
export class GrpcSink extends TextSink {
  constructor() {
    super('grpc');
  }

  recordError(error: unknown): void {
    const { code, details, message } = (error ?? {}) as {
      code?: unknown;
      details?: unknown;
      message?: unknown;
    };
    this.capture(
      JSON.stringify({ code: code ?? null, details: details ?? null, message: message ?? null }),
    );
  }
}

/** Collects exported spans. Use `exporter` where a service would export, or `capture` for raw OTLP bytes. */
export class TraceSink extends TextSink implements SpanExporter {
  constructor() {
    super('traces');
  }

  readonly exporter: SpanExporter = this;

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      this.capture(
        JSON.stringify({
          name: span.name,
          attributes: span.attributes,
          events: span.events.map((e) => ({ name: e.name, attributes: e.attributes })),
          status: span.status,
        }),
      );
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Notification {
  channel: 'push' | 'email' | 'sms';
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * What a notification may say. The text must be one of a few generic sentences (TECHNICAL_SPEC 9:
 * "Never names or content"), and `data` may hold only ids and a type, so a notification cannot
 * carry anything about the sender, the message or health.
 */
export interface NotificationPolicy {
  allowedTexts: readonly string[];
  allowedDataKeys: readonly string[];
}

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  allowedTexts: ['You have a new message', 'You have a new match', 'Chronos'],
  allowedDataKeys: ['type', 'matchId', 'conversationId'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collects push, email and SMS payloads and checks them against the policy. */
export class NotificationSink extends TextSink {
  readonly #policy: NotificationPolicy;
  readonly #policyFindings: Finding[] = [];

  constructor(policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY) {
    super('notifications');
    this.#policy = policy;
  }

  send(notification: Notification): void {
    this.capture(JSON.stringify(notification));
    for (const field of ['title', 'body'] as const) {
      if (!this.#policy.allowedTexts.includes(notification[field])) {
        this.#policyFindings.push({
          sink: this.name,
          type: 'policy',
          detail: `${notification.channel} ${field} is not one of the approved generic texts`,
          excerpt: notification[field].slice(0, 60),
        });
      }
    }
    for (const [key, value] of Object.entries(notification.data ?? {})) {
      const allowed = this.#policy.allowedDataKeys.includes(key);
      const simple =
        key === 'type'
          ? typeof value === 'string' && /^[a-z_]{1,24}$/.test(value)
          : typeof value === 'string' && UUID.test(value);
      if (!allowed || !simple) {
        this.#policyFindings.push({
          sink: this.name,
          type: 'policy',
          detail: `${notification.channel} data field "${key}" is not allowed (ids and a type only)`,
        });
      }
    }
  }

  policyFindings(): Finding[] {
    return [...this.#policyFindings];
  }
}
