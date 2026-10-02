/**
 * chronos/a11y-label
 *
 * Interactive and image elements must carry what assistive technology needs (PRD: WCAG 2.2 AA, full
 * screen-reader support). Applies to React Native JSX:
 *  - Pressable and Touchable*: an accessible label and a role.
 *  - Switch and TextInput: an accessible label.
 *  - Image: an accessible label, or `accessible={false}` when it is decorative.
 * Elements with a spread attribute are skipped: the props may be forwarded from a component that
 * already enforces them.
 */

const NEED_LABEL_AND_ROLE = new Set([
  'Pressable',
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
  'TouchableNativeFeedback',
]);
const NEED_LABEL = new Set(['Switch', 'TextInput']);
const LABEL_PROPS = [
  'accessibilityLabel',
  'aria-label',
  'accessibilityLabelledBy',
  'aria-labelledby',
];
const ROLE_PROPS = ['accessibilityRole', 'role'];

/** @type {import('eslint').Rule.RuleModule} */
export const a11yLabel = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missingLabel: '<{{name}}> needs an accessible label ({{props}}).',
      emptyLabel: '<{{name}}> has an empty accessible label.',
      missingRole: '<{{name}}> needs an accessible role ({{props}}).',
      imageLabel: '<Image> needs an accessible label, or accessible={false} if it is decorative.',
    },
  },
  create(context) {
    const attribute = (node, names) =>
      node.attributes.find(
        (a) =>
          a.type === 'JSXAttribute' &&
          a.name.type === 'JSXIdentifier' &&
          names.includes(a.name.name),
      );

    /** True when the attribute is present and not obviously empty. */
    const isEmpty = (attr) => {
      const value = attr.value;
      if (value === null) return true; // <X accessibilityLabel /> means true, not text
      if (value.type === 'Literal')
        return typeof value.value === 'string' && value.value.trim() === '';
      if (value.type === 'JSXExpressionContainer') {
        const expression = value.expression;
        if (expression.type === 'Identifier' && expression.name === 'undefined') return true;
        if (expression.type === 'Literal')
          return (
            expression.value === null ||
            (typeof expression.value === 'string' && expression.value.trim() === '')
          );
        if (expression.type === 'JSXEmptyExpression') return true;
      }
      return false;
    };

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier') return;
        const name = node.name.name;
        const isImage = name === 'Image';
        if (!NEED_LABEL_AND_ROLE.has(name) && !NEED_LABEL.has(name) && !isImage) return;
        if (node.attributes.some((a) => a.type === 'JSXSpreadAttribute')) return;

        const label = attribute(node, LABEL_PROPS);
        if (isImage) {
          const accessible = attribute(node, ['accessible']);
          const decorative =
            accessible?.value?.type === 'JSXExpressionContainer' &&
            accessible.value.expression.type === 'Literal' &&
            accessible.value.expression.value === false;
          if (!decorative && (!label || isEmpty(label)))
            context.report({ node, messageId: 'imageLabel' });
          return;
        }
        if (!label) {
          context.report({
            node,
            messageId: 'missingLabel',
            data: { name, props: LABEL_PROPS.slice(0, 2).join(' or ') },
          });
        } else if (isEmpty(label)) {
          context.report({ node, messageId: 'emptyLabel', data: { name } });
        }
        if (NEED_LABEL_AND_ROLE.has(name) && !attribute(node, ROLE_PROPS)) {
          context.report({
            node,
            messageId: 'missingRole',
            data: { name, props: ROLE_PROPS.join(' or ') },
          });
        }
      },
    };
  },
};
