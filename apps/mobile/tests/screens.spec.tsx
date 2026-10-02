import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MIN_TOUCH_TARGET, ThemeProvider, darkColors, type SchemePreference } from '@chronos/ui';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { StyleSheet } from 'react-native';
import type * as I18nModule from '../src/i18n';
import Settings from '../app/settings';
import Welcome from '../app/index';
import { DEFAULT_LANGUAGE, createI18n } from '../src/i18n';
import { en } from '../src/i18n/locales/en';
import { DEFAULT_PREFERENCES, usePreferences } from '../src/store/preferences';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

let mockLanguages = ['en'];
jest.mock('../src/i18n', () => ({
  ...jest.requireActual<typeof I18nModule>('../src/i18n'),
  availableLanguages: () => mockLanguages,
}));

/** What the root layout provides: the member's theme and language preference. */
function App({ children }: { children: ReactNode }) {
  const theme = usePreferences((state) => state.theme);
  const i18n = createI18n({ en }, DEFAULT_LANGUAGE);
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider preference={theme} systemScheme="light">
        {children}
      </ThemeProvider>
    </I18nextProvider>
  );
}

const style = (node: { props: Record<string, unknown> }) =>
  StyleSheet.flatten(node.props['style'] as never) as Record<string, unknown>;

beforeEach(async () => {
  mockPush.mockClear();
  mockLanguages = ['en'];
  await AsyncStorage.clear();
  act(() => {
    usePreferences.setState({ ...DEFAULT_PREFERENCES });
  });
});

describe('Welcome', () => {
  it('shows the privacy promise before anything asks for health information', () => {
    render(
      <App>
        <Welcome />
      </App>,
    );
    expect(screen.getByRole('header', { name: en.welcome.title })).toBeTruthy();
    expect(screen.getByText(en.welcome.tagline)).toBeTruthy();
    expect(screen.getByRole('header', { name: en.welcome.privacyHeading })).toBeTruthy();
    for (const promise of Object.values(en.welcome.promises))
      expect(screen.getByText(promise)).toBeTruthy();
  });

  it('opens Settings from a labelled button of at least 44 pt', () => {
    render(
      <App>
        <Welcome />
      </App>,
    );
    const button = screen.getByRole('button', { name: en.welcome.openSettings });
    expect(style(button)['minHeight']).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    fireEvent.press(button);
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  it('labels every button', () => {
    render(
      <App>
        <Welcome />
      </App>,
    );
    for (const button of screen.getAllByRole('button')) {
      expect(String(button.props['accessibilityLabel'] ?? '').length).toBeGreaterThan(0);
    }
  });
});

describe('Settings', () => {
  it('offers the three themes as a radio group, defaulting to the device setting', () => {
    render(
      <App>
        <Settings />
      </App>,
    );
    expect(screen.getByLabelText(en.settings.theme.label).props['accessibilityRole']).toBe(
      'radiogroup',
    );
    expect(
      screen.getByRole('radio', { name: en.settings.theme.system }).props['accessibilityState'],
    ).toMatchObject({ checked: true });
    expect(
      screen.getByRole('radio', { name: en.settings.theme.dark }).props['accessibilityState'],
    ).toMatchObject({ checked: false });
  });

  it('switches to the dark theme, and the screen follows', () => {
    render(
      <App>
        <Settings />
      </App>,
    );
    fireEvent.press(screen.getByRole('radio', { name: en.settings.theme.dark }));
    expect(usePreferences.getState().theme).toBe<SchemePreference>('dark');
    expect(
      screen.getByRole('radio', { name: en.settings.theme.dark }).props['accessibilityState'],
    ).toMatchObject({ checked: true });
    expect(style(screen.getByTestId('settings-screen'))['backgroundColor']).toBe(
      darkColors.background,
    );
  });

  it('stores only the interface preferences, nothing else', async () => {
    render(
      <App>
        <Settings />
      </App>,
    );
    fireEvent.press(screen.getByRole('radio', { name: en.settings.theme.dark }));
    await waitFor(async () => {
      expect(await AsyncStorage.getAllKeys()).toEqual(['chronos.preferences.v1']);
    });
    const stored = JSON.parse((await AsyncStorage.getItem('chronos.preferences.v1')) ?? '{}') as {
      state: Record<string, unknown>;
    };
    expect(Object.keys(stored.state).sort()).toEqual(['language', 'theme']);
    expect(stored.state['theme']).toBe('dark');
  });

  it('ignores corrupted stored preferences when they are read back', async () => {
    await AsyncStorage.setItem(
      'chronos.preferences.v1',
      JSON.stringify({ state: { theme: 'purple', language: '../x' }, version: 0 }),
    );
    await act(async () => {
      await usePreferences.persist.rehydrate();
    });
    expect(usePreferences.getState().theme).toBe('system');
    expect(usePreferences.getState().language).toBe('system');
  });

  it('hides the language choice while only one language exists', () => {
    render(
      <App>
        <Settings />
      </App>,
    );
    expect(screen.queryByLabelText(en.settings.language.label)).toBeNull();
  });

  it('shows the language choice, each language in its own name, once there are two', () => {
    mockLanguages = ['en', 'af'];
    render(
      <App>
        <Settings />
      </App>,
    );
    expect(screen.getByLabelText(en.settings.language.label).props['accessibilityRole']).toBe(
      'radiogroup',
    );
    fireEvent.press(screen.getByRole('radio', { name: 'Afrikaans' }));
    expect(usePreferences.getState().language).toBe('af');
    expect(screen.getByRole('radio', { name: 'English' })).toBeTruthy();
  });

  it('lets text scale with the device up to 200%', () => {
    render(
      <App>
        <Settings />
      </App>,
    );
    const sample = screen.getByTestId('text-size-sample');
    expect(sample.props['allowFontScaling']).toBe(true);
    expect(sample.props['maxFontSizeMultiplier']).toBe(2);
  });

  it('keeps every option at least 44 pt tall', () => {
    render(
      <App>
        <Settings />
      </App>,
    );
    for (const radio of screen.getAllByRole('radio')) {
      expect(style(radio)['minHeight']).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    }
  });
});
