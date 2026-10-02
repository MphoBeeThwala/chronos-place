import type { ReactNode } from 'react';
import { Text as NativeText, type StyleProp, type TextStyle } from 'react-native';
import { useTheme } from '../theme-context';
import { MAX_FONT_SCALE, type TextVariant } from '../tokens/index';

export interface TextProps {
  variant?: TextVariant;
  /** A colour token name, never a raw colour. */
  color?: 'text' | 'textMuted' | 'accentText' | 'danger' | 'success' | 'onAccent';
  bold?: boolean;
  align?: TextStyle['textAlign'];
  role?: 'header' | 'text';
  style?: StyleProp<TextStyle>;
  testID?: string;
  children: ReactNode;
}

/** Themed text. Scales with the system font size up to 200%, so nothing is cut off or lost. */
export function Text({
  variant = 'body',
  color = 'text',
  bold = false,
  align,
  role = 'text',
  style,
  testID,
  children,
}: TextProps) {
  const { colors, typography } = useTheme();
  return (
    <NativeText
      testID={testID}
      accessibilityRole={role}
      allowFontScaling
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      style={[
        {
          color: colors[color],
          fontSize: typography.sizes[variant],
          lineHeight: typography.lineHeights[variant],
          fontWeight: bold ? typography.weights.bold : typography.weights.regular,
        },
        align ? { textAlign: align } : null,
        style,
      ]}
    >
      {children}
    </NativeText>
  );
}

export interface HeadingProps extends Omit<TextProps, 'variant' | 'bold' | 'role'> {
  level?: 1 | 2;
}

/** A heading that screen readers announce as one, so people can jump between sections. */
export function Heading({ level = 1, ...props }: HeadingProps) {
  return <Text {...props} variant={level === 1 ? 'heading1' : 'heading2'} bold role="header" />;
}
