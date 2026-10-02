import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import {
  resolveScheme,
  themeFor,
  type Scheme,
  type SchemePreference,
  type Theme,
} from './tokens/index';

const ThemeContext = createContext<Theme | null>(null);

export interface ThemeProviderProps {
  /** The member's choice. `system` follows the device. */
  preference?: SchemePreference;
  /** Overrides the device scheme (tests, previews). */
  systemScheme?: Scheme | null;
  children: ReactNode;
}

/** Supplies the active theme to every component below it. */
export function ThemeProvider({
  preference = 'system',
  systemScheme,
  children,
}: ThemeProviderProps) {
  const reported = useColorScheme();
  const device: Scheme | null = reported === 'dark' || reported === 'light' ? reported : null;
  const scheme = resolveScheme(preference, systemScheme === undefined ? device : systemScheme);
  const theme = useMemo(() => themeFor(scheme), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === null) throw new Error('useTheme must be used inside a ThemeProvider');
  return theme;
}

/** True when the device asks for reduced motion. Skip or shorten animations when it is. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}
