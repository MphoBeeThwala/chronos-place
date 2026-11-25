import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0022 decision 2 and CLAUDE.md rule 7: the capture component must not phone home. This reads
 * the installed (patched) component and fails if a version upgrade brings in a network call, an
 * outside address or browser storage. Review the new source before changing the allow-list.
 */
const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve('@smile_identity/smart-camera-web'), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
};

/** Addresses that are not requests: SVG/XLink namespaces and a source comment. */
const ALLOWED_URLS = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'https://jakearchibald.com/2013/animated-line-drawing-svg/',
]);

describe('capture component (Smile ID smart-camera-web)', () => {
  it('is pinned to the reviewed version', () => {
    expect(manifest.dependencies['@smile_identity/smart-camera-web']).toBe('11.0.1');
  });

  it('references no outside address (the Google Fonts links are patched out)', () => {
    const urls = new Set(source.match(/https?:\/\/[^\s'"`)<>]+/g) ?? []);
    expect([...urls].filter((u) => !ALLOWED_URLS.has(u))).toEqual([]);
    expect(source).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });

  it('uses no network or storage API', () => {
    const forbidden =
      /\b(fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.serviceWorker)\b/;
    expect(source).not.toMatch(forbidden);
  });

  it('asks for video only, never the microphone', () => {
    const requests = source.match(/getUserMedia\(\{[^}]*\}/g) ?? [];
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r).toMatch(/audio:\s*false/);
  });
});
