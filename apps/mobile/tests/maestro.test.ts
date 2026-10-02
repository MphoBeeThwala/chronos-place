import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const flowsDir = path.join(root, '.maestro');

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(tsx?|json)$/.test(entry.name) ? [readFileSync(full, 'utf8')] : [];
  });
const appSource = [
  ...sources(path.join(root, 'app')),
  ...sources(path.join(root, 'src')),
  ...sources(path.resolve(root, '../../packages/ui/src')),
].join('\n');

const config = readFileSync(path.join(root, 'app.config.ts'), 'utf8');
const appId = /bundleIdentifier: '([^']+)'/.exec(config)?.[1];

/** Maestro flows are `appId` header, `---`, then a list of commands. */
function loadFlow(file: string): { header: Record<string, unknown>; steps: unknown[] } {
  const [header, body] = readFileSync(path.join(flowsDir, file), 'utf8').split(/^---$/m);
  return {
    header: parse(header ?? '') as Record<string, unknown>,
    steps: parse(body ?? '') as unknown[],
  };
}

/** The `id:` selectors used by a flow's steps. */
function ids(steps: unknown[]): string[] {
  const found: string[] = [];
  for (const step of steps) {
    if (typeof step !== 'object' || step === null) continue;
    for (const arg of Object.values(step as Record<string, unknown>)) {
      const id =
        typeof arg === 'object' && arg !== null
          ? (arg as Record<string, unknown>)['id']
          : undefined;
      if (typeof id === 'string') found.push(id);
    }
  }
  return found;
}

describe('Maestro flows', () => {
  const files = readdirSync(flowsDir).filter((f) => f.endsWith('.yaml'));

  it('exist: a smoke test that opens the app, and a settings flow', () => {
    expect(files.sort()).toEqual(['settings.yaml', 'smoke.yaml']);
  });

  it.each(files)('%s is valid, targets the app, and starts from a clean state', (file) => {
    const { header, steps } = loadFlow(file);
    expect(header['appId']).toBe(appId);
    expect(Array.isArray(steps) && steps.length > 0).toBe(true);
    expect(JSON.stringify(steps[0])).toContain('launchApp');
    expect(JSON.stringify(steps[0])).toContain('clearState');
  });

  it.each(files)('%s only refers to test ids that exist in the app', (file) => {
    for (const id of ids(loadFlow(file).steps)) {
      // Ids built by a component (`<testID>-<value>`) are checked against their prefix.
      const known =
        appSource.includes(`"${id}"`) ||
        appSource.includes(`'${id}'`) ||
        appSource.includes(`${id.replace(/-[^-]+$/, '')}"`) ||
        appSource.includes(`${id.replace(/-[^-]+$/, '')}'`);
      expect(known, `${file}: ${id}`).toBe(true);
    }
  });
});
