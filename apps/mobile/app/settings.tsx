import { ChoiceGroup, Heading, Screen, Text, useTheme, type SchemePreference } from '@chronos/ui';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { availableLanguages, languageNames } from '../src/i18n';
import { usePreferences } from '../src/store/preferences';

export default function Settings() {
  const { t } = useTranslation();
  const { spacing } = useTheme();
  const theme = usePreferences((state) => state.theme);
  const language = usePreferences((state) => state.language);
  const setTheme = usePreferences((state) => state.setTheme);
  const setLanguage = usePreferences((state) => state.setLanguage);

  const themeChoices: { value: SchemePreference; label: string }[] = [
    { value: 'system', label: t('settings.theme.system') },
    { value: 'light', label: t('settings.theme.light') },
    { value: 'dark', label: t('settings.theme.dark') },
  ];
  const codes = availableLanguages();
  const languageChoices = [
    { value: 'system', label: t('settings.theme.system') },
    ...codes.map((code) => ({ value: code, label: languageNames[code] ?? code })),
  ];

  return (
    <Screen testID="settings-screen">
      <View style={{ gap: spacing.md }}>
        <Heading level={2}>{t('settings.theme.label')}</Heading>
        <ChoiceGroup
          testID="theme-choice"
          label={t('settings.theme.label')}
          choices={themeChoices}
          value={theme}
          onChange={setTheme}
        />
      </View>

      {codes.length > 1 ? (
        <View style={{ gap: spacing.md }}>
          <Heading level={2}>{t('settings.language.label')}</Heading>
          <ChoiceGroup
            testID="language-choice"
            label={t('settings.language.label')}
            choices={languageChoices}
            value={language}
            onChange={setLanguage}
          />
        </View>
      ) : null}

      <View style={{ gap: spacing.md }}>
        <Heading level={2}>{t('settings.textSize.heading')}</Heading>
        <Text color="textMuted">{t('settings.textSize.body')}</Text>
        <Text testID="text-size-sample">{t('settings.textSize.sample')}</Text>
      </View>
    </Screen>
  );
}
