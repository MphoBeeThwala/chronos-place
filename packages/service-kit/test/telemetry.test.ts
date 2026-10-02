import { createServer, type Server } from 'node:http';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapService, scrubAttributes, ScrubbingSpanExporter } from '../src/index.js';
import {
  call,
  captureLogger,
  ECHO_PROTO,
  EchoModule,
  freePort,
  grpcClients,
  MARKER,
} from './helpers.js';
import path from 'node:path';

describe('scrubAttributes', () => {
  it('redacts sensitive keys and drops statements and query strings', () => {
    const clean = scrubAttributes({
      conditions: MARKER,
      'user.email': 'a.b@example.test',
      note: 'call +27 82 555 0100',
      'db.statement': `select * from t where c = '${MARKER}'`,
      'db.query.text': MARKER,
      'url.query': `condition=${MARKER}`,
      'http.url': `https://api.example.test/feed?condition=${MARKER}&x=1`,
      'http.target': `/feed?condition=${MARKER}`,
      'http.status_code': 200,
      'rpc.method': 'Echo',
      list: ['ok', 'b@example.test'],
    });
    const text = JSON.stringify(clean);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('a.b@example.test');
    expect(text).not.toContain('b@example.test');
    expect(text).not.toContain('555 0100');
    expect(clean['http.status_code']).toBe(200);
    expect(clean['rpc.method']).toBe('Echo');
    expect(clean['http.url']).toBe('https://api.example.test/feed');
  });
});

describe('ScrubbingSpanExporter', () => {
  it('scrubs attributes, events and status messages before export, and keeps span identity', () => {
    const inner = new InMemorySpanExporter();
    const source = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(source)] });
    const span = provider.getTracer('test').startSpan('GET /feed');
    span.setAttributes({ healthStatus: MARKER, 'db.statement': MARKER, 'rpc.method': 'Echo' });
    span.addEvent('exception', {
      'exception.message': `failed for a.b@example.test ${MARKER}`,
      conditions: MARKER,
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'bad request from a.b@example.test' });
    span.end();

    const [original] = source.getFinishedSpans();
    if (!original) throw new Error('no span');
    new ScrubbingSpanExporter(inner).export([original], () => undefined);
    const [exported] = inner.getFinishedSpans();

    expect(exported?.name).toBe('GET /feed');
    expect(exported?.spanContext().traceId).toBe(original.spanContext().traceId);
    expect(exported?.attributes['rpc.method']).toBe('Echo');
    const everything = JSON.stringify({
      a: exported?.attributes,
      e: exported?.events,
      s: exported?.status,
    });
    expect(everything).not.toContain(MARKER);
    expect(everything).not.toContain('a.b@example.test');
    // The original span is untouched.
    expect(JSON.stringify(original.attributes)).toContain(MARKER);
  });
});

describe('OTLP export from a running service', () => {
  let collector: Server | undefined;
  afterEach(() => {
    collector?.close();
  });

  it('sends scrubbed spans to the collector', async () => {
    const bodies: string[] = [];
    const collectorPort = await freePort();
    collector = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        if (request.url === '/v1/traces') bodies.push(Buffer.concat(chunks).toString('latin1'));
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    }).listen(collectorPort, '127.0.0.1');

    const httpPort = await freePort();
    const grpcPort = await freePort();
    const service = await bootstrapService({
      module: EchoModule,
      grpc: { packageName: 'chronos.test.v1', protoPath: ECHO_PROTO },
      env: {
        NODE_ENV: 'test',
        SERVICE_NAME: 'telemetry-test',
        HTTP_PORT: String(httpPort),
        GRPC_PORT: String(grpcPort),
        SHUTDOWN_DRAIN_MS: '0',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(collectorPort)}`,
      },
      logger: captureLogger().logger,
      onInvalidConfig: 'throw',
      installSignalHandlers: false,
      exit: () => undefined,
    });
    const clients = grpcClients(
      grpcPort,
      path.resolve(import.meta.dirname, '../proto/grpc/health/v1/health.proto'),
    );
    await call(clients.echo.echo({ text: 'hello' }));
    await fetch(`http://127.0.0.1:${String(httpPort)}/missing?condition=${MARKER}`);
    clients.close();
    await service.shutdown('test');

    const sent = bodies.join('\n');
    expect(sent).toContain('telemetry-test');
    expect(sent).toContain('EchoService/Echo');
    expect(sent).not.toContain(MARKER);
  });
});
