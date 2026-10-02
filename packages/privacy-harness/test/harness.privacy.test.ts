import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ScrubbingSpanExporter } from '@chronos/service-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrivacyHarness, type Finding, type PrivacyHarness } from '../src/index.js';
import { startCollector, startProbe, type Probe } from './fixtures/probe-service.js';

/**
 * The acceptance test for the harness: leaks planted in a real service are detected, in the right
 * sink, and the well-behaved routes of the same service are not accused.
 */
describe('planted leaks are detected', () => {
  let harness: PrivacyHarness;
  let probe: Probe;

  beforeEach(async () => {
    harness = createPrivacyHarness({ seed: 'planted-leaks' });
    probe = await startProbe({ harness });
  });
  afterEach(async () => {
    await probe.stop();
  });

  const get = (path: string): Promise<Response> =>
    harness.http.recordingFetch({ recordRequestUrl: false })(`${probe.http}${path}`);
  const sinksOf = (findings: Finding[]): string[] => [...new Set(findings.map((f) => f.sink))];

  it('a logger that bypasses redaction', async () => {
    const note = harness.markers.conditionCode();
    await get(`/leak/log?note=${encodeURIComponent(note)}`);
    const findings = harness.scan().filter((f) => f.sink === 'logs');
    expect(findings.map((f) => f.type)).toEqual(
      expect.arrayContaining(['marker', 'unredacted-field']),
    );
    expect(findings.find((f) => f.type === 'marker')).toMatchObject({
      markerKind: 'health',
      form: 'raw',
    });
  });

  it('health text under a harmless field name (what the logger cannot know)', async () => {
    const note = harness.markers.healthText();
    await get(`/leak/field?note=${encodeURIComponent(note)}`);
    expect(sinksOf(harness.scan())).toEqual(['logs']);
    expect(() => {
      harness.assertClean();
    }).toThrow(/PRIVACY_SEED=planted-leaks/);
  });

  it('an error response that echoes input', async () => {
    const note = harness.markers.healthText();
    const response = await get(`/leak/body?note=${encodeURIComponent(note)}`);
    expect(response.status).toBe(500);
    expect(sinksOf(harness.scan())).toEqual(['http']);
  });

  it('a response body that echoes a marker, even encoded', async () => {
    const note = harness.markers.secret();
    // The route echoes what it receives; sending base64 shows the scan sees through the encoding.
    await get(`/leak/echo?note=${encodeURIComponent(note)}`);
    expect(harness.scan().find((f) => f.sink === 'http')?.form).toBe('raw');
    const other = createPrivacyHarness({ seed: 'encoded' });
    other.http.record(
      {
        method: 'GET',
        url: '/x',
        status: 200,
        body: JSON.stringify({ blob: Buffer.from(other.markers.secret()).toString('base64') }),
      },
      { recordRequestUrl: false },
    );
    expect(other.scan().map((f) => f.form)).toContain('base64');
  });

  it('a query string that carries a marker in an outgoing request', async () => {
    const note = harness.markers.conditionCode();
    await harness.http.recordingFetch()(
      `${probe.http}/clean/domain?filter=${encodeURIComponent(note)}`,
    );
    const findings = harness.scan().filter((f) => f.sink === 'http');
    expect(findings.some((f) => f.form === 'raw' || f.form === 'percent-encoded')).toBe(true);
  });

  it('an event with a stray field', () => {
    harness.events.publish('match.created', {
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      data: { matchId: 'x', note: harness.markers.healthText() },
    });
    expect(sinksOf(harness.scan())).toEqual(['events']);
  });

  it('an event that carries health data in a field named for it', () => {
    harness.events.publish('profile.updated', { conditions: ['anything at all'] });
    expect(harness.scan().map((f) => f.type)).toEqual(['unredacted-field']);
  });

  it('a notification that names the sender or quotes the message', () => {
    harness.notifications.send({
      channel: 'push',
      to: 'device',
      title: 'Chronos',
      body: `${harness.markers.healthText()} sent you a message`,
    });
    const findings = harness.scan().filter((f) => f.sink === 'notifications');
    expect(findings.map((f) => f.type).sort()).toEqual(['marker', 'policy']);
  });

  it('a trace attribute that is not scrubbed, and the same trace once scrubbed', () => {
    const attributes = {
      'user.email': harness.markers.email(),
      conditions: harness.markers.conditionCode(),
    };
    const unscrubbed = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(harness.traces)],
    });
    unscrubbed.getTracer('t').startSpan('work').setAttributes(attributes).end();
    expect(sinksOf(harness.scan())).toEqual(['traces']);

    const clean = createPrivacyHarness({ seed: 'scrubbed-trace' });
    const scrubbed = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new ScrubbingSpanExporter(clean.traces))],
    });
    const span = scrubbed.getTracer('t').startSpan('work');
    span.setAttributes({
      'user.email': clean.markers.email(),
      conditions: clean.markers.conditionCode(),
    });
    span.end();
    expect(() => {
      clean.assertClean();
    }).not.toThrow();
  });

  it('an unredacted OTLP export leaving a service', async () => {
    const collected = createPrivacyHarness({ seed: 'otlp' });
    const collector = await startCollector((body) => {
      collected.traces.capture(body);
    });
    try {
      collected.traces.capture(
        JSON.stringify({
          resourceSpans: [{ attributes: { conditions: collected.markers.conditionCode() } }],
        }),
      );
      expect(collected.scan().length).toBeGreaterThan(0);
    } finally {
      collector.stop();
    }
  });
});

describe('the well-behaved routes of the same service are clean', () => {
  it('stays quiet when nothing leaks', async () => {
    const harness = createPrivacyHarness({ seed: 'no-false-alarm' });
    const probe = await startProbe({ harness });
    try {
      const fetchHere = harness.http.recordingFetch({ recordRequestUrl: false });
      await fetchHere(`${probe.http}/clean/domain`);
      await fetchHere(`${probe.http}/healthz`);
      await fetchHere(`${probe.http}/readyz`);
      await probe.echo.echo('hello');
      expect(harness.scan()).toEqual([]);
    } finally {
      await probe.stop();
    }
  });
});
