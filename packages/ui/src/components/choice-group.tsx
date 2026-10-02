import { Pressable, View } from 'react-native';
import { useTheme } from '../theme-context';
import { MIN_TOUCH_TARGET } from '../tokens/index';
import { Text } from './text';

export interface Choice<Value extends string> {
  value: Value;
  label: string;
}

export interface ChoiceGroupProps<Value extends string> {
  /** Names the group for screen readers, for example "Theme". */
  label: string;
  choices: readonly Choice<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  testID?: string;
}

/** A single-choice list read out as a radio group: each option says whether it is selected. */
export function ChoiceGroup<Value extends string>({
  label,
  choices,
  value,
  onChange,
  testID,
}: ChoiceGroupProps<Value>) {
  const { colors, radii, spacing } = useTheme();
  return (
    <View
      testID={testID}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ gap: spacing.sm }}
    >
      {choices.map((choice) => {
        const selected = choice.value === value;
        return (
          <Pressable
            key={choice.value}
            testID={testID === undefined ? undefined : `${testID}-${choice.value}`}
            accessibilityRole="radio"
            accessibilityLabel={choice.label}
            accessibilityState={{ checked: selected }}
            onPress={() => {
              onChange(choice.value);
            }}
            style={{
              minHeight: MIN_TOUCH_TARGET,
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderRadius: radii.md,
              borderWidth: 2,
              borderColor: selected ? colors.accent : colors.borderStrong,
              backgroundColor: colors.surface,
            }}
          >
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: radii.pill,
                borderWidth: 2,
                borderColor: selected ? colors.accent : colors.borderStrong,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {selected ? (
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: radii.pill,
                    backgroundColor: colors.accent,
                  }}
                />
              ) : null}
            </View>
            <Text bold={selected}>{choice.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
