import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findViolations, matches, type Policy } from '../src/banned-dependencies.js';

const policy = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '../banned-dependencies.json'), 'utf8'),
) as Policy;
const manifest = (content: Record<string, unknown>, file = 'apps/mobile/package.json') => [
  { file, content },
];
const adrs = (known: string[]) => (adr: string) => known.includes(adr);

describe('matches', () => {
  it('handles exact names, prefixes and scopes', () => {
    expect(matches('firebase', 'firebase')).toBe(true);
    expect(matches('firebase', 'firebase-admin')).toBe(false);
    expect(matches('mixpanel*', 'mixpanel-browser')).toBe(true);
    expect(matches('@segment/*', '@segment/analytics-next')).toBe(true);
    expect(matches('@segment/*', '@segmentio/other')).toBe(false);
  });
});

describe('findViolations', () => {
  it('flags banned SDKs in every dependency section', () => {
    const result = findViolations(
      manifest({
        dependencies: { 'react-native-appsflyer': '^1.0.0', zod: '^4.0.0' },
        devDependencies: { logrocket: '^1.0.0' },
        optionalDependencies: { '@amplitude/analytics-browser': '^2.0.0' },
        peerDependencies: { '@datadog/browser-rum': '^5.0.0' },
      }),
      policy,
      adrs([]),
    );
    expect(result.map((v) => v.dependency).sort()).toEqual([
      '@amplitude/analytics-browser',
      '@datadog/browser-rum',
      'logrocket',
      'react-native-appsflyer',
    ]);
    expect(result.every((v) => v.file === 'apps/mobile/package.json' && v.reason.length > 0)).toBe(
      true,
    );
  });

  it('bans query-cache persistence (ADR-0009) and over-the-air updates until an ADR allows them', () => {
    const content = {
      dependencies: {
        '@tanstack/react-query-persist-client': '^5',
        '@tanstack/query-async-storage-persister': '^5',
        'expo-updates': '~57',
        '@tanstack/react-query': '^5',
      },
    };
    expect(
      findViolations(manifest(content), policy, adrs([]))
        .map((v) => v.dependency)
        .sort(),
    ).toEqual([
      '@tanstack/query-async-storage-persister',
      '@tanstack/react-query-persist-client',
      'expo-updates',
    ]);
  });

  it('lets ordinary dependencies through', () => {
    expect(
      findViolations(
        manifest({ dependencies: { zod: '^4', '@nestjs/common': '^12', pino: '^10' } }),
        policy,
        adrs([]),
      ),
    ).toEqual([]);
  });

  it('allows an approved SDK only while its ADR exists', () => {
    const custom: Policy = {
      banned: [{ pattern: '@sentry/*', reason: 'vendor crash reporting' }],
      allowed: [{ pattern: '@sentry/node', adr: 'ADR-0005' }],
    };
    const content = { dependencies: { '@sentry/node': '^9', '@sentry/replay': '^9' } };
    expect(
      findViolations(manifest(content), custom, adrs(['ADR-0005'])).map((v) => v.dependency),
    ).toEqual(['@sentry/replay']);
  });

  it('bans session replay and vendor crash reporting even though Sentry itself is allowed', () => {
    const content = { dependencies: { '@sentry/replay': '^9', '@bugsnag/expo': '^54' } };
    expect(
      findViolations(manifest(content), policy, adrs(['ADR-0005']))
        .map((v) => v.dependency)
        .sort(),
    ).toEqual(['@bugsnag/expo', '@sentry/replay']);
  });

  it('rejects an allow entry whose ADR is missing', () => {
    const custom: Policy = {
      banned: [{ pattern: 'some-sdk', reason: 'test' }],
      allowed: [{ pattern: 'some-sdk', adr: 'ADR-9999' }],
    };
    const result = findViolations(
      manifest({ dependencies: { 'some-sdk': '1' } }),
      custom,
      adrs(['ADR-0005']),
    );
    expect(result).toEqual([
      {
        file: 'apps/mobile/package.json',
        dependency: 'some-sdk',
        reason: 'allowed by ADR-9999, but that ADR does not exist',
      },
    ]);
    expect(
      findViolations(manifest({ dependencies: { 'some-sdk': '1' } }), custom, adrs(['ADR-9999'])),
    ).toEqual([]);
  });

  it('keeps every allowed entry pointing at an ADR that exists in this repository', () => {
    const adrFiles = readdirSync(path.join(import.meta.dirname, '../../../docs/adr'));
    for (const rule of policy.allowed) {
      expect(
        adrFiles.some((f) => f.startsWith(`${rule.adr.replace('ADR-', '')}-`)),
        rule.adr,
      ).toBe(true);
    }
  });
});
