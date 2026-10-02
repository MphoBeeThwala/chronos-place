import { ThemeProvider, useReducedMotion, useTheme } from '@chronos/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { getLocales } from 'expo-localization';
import { availableLanguages, i18n, pickLanguage } from '../src/i18n';
import { createQueryClient } from '../src/query/client';
import { useHydrated, usePreferences } from '../src/store/preferences';

void SplashScreen.preventAutoHideAsync();

function Navigator() {
  const { colors, scheme } = useTheme();
  const reducedMotion = useReducedMotion();
  const { t } = useTranslation();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
          headerTitleStyle: { color: colors.text },
          headerBackTitle: t('common.back'),
          contentStyle: { backgroundColor: colors.background },
          // Honour the device's reduced-motion setting (PRD: protects members with photosensitive conditions).
          animation: reducedMotion ? 'none' : 'default',
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ title: t('settings.title') }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);
  const hydrated = useHydrated();
  const theme = usePreferences((state) => state.theme);
  const language = usePreferences((state) => state.language);

  useEffect(() => {
    if (!hydrated) return;
    const device = getLocales().flatMap((locale) =>
      locale.languageCode === null ? [] : [locale.languageCode],
    );
    void i18n
      .changeLanguage(pickLanguage(language, device, availableLanguages()))
      .then(() => SplashScreen.hideAsync());
  }, [hydrated, language]);

  if (!hydrated) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider preference={theme}>
          <Navigator />
        </ThemeProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}
