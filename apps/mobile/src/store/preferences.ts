import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SchemePreference } from '@chronos/ui';
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** `system` follows the device; otherwise a language code. */
export type LanguagePreference = string;

export interface Preferences {
  theme: SchemePreference;
  language: LanguagePreference;
}

interface PreferencesState extends Preferences {
  setTheme: (theme: SchemePreference) => void;
  setLanguage: (language: LanguagePreference) => void;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: 'system', language: 'system' };

const THEMES: readonly SchemePreference[] = ['system', 'light', 'dark'];

/**
 * Anything read back from storage is untrusted (it may be from an older version or corrupted), so
 * only known values are accepted and the rest fall back to the defaults.
 */
export function sanitizePreferences(value: unknown): Preferences {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const theme = THEMES.find((t) => t === record['theme']) ?? DEFAULT_PREFERENCES.theme;
  const language =
    typeof record['language'] === 'string' && /^[a-z]{2,3}$|^system$/.test(record['language'])
      ? record['language']
      : DEFAULT_PREFERENCES.language;
  return { theme, language };
}

/**
 * Interface preferences only. Nothing sensitive is stored here: health data never reaches the disk
 * (ADR-0009) and tokens will live in secure storage.
 */
export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      setTheme: (theme) => {
        set({ theme });
      },
      setLanguage: (language) => {
        set({ language });
      },
    }),
    {
      name: 'chronos.preferences.v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ theme, language }) => ({ theme, language }),
      merge: (persisted, current) => ({ ...current, ...sanitizePreferences(persisted) }),
    },
  ),
);

/** True once stored preferences have been read, so the first screen shows the right theme and language. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    (onChange) => usePreferences.persist.onFinishHydration(onChange),
    () => usePreferences.persist.hasHydrated(),
    () => false,
  );
}
