import { ActivityIndicator, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../theme-context';
import { MIN_TOUCH_TARGET } from '../tokens/index';
import { Text } from './text';

export interface ButtonProps {
  /** The visible text. It is also the accessible label, so it must say what the button does. */
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
  /** Shows a spinner, announces "busy" and ignores presses. */
  loading?: boolean;
  /** Extra context for screen readers, for example the result of the action. */
  hint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** A button that is at least 44×44 pt, labelled, and reports disabled and busy states to assistive tech. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  hint,
  style,
  testID,
}: ButtonProps) {
  const { colors, radii, spacing } = useTheme();
  const inactive = disabled || loading;
  const filled = variant === 'primary';
  const background = filled ? colors.accent : 'transparent';
  const border =
    variant === 'secondary' ? colors.borderStrong : filled ? colors.accent : 'transparent';
  const textColor = filled ? 'onAccent' : 'accentText';

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(hint === undefined ? {} : { accessibilityHint: hint })}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: MIN_TOUCH_TARGET,
          minWidth: MIN_TOUCH_TARGET,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          borderRadius: radii.md,
          borderWidth: 2,
          borderColor: border,
          backgroundColor: background,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: spacing.sm,
          opacity: inactive ? 0.55 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={filled ? colors.onAccent : colors.accentText} /> : null}
      <Text color={textColor} bold>
        {label}
      </Text>
    </Pressable>
  );
}
