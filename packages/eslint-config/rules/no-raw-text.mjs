/**
 * chronos/no-raw-text
 *
 * User-facing text in screens must come from the translation catalogues (`t('key')`), so every
 * language gets the same app and copy can be reviewed in one place. Reports:
 *  - text written directly in JSX (`<Text>Hello</Text>`),
 *  - string literals in JSX expression containers (`{'Hello'}`),
 *  - string literals passed to user-facing props (`accessibilityLabel="Close"`, `placeholder`, ...).
 * Strings without letters (punctuation, bullets, numbers) are allowed.
 */

const DEFAULT_PROPS = [
  'accessibilityLabel',
  'accessibilityHint',
  'aria-label',
  'placeholder',
  'title',
  'label',
  'alt',
  'hint',
];
const hasLetters = (text) => /\p{L}/u.test(text);

/** @type {import('eslint').Rule.RuleModule} */
export const noRawText = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { props: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      rawText:
        'User-facing text must come from the translation catalogue, e.g. {t("welcome.title")}.',
      rawProp:
        'The "{{prop}}" prop is read by people, so it must come from the translation catalogue.',
    },
  },
  create(context) {
    const props = new Set(context.options[0]?.props ?? DEFAULT_PROPS);
    return {
      JSXText(node) {
        if (hasLetters(node.value)) context.report({ node, messageId: 'rawText' });
      },
      JSXExpressionContainer(node) {
        // `{'text'}` as a child; attribute values are handled below.
        if (node.parent.type === 'JSXAttribute') return;
        const e = node.expression;
        if (e.type === 'Literal' && typeof e.value === 'string' && hasLetters(e.value))
          context.report({ node, messageId: 'rawText' });
        if (
          e.type === 'TemplateLiteral' &&
          e.expressions.length === 0 &&
          e.quasis.some((q) => hasLetters(q.value.cooked ?? ''))
        ) {
          context.report({ node, messageId: 'rawText' });
        }
      },
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || !props.has(node.name.name) || node.value === null)
          return;
        const value = node.value;
        const literal =
          value.type === 'Literal'
            ? value
            : value.type === 'JSXExpressionContainer' && value.expression.type === 'Literal'
              ? value.expression
              : null;
        if (literal && typeof literal.value === 'string' && hasLetters(literal.value)) {
          context.report({ node, messageId: 'rawProp', data: { prop: node.name.name } });
        }
      },
    };
  },
};
