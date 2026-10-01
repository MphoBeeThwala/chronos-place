import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

/**
 * chronos/restricted-boundary
 *
 * Enforces the restricted-zone import boundary (CLAUDE.md rule 1, ADR-0002):
 *  1. Nothing outside `restricted/` may import from `restricted/`.
 *  2. Code inside `restricted/` may import only an approved set of packages.
 *  3. The generated Disclosure client may be imported only by approved services.
 *  4. Dynamic import()/require() must use a string literal so (1) to (3) cannot be bypassed.
 *
 * This is a security control. Changes to the allow-lists below need the same review as a schema change.
 */

/** Workspace packages restricted code may use besides other `restricted/*` packages. */
export const RESTRICTED_ALLOWED_INTERNAL = [
  '@chronos/contracts',
  '@chronos/crypto',
  '@chronos/logger',
  '@chronos/config',
];

/** Third-party packages restricted code may use. */
export const RESTRICTED_ALLOWED_THIRD_PARTY = [
  '@aws-sdk/client-kms',
  '@grpc/grpc-js',
  '@grpc/proto-loader',
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/microservices',
  'drizzle-orm',
  'pg',
  'reflect-metadata',
  'rxjs',
  'vitest',
  'zod',
];

/** Import path of the generated Disclosure client inside `@chronos/contracts`. */
export const DISCLOSURE_CLIENT_SPECIFIER = '@chronos/contracts/disclosure';

/** Locations (relative to the repo root) allowed to import the Disclosure client. */
export const DISCLOSURE_CLIENT_IMPORTERS = [
  'services/gateway/',
  'services/discovery/',
  'services/identity/',
  'services/moderation/',
  'packages/contracts/',
  'restricted/',
];

const BUILTINS = new Set(builtinModules);
const restrictedNamesCache = new Map();

const toPosix = (p) => p.split(path.sep).join('/');
const isPathSpecifier = (s) =>
  s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..' || path.isAbsolute(s);

function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function isBuiltin(specifier) {
  return (
    specifier.startsWith('node:') ||
    BUILTINS.has(specifier) ||
    BUILTINS.has(packageNameOf(specifier))
  );
}

/** Names of workspace packages that live under `<root>/restricted/`. */
function restrictedPackageNames(root) {
  const cached = restrictedNamesCache.get(root);
  if (cached) return cached;
  const names = new Set();
  const dir = path.join(root, 'restricted');
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const manifest = path.join(dir, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(manifest)) {
        const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
        if (typeof name === 'string') names.add(name);
      }
    }
  }
  restrictedNamesCache.set(root, names);
  return names;
}

/** @type {import('eslint').Rule.RuleModule} */
export const restrictedBoundary = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          root: { type: 'string' },
          allowNonLiteralIn: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      restrictedImport:
        'Code outside restricted/ must not import from restricted/ ("{{specifier}}"). Use the Disclosure Service gRPC API.',
      notAllowedInRestricted:
        'restricted/ code may not import "{{specifier}}". Only approved packages are allowed; changing the list needs security review.',
      disclosureClient:
        'Only the gateway, discovery, identity and moderation services may import the Disclosure client ("{{specifier}}").',
      nonLiteral:
        'Dynamic import()/require() must use a string literal so the restricted-zone boundary can be checked.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const root = path.resolve(options.root ?? context.cwd);
    const allowNonLiteralIn = options.allowNonLiteralIn ?? ['tools/'];
    const filename = context.filename;
    if (!path.isAbsolute(filename)) return {};

    const fileRel = toPosix(path.relative(root, filename));
    if (fileRel.startsWith('..')) return {};
    const inRestricted = fileRel.startsWith('restricted/');
    const restrictedNames = restrictedPackageNames(root);
    const fileDir = path.dirname(filename);

    /** Repo-relative POSIX path a path specifier points to, or null when it leaves the repo. */
    const resolvePath = (specifier) => {
      const rel = toPosix(path.relative(root, path.resolve(fileDir, specifier)));
      return rel.startsWith('..') ? null : rel;
    };

    function check(node, specifier) {
      if (typeof specifier !== 'string') return;
      const report = (messageId) => context.report({ node, messageId, data: { specifier } });

      if (isBuiltin(specifier)) return;

      if (inRestricted) {
        if (isPathSpecifier(specifier)) {
          const target = resolvePath(specifier);
          if (target === null || !(target === 'restricted' || target.startsWith('restricted/'))) {
            report('notAllowedInRestricted');
          }
          return;
        }
        const name = packageNameOf(specifier);
        const allowed =
          restrictedNames.has(name) ||
          RESTRICTED_ALLOWED_INTERNAL.includes(name) ||
          RESTRICTED_ALLOWED_THIRD_PARTY.includes(name);
        if (!allowed) report('notAllowedInRestricted');
        return;
      }

      const targetsRestricted = isPathSpecifier(specifier)
        ? (() => {
            const target = resolvePath(specifier);
            return target !== null && (target === 'restricted' || target.startsWith('restricted/'));
          })()
        : specifier.startsWith('restricted/') || restrictedNames.has(packageNameOf(specifier));
      if (targetsRestricted) {
        report('restrictedImport');
        return;
      }

      const isClient =
        specifier === DISCLOSURE_CLIENT_SPECIFIER ||
        specifier.startsWith(`${DISCLOSURE_CLIENT_SPECIFIER}/`);
      if (isClient && !DISCLOSURE_CLIENT_IMPORTERS.some((dir) => fileRel.startsWith(dir))) {
        report('disclosureClient');
      }
    }

    const literalValue = (node) => {
      if (!node) return undefined;
      if (node.type === 'Literal') return node.value;
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis[0]?.value.cooked ?? undefined;
      }
      return undefined;
    };

    const nonLiteralAllowed = allowNonLiteralIn.some((dir) => fileRel.startsWith(dir));
    const checkDynamic = (node, argument) => {
      const value = literalValue(argument);
      if (typeof value === 'string') check(node, value);
      else if (!nonLiteralAllowed) context.report({ node, messageId: 'nonLiteral' });
    };

    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node, node.source.value);
      },
      ImportExpression: (node) => checkDynamic(node, node.source),
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          checkDynamic(node, node.arguments[0]);
        }
      },
      TSImportEqualsDeclaration: (node) => {
        if (node.moduleReference.type === 'TSExternalModuleReference') {
          check(node, literalValue(node.moduleReference.expression));
        }
      },
      TSImportType: (node) => {
        const argument =
          node.argument?.type === 'TSLiteralType' ? node.argument.literal : node.argument;
        check(node, literalValue(argument));
      },
    };
  },
};
