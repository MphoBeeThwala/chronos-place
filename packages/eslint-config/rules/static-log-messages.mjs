/**
 * chronos/static-log-messages
 *
 * The log message (`msg`) is free text in every logger mode, so health text interpolated into it
 * would reach the logs (CLAUDE.md rule 3, ADR-0005). This rule requires the message passed to a
 * logger method to be a static string: put variable data in the fields object, where
 * `@chronos/logger` redacts it by key (and drops it entirely in allowlist mode).
 *
 * Accepted messages: a string literal, a template literal without expressions, a concatenation of
 * those, or an identifier bound by `const` to one of them in the same file.
 *
 * A call is treated as a logger call when it is `<receiver>.<level>(...)` and the receiver is
 *  - an identifier or property named like a logger (`log`, `logger`, `appLogger`, `this.logger`), or
 *  - the result of `.child(...)`, called inline or stored in a variable.
 */

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const LOGGER_NAME = /^_?(log|logger)$/i;
const LOGGER_SUFFIX = /[a-z0-9_](Log|Logger)$/;

const isLoggerName = (name) => LOGGER_NAME.test(name) || LOGGER_SUFFIX.test(name);

/** Name of the identifier or non-computed property a receiver expression ends in. */
function receiverName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  return undefined;
}

/** True for a string/number literal, an expression-free template, or `+` of those. */
function isLiteralText(node) {
  switch (node.type) {
    case 'Literal':
      return true;
    case 'TemplateLiteral':
      return node.expressions.length === 0;
    case 'BinaryExpression':
      return node.operator === '+' && isLiteralText(node.left) && isLiteralText(node.right);
    default:
      return false;
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export const staticLogMessages = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      template:
        'Log messages must be static. Move interpolated values into the fields object, e.g. logger.info({ count }, "items loaded").',
      concatenation:
        'Log messages must be static. Do not build the message by concatenation; put variable data in the fields object.',
      nonLiteral:
        'Log messages must be a string literal or a const string. Put variable data, including error text, in the fields object (e.g. logger.error({ err }, "request failed")).',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    /** Resolves `name` from `node`'s scope and returns the variable, if any. */
    function findVariable(node, name) {
      for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(name);
        if (variable) return variable;
      }
      return undefined;
    }

    /** The `const` declarator initialiser of an identifier, or undefined. */
    function constInit(node) {
      const variable = findVariable(node, node.name);
      const [def] = variable?.defs ?? [];
      if (variable?.defs.length !== 1 || def?.type !== 'Variable') return undefined;
      if (def.parent.kind !== 'const' || def.node.id.type !== 'Identifier') return undefined;
      return def.node.init ?? undefined;
    }

    /** True when `node` evaluates to a `.child(...)` logger. */
    function isChildLogger(node) {
      if (node.type === 'Identifier') {
        const init = constInit(node);
        return init !== undefined && isChildLogger(init);
      }
      return (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === 'child' &&
        isLoggerReceiver(node.callee.object)
      );
    }

    function isLoggerReceiver(node) {
      const name = receiverName(node);
      return (name !== undefined && isLoggerName(name)) || isChildLogger(node);
    }

    function isStaticMessage(node) {
      if (isLiteralText(node)) return true;
      if (node.type !== 'Identifier') return false;
      const init = constInit(node);
      return init !== undefined && isLiteralText(init);
    }

    function reasonFor(node) {
      if (node.type === 'TemplateLiteral') return 'template';
      if (node.type === 'BinaryExpression' && node.operator === '+') return 'concatenation';
      return 'nonLiteral';
    }

    /**
     * The message argument of `logger.level(...)`. Mirrors the Logger signatures: `(msg)` or
     * `(fields, msg?)`. A leading string-like argument is the message; otherwise it is the fields
     * and the message is the second argument. A lone object literal has no message.
     */
    function messageArgument(args) {
      const [first, second] = args;
      if (!first || first.type === 'SpreadElement') return undefined;
      const firstIsMessage =
        first.type === 'Literal' ||
        first.type === 'TemplateLiteral' ||
        (first.type === 'BinaryExpression' && first.operator === '+') ||
        (args.length === 1 && first.type !== 'ObjectExpression');
      return firstIsMessage ? first : second;
    }

    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier' || !LEVELS.has(callee.property.name)) return;
        if (!isLoggerReceiver(callee.object)) return;

        const message = messageArgument(node.arguments);
        if (!message) return;
        if (message.type === 'SpreadElement' || isStaticMessage(message)) return;
        context.report({ node: message, messageId: reasonFor(message) });
      },
    };
  },
};
