import path from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createConfig } from '../index.mjs';

const eslint = new ESLint({
  overrideConfigFile: true,
  // typescript-eslint's ConfigArray is structurally a Linter.Config[]; its types lag ESLint 10.
  overrideConfig: createConfig({ typed: false }) as unknown as Linter.Config[],
});

const RULE = 'chronos/static-log-messages';

/** Returns "ruleId:messageId" pairs for this rule only. */
async function lint(code: string, file = 'services/profile/src/a.ts'): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(process.cwd(), file) });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === RULE)
    .map((m) => `${RULE}:${m.messageId ?? m.message}`);
}

const TEMPLATE = `${RULE}:template`;
const CONCAT = `${RULE}:concatenation`;
const NON_LITERAL = `${RULE}:nonLiteral`;

describe('static-log-messages: accepts', () => {
  it.each([
    "logger.info('profile updated');",
    'logger.info(`profile updated`);',
    "logger.info('profile ' + 'updated');",
    "logger.info({ accountId }, 'profile updated');",
    'logger.info({ accountId }, `profile updated`);',
    "logger.info({ accountId }, 'a' + 'b');",
    'logger.info({ accountId });',
    'logger.info();',
    'logger.info(...args);',
    "const MSG = 'profile updated';\nlogger.info(MSG);",
    "const MSG = 'profile updated';\nlogger.warn({ a: 1 }, MSG);",
    "const MSG = `profile ` + 'updated';\nlogger.info(MSG);",
    "function f() {\n  const MSG = 'x';\n  logger.info(MSG);\n}",
    'logger.error({ err }, "request failed");',
    'this.logger.info({ a }, "ok");',
    'appLogger.debug("ok");',
    'log.trace("ok");',
    'logger.child({ a }).info("ok");',
    "const l = logger.child({ a });\nl.info({ b }, 'ok');",
    "const l = logger.child({ a }).child({ b });\nl.info('ok');",
    // not loggers
    'catalog.info(`x ${y}`);',
    'metrics.info(`x ${y}`);',
    'logger.notALevel(`x ${y}`);',
    'logger[level](`x ${y}`);',
    'logger.child();',
    'wrapper.child({ a }).info(`x ${y}`);',
    'fn(`x ${y}`);',
    'logger.info.call(null, `x ${y}`);',
  ])('%s', async (code) => {
    expect(await lint(code)).toEqual([]);
  });
});

describe('static-log-messages: rejects', () => {
  it.each([
    ['logger.info(`loaded ${name}`);', TEMPLATE],
    ['logger.info({ a }, `loaded ${name}`);', TEMPLATE],
    ["logger.info('loaded ' + name);", CONCAT],
    ["logger.info({ a }, 'loaded ' + name);", CONCAT],
    ['logger.info(name + " loaded");', CONCAT],
    ['logger.info(message);', NON_LITERAL],
    ['logger.error(err);', NON_LITERAL],
    ['logger.info({ a }, message);', NON_LITERAL],
    ['logger.info({ a }, err.message);', NON_LITERAL],
    ['logger.info({ a }, format(x));', NON_LITERAL],
    ["logger.info({ a }, cond ? 'a' : 'b');", NON_LITERAL],
    ["logger.info({ a }, 'a' - 1);", NON_LITERAL],
    ["let msg = 'x';\nlogger.info(msg);", NON_LITERAL],
    ["var msg = 'x';\nlogger.info(msg);", NON_LITERAL],
    ['const msg = `x ${y}`;\nlogger.info(msg);', NON_LITERAL],
    ["const msg = 'x' + y;\nlogger.info(msg);", NON_LITERAL],
    ['const msg = compute();\nlogger.info(msg);', NON_LITERAL],
    ['const { msg } = obj;\nlogger.info(msg);', NON_LITERAL],
    ['logger.info(msg);\nvar msg;', NON_LITERAL],
    ['function f(msg: string) {\n  logger.info(msg);\n}', NON_LITERAL],
    ['const msg = 1;\n{\n  let msg = x;\n  logger.info(msg);\n}', NON_LITERAL],
    ['this.logger.warn(`x ${y}`);', TEMPLATE],
    ['appLogger.fatal(`x ${y}`);', TEMPLATE],
    ['LOGGER.trace(`x ${y}`);', TEMPLATE],
    ['log.debug(`x ${y}`);', TEMPLATE],
    ['logger.child({ a }).info(`x ${y}`);', TEMPLATE],
    ['logger.child({ a }).child({ b }).error(`x ${y}`);', TEMPLATE],
    ['const l = logger.child({ a });\nl.info(`x ${y}`);', TEMPLATE],
    ['const l = logger.child({ a }).child({ b });\nl.info(`x ${y}`);', TEMPLATE],
  ])('%s', async (code, expected) => {
    expect(await lint(code)).toEqual([expected]);
  });
});

describe('static-log-messages: scope', () => {
  const code = 'logger.info(`x ${y}`);';

  it.each([
    'services/profile/src/a.ts',
    'restricted/disclosure-service/src/a.ts',
    'apps/admin/src/a.ts',
    'packages/service-kit/src/a.ts',
  ])('enforced in %s', async (file) => {
    expect(await lint(code, file)).toEqual([TEMPLATE]);
  });

  it.each(['packages/logger/src/a.ts', 'packages/service-kit/test/a.ts', 'tools/seed/a.ts'])(
    'not enforced in %s',
    async (file) => {
      expect(await lint(code, file)).toEqual([]);
    },
  );

  it('cannot be disabled inline', async () => {
    const [result] = await eslint.lintText(
      '// eslint-disable-next-line chronos/static-log-messages -- needed\nlogger.info(`x ${y}`);\n',
      { filePath: path.join(process.cwd(), 'services/profile/src/a.ts') },
    );
    const rules = (result?.messages ?? []).map((m) => m.ruleId);
    expect(rules).toContain('@eslint-community/eslint-comments/no-restricted-disable');
  });
});
