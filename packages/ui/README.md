# @chronos/ui

The React Native design system. Tokens, theming and a small set of accessible components.

```tsx
import { Button, Heading, Screen, ThemeProvider } from '@chronos/ui';

<ThemeProvider preference="system">
  <Screen>
    <Heading>Welcome</Heading>
    <Button label="Continue" onPress={next} />
  </Screen>
</ThemeProvider>;
```

## Tokens

`src/tokens` holds colours (light and dark), spacing, radii, the type scale, motion durations, `MIN_TOUCH_TARGET` (44 pt) and `MAX_FONT_SCALE` (2). The palette is provisional (warm terracotta, no clinical blues or red ribbons, per the PRD) until the Figma design system supplies final values; change colours in `colors.ts` only.

`test/contrast.test.ts` fails if any text pairing drops below 4.5:1 or any control border or focus ring below 3:1 (WCAG 2.2 AA), in both themes.

## Components

| Component                                         | Guarantees                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                          | at least 44×44 pt; the label is both the visible text and the accessible label; reports disabled and busy to screen readers; ignores presses while loading |
| `ChoiceGroup`                                     | read out as a radio group; each option says whether it is selected; options are at least 44 pt tall                                                        |
| `Text` / `Heading`                                | scale with the system font size up to 200%; `Heading` is announced as a heading                                                                            |
| `Screen`                                          | themed background, safe-area insets, scrolls so large text is never clipped                                                                                |
| `ThemeProvider` / `useTheme` / `useReducedMotion` | the member's choice wins; "system" follows the device; reduced motion is exposed to animations                                                             |

Colours are always token names, never raw values. Copy is not in this package; screens take it from the i18n catalogues.

## Tests

Pure TypeScript (tokens, contrast) runs under Vitest; component rendering runs under Jest with `jest-expo` (ADR-0017). `pnpm test` runs both.
