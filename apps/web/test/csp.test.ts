import { describe, expect, it } from 'vitest';
import { buildCsp, newNonce } from '../src/lib/csp';

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

describe('buildCsp (ADR-0017, TASKS M1.9)', () => {
  const csp = buildCsp({ nonce: 'abc123', storage: 'https://media.example' });

  it('runs scripts only with this request’s nonce, never inline without one', () => {
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-eval'");
  });

  it('allows eval only in development, for hot reload', () => {
    const dev = buildCsp({ nonce: 'n', development: true });
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
  });

  it('loads images from the app and the media store only', () => {
    expect(directive(csp, 'img-src')).toBe("img-src 'self' data: blob: https://media.example");
    expect(directive(csp, 'img-src')).not.toMatch(/ https:( |$)/);
    expect(directive(buildCsp({ nonce: 'n' }), 'img-src')).toBe("img-src 'self' data: blob:");
  });

  it('keeps the other protections', () => {
    for (const d of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "connect-src 'self' https://media.example",
    ]) {
      expect(csp.split('; ')).toContain(d);
    }
  });
});

describe('newNonce', () => {
  it('is 128 random bits, different every time', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(Buffer.from(n, 'base64')).toHaveLength(16);
  });
});
