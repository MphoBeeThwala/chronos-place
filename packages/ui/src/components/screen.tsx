import type { ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme-context';

export interface ScreenProps {
  children: ReactNode;
  testID?: string;
}

/**
 * The base of every screen: themed background, safe-area insets, and scrolling so content never
 * gets clipped at large text sizes.
 */
export function Screen({ children, testID }: ScreenProps) {
  const { colors, spacing } = useTheme();
  return (
    <SafeAreaView testID={testID} style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}
