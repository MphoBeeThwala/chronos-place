import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateService } from '../src/cli/new-service.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'chronos-generate-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const files = (dir: string, base = dir): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(path.join(dir, e.name), base)
      : [path.relative(base, path.join(dir, e.name))],
  );

describe('generateService', () => {
  it('creates a complete service under services/', () => {
    const target = generateService({ name: 'profile', root, distrolessDigest: DIGEST });
    expect(target).toBe(path.join(root, 'services/profile'));
    expect(files(target).sort()).toEqual(
      [
        'Dockerfile',
        'package.json',
        'src/app.module.ts',
        'src/main.ts',
        'test/service.test.ts',
        'tsconfig.build.json',
        'tsconfig.json',
        'vitest.config.ts',
      ].sort(),
    );
  });

  it('fills in every placeholder and leaves none behind', () => {
    const target = generateService({ name: 'profile', root, distrolessDigest: DIGEST });
    for (const file of files(target)) {
      const text = readFileSync(path.join(target, file), 'utf8');
      expect(text, file).not.toMatch(/__[A-Z_]+__/);
    }
    const pkg = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8')) as {
      name: string;
    };
    expect(pkg.name).toBe('@chronos/profile');
    const dockerfile = readFileSync(path.join(target, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('--filter @chronos/profile deploy');
    expect(dockerfile).toContain(`distroless/nodejs22-debian13:nonroot@${DIGEST}`);
    expect(dockerfile).toContain('services/profile/Dockerfile');
  });

  it('pins the base image by digest, runs unprivileged and has no shell step in the final stage', () => {
    const target = generateService({ name: 'profile', root, distrolessDigest: DIGEST });
    const dockerfile = readFileSync(path.join(target, 'Dockerfile'), 'utf8');
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
    expect(finalStage).toMatch(/FROM gcr\.io\/distroless\/\S+@sha256:[0-9a-f]{64}/);
    expect(finalStage).toContain('nonroot');
    expect(finalStage).not.toMatch(/^RUN /m);
  });

  it('uses the allow-list logger for restricted services', () => {
    const restricted = generateService({
      name: 'vault-api',
      root,
      restricted: true,
      distrolessDigest: DIGEST,
    });
    expect(restricted).toBe(path.join(root, 'restricted/vault-api'));
    expect(readFileSync(path.join(restricted, 'src/main.ts'), 'utf8')).toContain(
      "loggerMode: 'allowlist'",
    );
    const normal = generateService({ name: 'matching', root, distrolessDigest: DIGEST });
    expect(readFileSync(path.join(normal, 'src/main.ts'), 'utf8')).not.toContain('allowlist');
  });

  it.each(['Profile', 'a', '1service', 'bad_name', 'has space', '../escape', 'x'.repeat(40), ''])(
    'rejects the name %j',
    (name) => {
      expect(() => generateService({ name, root, distrolessDigest: DIGEST })).toThrow(/kebab-case/);
    },
  );

  it('never overwrites an existing service', () => {
    mkdirSync(path.join(root, 'services/profile'), { recursive: true });
    expect(() => generateService({ name: 'profile', root, distrolessDigest: DIGEST })).toThrow(
      /already exists/,
    );
  });
});
