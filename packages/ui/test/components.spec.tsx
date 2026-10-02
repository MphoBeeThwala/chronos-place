import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  Button,
  ChoiceGroup,
  Heading,
  MAX_FONT_SCALE,
  MIN_TOUCH_TARGET,
  Text,
  ThemeProvider,
  darkColors,
  lightColors,
  useTheme,
} from '../src';
import type { ReactNode } from 'react';

const wrap = (ui: ReactNode, preference: 'light' | 'dark' = 'light') =>
  render(<ThemeProvider preference={preference}>{ui}</ThemeProvider>);

describe('Button', () => {
  it('is a labelled button that is at least 44×44 pt', () => {
    wrap(<Button label="Continue" onPress={() => undefined} testID="b" />);
    const button = screen.getByRole('button', { name: 'Continue' });
    const style = StyleSheet.flatten(button.props['style'] as never) as {
      minHeight: number;
      minWidth: number;
    };
    expect(style.minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(style.minWidth).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  it('calls onPress', () => {
    const onPress = jest.fn();
    wrap(<Button label="Continue" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('ignores presses and says so when disabled', () => {
    const onPress = jest.fn();
    wrap(<Button label="Continue" onPress={onPress} disabled />);
    const button = screen.getByRole('button', { name: 'Continue' });
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(button.props['accessibilityState']).toMatchObject({ disabled: true });
  });

  it('announces busy and ignores presses while loading', () => {
    const onPress = jest.fn();
    wrap(<Button label="Saving" onPress={onPress} loading />);
    const button = screen.getByRole('button', { name: 'Saving' });
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(button.props['accessibilityState']).toMatchObject({ busy: true, disabled: true });
  });

  it('passes a hint to screen readers only when given', () => {
    wrap(<Button label="Share" onPress={() => undefined} hint="Opens the sharing options" />);
    expect(screen.getByRole('button', { name: 'Share' }).props['accessibilityHint']).toBe(
      'Opens the sharing options',
    );
  });

  it('uses theme colours: terracotta fill in light, a lighter tone in dark', () => {
    const light = wrap(<Button label="Go" onPress={() => undefined} />, 'light');
    const lightStyle = StyleSheet.flatten(
      light.getByRole('button', { name: 'Go' }).props['style'] as never,
    ) as { backgroundColor: string };
    expect(lightStyle.backgroundColor).toBe(lightColors.accent);
    light.unmount();
    const dark = wrap(<Button label="Go" onPress={() => undefined} />, 'dark');
    const darkStyle = StyleSheet.flatten(
      dark.getByRole('button', { name: 'Go' }).props['style'] as never,
    ) as { backgroundColor: string };
    expect(darkStyle.backgroundColor).toBe(darkColors.accent);
  });
});

describe('Text and Heading', () => {
  it('scales with the system font size up to 200%', () => {
    wrap(<Text testID="t">Hello</Text>);
    const node = screen.getByTestId('t');
    expect(node.props['allowFontScaling']).toBe(true);
    expect(node.props['maxFontSizeMultiplier']).toBe(MAX_FONT_SCALE);
  });

  it('marks headings so screen readers can navigate by them', () => {
    wrap(<Heading>Welcome</Heading>);
    expect(screen.getByRole('header', { name: 'Welcome' })).toBeTruthy();
  });

  it('reads colours from the theme', () => {
    const { getByTestId } = wrap(
      <Text testID="t" color="textMuted">
        Quiet
      </Text>,
      'dark',
    );
    const style = StyleSheet.flatten(getByTestId('t').props['style'] as never) as { color: string };
    expect(style.color).toBe(darkColors.textMuted);
  });
});

describe('ChoiceGroup', () => {
  const choices = [
    { value: 'system', label: 'Follow my device' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ] as const;

  it('is a radio group whose options report which one is selected', () => {
    wrap(<ChoiceGroup label="Theme" choices={choices} value="light" onChange={() => undefined} />);
    // The group itself is not an accessibility element (that would hide its children); it carries the role and name.
    expect(screen.getByLabelText('Theme').props['accessibilityRole']).toBe('radiogroup');
    expect(screen.getByRole('radio', { name: 'Light' }).props['accessibilityState']).toMatchObject({
      checked: true,
    });
    expect(screen.getByRole('radio', { name: 'Dark' }).props['accessibilityState']).toMatchObject({
      checked: false,
    });
  });

  it('reports the new choice when one is pressed', () => {
    const onChange = jest.fn();
    wrap(<ChoiceGroup label="Theme" choices={choices} value="light" onChange={onChange} />);
    fireEvent.press(screen.getByRole('radio', { name: 'Dark' }));
    expect(onChange).toHaveBeenCalledWith('dark');
  });

  it('keeps every option at least 44 pt tall', () => {
    wrap(<ChoiceGroup label="Theme" choices={choices} value="light" onChange={() => undefined} />);
    for (const { label } of choices) {
      const style = StyleSheet.flatten(
        screen.getByRole('radio', { name: label }).props['style'] as never,
      ) as { minHeight: number };
      expect(style.minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    }
  });
});

describe('ThemeProvider', () => {
  const Probe = () => <Text testID="scheme">{useTheme().scheme}</Text>;

  it('follows the preference, or the device when "system"', () => {
    const explicit = render(
      <ThemeProvider preference="dark" systemScheme="light">
        <Probe />
      </ThemeProvider>,
    );
    expect(explicit.getByTestId('scheme').props['children']).toBe('dark');
    explicit.unmount();
    const system = render(
      <ThemeProvider preference="system" systemScheme="dark">
        <Probe />
      </ThemeProvider>,
    );
    expect(system.getByTestId('scheme').props['children']).toBe('dark');
  });

  it('refuses to be used without a provider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
    spy.mockRestore();
  });
});
