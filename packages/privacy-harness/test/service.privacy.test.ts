import { afterEach, describe, expect, it } from 'vitest';
import { createPrivacyHarness, type PrivacyHarness } from '../src/index.js';
import { startCollector, startProbe, type Probe } from './fixtures/probe-service.js';

describe('a running service leaks nothing through logs, errors, URLs, gRPC or traces', () => {
  let harness: PrivacyHarness;
  let probe: Probe | undefined;
  let stopCollector: (() => void) | undefined;

  afterEach(async () => {
    await probe?.stop();
    stopCollector?.();
    probe = undefined;
    stopCollector = undefined;
    harness.assertClean();
  });

  // OpenTelemetry can be registered once per process, so only the first run exports traces.
  let traced = false;

  async function run(mode: 'redact' | 'allowlist'): Promise<void> {
    harness = createPrivacyHarness();
    const collector = await startCollector((body) => {
      harness.traces.capture(body);
    });
    stopCollector = collector.stop;
    const exportTraces = !traced;
    traced = true;
    probe = await startProbe({
      harness,
      mode,
      ...(exportTraces ? { otlpEndpoint: collector.endpoint } : {}),
    });

    const { markers } = harness;
    // The request URLs are the test's inputs, so only what the service sends back is recorded.
    const fetchHere = harness.http.recordingFetch({ recordRequestUrl: false });
    const q = encodeURIComponent;

    await fetchHere(
      `${probe.http}/clean/log?note=${q(markers.healthText())}&email=${q(markers.email())}`,
    );
    await fetchHere(`${probe.http}/clean/error?who=${q(markers.phone())}`);
    await fetchHere(`${probe.http}/clean/domain`);
    await fetchHere(
      `${probe.http}/no-such-route/${q(markers.healthText())}?secret=${q(markers.secret())}`,
    );
    await fetchHere(`${probe.http}/healthz`);
    await fetchHere(`${probe.http}/readyz`);
    await probe.echo.echo(markers.conditionCode());
    await probe.echo.boom(markers.email());
    await probe.stop();
    probe = undefined;
  }

  it('in the default (redacting) mode, including the spans it exports', async () => {
    await run('redact');
    expect(harness.logs.texts().length).toBeGreaterThan(0);
    expect(harness.http.texts().join('')).toContain('Internal error');
    expect(harness.traces.texts().join('')).toContain('EchoService');
  });

  it('in allow-list mode, as restricted services run', async () => {
    await run('allowlist');
    expect(harness.logs.texts().length).toBeGreaterThan(0);
  });

  it('gives callers only generic errors', async () => {
    await run('redact');
    expect(harness.grpc.texts().join('')).toContain('Internal error');
    expect(harness.http.texts().join('')).toContain('Not found');
  });
});
