import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every generated file under gen/. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('generated contracts load under plain node', () => {
  it('take nothing from protobufjs (CommonJS) by name', () => {
    const gen = new URL('../gen', import.meta.url).pathname;
    for (const file of files(gen).filter((f) => f.endsWith('.ts'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/import \{[^}]*\} from "protobufjs"/);
    }
  });
});
