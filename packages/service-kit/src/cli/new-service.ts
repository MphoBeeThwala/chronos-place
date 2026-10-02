import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const TEMPLATE_DIR = path.resolve(import.meta.dirname, '../../templates/service');

export interface GenerateOptions {
  name: string;
  /** Repository root. */
  root: string;
  /** Generate under restricted/ with the allow-list logger (ADR-0002). */
  restricted?: boolean;
  /** Pinned digest of the distroless base image. */
  distrolessDigest: string;
  templateDir?: string;
}

/** Copies the service template into `services/<name>` (or `restricted/<name>`), filling in the placeholders. */
export function generateService(options: GenerateOptions): string {
  const { name, root } = options;
  if (!NAME.test(name))
    throw new Error(
      'Service name must be lower-case kebab-case, 2 to 31 characters, starting with a letter',
    );
  const scopeDir = options.restricted === true ? 'restricted' : 'services';
  const target = path.join(root, scopeDir, name);
  if (existsSync(target)) throw new Error(`${path.join(scopeDir, name)} already exists`);

  const replacements: Record<string, string> = {
    __NAME__: name,
    __SCOPE_DIR__: scopeDir,
    __DISTROLESS_DIGEST__: options.distrolessDigest.replace(/^sha256:/, ''),
    __LOGGER_OPTION__: options.restricted === true ? ", loggerMode: 'allowlist'" : '',
  };
  const fill = (text: string): string =>
    Object.entries(replacements).reduce(
      (out, [token, value]) => out.replaceAll(token, value),
      text,
    );

  const copy = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      const source = path.join(from, entry);
      if (statSync(source).isDirectory()) {
        copy(source, path.join(to, entry));
      } else if (entry.endsWith('.tpl')) {
        writeFileSync(path.join(to, entry.slice(0, -4)), fill(readFileSync(source, 'utf8')));
      } else {
        cpSync(source, path.join(to, entry));
      }
    }
  };
  copy(options.templateDir ?? TEMPLATE_DIR, target);
  return target;
}
