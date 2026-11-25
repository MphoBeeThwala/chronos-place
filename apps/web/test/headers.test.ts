import { describe, expect, it } from 'vitest';
import config, { CAMERA_ROUTE } from '../next.config';

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/** Next.js semantics for the sources used here: every matching rule applies, later ones win. */
async function headerFor(path: string, key: string): Promise<string | undefined> {
  const rules = ((await config.headers?.()) ?? []) as HeaderRule[];
  let value: string | undefined;
  for (const rule of rules) {
    const matches = rule.source === '/(.*)' || rule.source === path;
    if (!matches) continue;
    const header = rule.headers.find((h) => h.key === key);
    if (header) value = header.value;
  }
  return value;
}

describe('camera permission (ADR-0017, ADR-0022)', () => {
  it('opens the camera on the verification route only', async () => {
    expect(CAMERA_ROUTE).toBe('/verify');
    expect(await headerFor('/verify', 'Permissions-Policy')).toMatch(/^camera=\(self\),/);
    for (const path of ['/', '/feed', '/health', '/verify/other', '/profile']) {
      expect(await headerFor(path, 'Permissions-Policy')).toMatch(/^camera=\(\),/);
    }
  });

  it('never opens the microphone or location', async () => {
    for (const path of ['/verify', '/feed']) {
      expect(await headerFor(path, 'Permissions-Policy')).toContain(
        'microphone=(), geolocation=()',
      );
    }
  });
});

describe('gateway rewrites', () => {
  it('sends captures to the same gateway as GraphQL', async () => {
    const rewrites = (await config.rewrites?.()) as { source: string; destination: string }[];
    const graphql = rewrites.find((r) => r.source === '/api/graphql')?.destination ?? '';
    const capture = rewrites.find((r) => r.source === '/api/verification/capture')?.destination;
    expect(capture).toBe(graphql.replace(/\/graphql$/, '/verification/capture'));
  });
});
