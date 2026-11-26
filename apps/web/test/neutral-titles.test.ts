import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Neutral titles, descriptions and addresses on every route (ADR-0017, TASKS M1.9): browser tabs,
 * history and link previews must not imply health. Scans the source, so new routes are covered.
 */
const REVEALING =
  /health|hiv|aids|chronic|condition|diagnos|illness|disease|medical|vault|diabet|cancer|epilep/i;
const APP = new URL('../src/app', import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('every route is neutral', () => {
  const sources = files(APP).filter((f) => /\/(page|layout)\.tsx$/.test(f));

  it('has no revealing words in a route address', () => {
    for (const file of sources) {
      const route = file.slice(APP.length).replace(/\/(page|layout)\.tsx$/, '');
      // Route groups such as (main) are not part of the address.
      expect(route.replace(/\([^)]*\)/g, ''), file).not.toMatch(REVEALING);
    }
  });

  it('has no revealing words in a page title or description', () => {
    let checked = 0;
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const [, value] of text.matchAll(
        /\b(?:title|description|default|template):\s*'([^']*)'/g,
      )) {
        checked += 1;
        expect(value, file).not.toMatch(REVEALING);
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
