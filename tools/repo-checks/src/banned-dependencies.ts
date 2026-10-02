export interface BannedRule {
  pattern: string;
  reason: string;
}

export interface AllowedRule {
  pattern: string;
  adr: string;
  note?: string;
}

export interface Policy {
  banned: BannedRule[];
  allowed: AllowedRule[];
}

export interface Manifest {
  /** Repository-relative path of the package.json. */
  file: string;
  content: Record<string, unknown>;
}

export interface Violation {
  file: string;
  dependency: string;
  reason: string;
}

const SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** `name`, `name*` (prefix) and `@scope/*` (whole scope). */
export function matches(pattern: string, name: string): boolean {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * Finds dependencies the policy bans. A package that is also in `allowed` is permitted only when its
 * ADR exists (`adrExists`), so an allow entry cannot point at a decision that was never written.
 */
export function findViolations(
  manifests: readonly Manifest[],
  policy: Policy,
  adrExists: (adr: string) => boolean,
): Violation[] {
  const violations: Violation[] = [];
  for (const manifest of manifests) {
    for (const section of SECTIONS) {
      const deps = manifest.content[section];
      if (deps === null || typeof deps !== 'object') continue;
      for (const dependency of Object.keys(deps)) {
        const ban = policy.banned.find((rule) => matches(rule.pattern, dependency));
        if (!ban) continue;
        const allow = policy.allowed.find((rule) => matches(rule.pattern, dependency));
        if (allow) {
          if (adrExists(allow.adr)) continue;
          violations.push({
            file: manifest.file,
            dependency,
            reason: `allowed by ${allow.adr}, but that ADR does not exist`,
          });
          continue;
        }
        violations.push({ file: manifest.file, dependency, reason: ban.reason });
      }
    }
  }
  return violations;
}
