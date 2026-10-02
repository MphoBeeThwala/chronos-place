import { Button, Heading, Screen, Text, useTheme } from '@chronos/ui';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

/**
 * The first screen. It states the privacy promise before anything asks for health information
 * (PRD). Sign-up arrives with M1.7, which adds its entry point here.
 */
export default function Welcome() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors, radii, spacing } = useTheme();

  return (
    <Screen testID="welcome-screen">
      <View style={{ gap: spacing.sm }}>
        <Heading>{t('welcome.title')}</Heading>
        <Text color="textMuted">{t('welcome.tagline')}</Text>
      </View>

      <View
        style={{
          gap: spacing.md,
          padding: spacing.lg,
          borderRadius: radii.lg,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Heading level={2}>{t('welcome.privacyHeading')}</Heading>
        <Text>{t('welcome.promises.hidden')}</Text>
        <Text>{t('welcome.promises.control')}</Text>
        <Text>{t('welcome.promises.neverSold')}</Text>
      </View>

      <Button
        testID="open-settings"
        variant="secondary"
        label={t('welcome.openSettings')}
        onPress={() => {
          router.push('/settings');
        }}
      />
    </Screen>
  );
}
