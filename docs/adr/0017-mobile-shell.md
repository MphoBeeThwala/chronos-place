# ADR-0017: Mobile app shell and design system

## Decisions
- **Tokens in code.** `@chronos/ui` is the source of truth for colours, spacing, type, motion and sizing. Tokens will be synced with Figma when the design system exists. The palette is provisional (warm terracotta; no clinical blues or red ribbons).
- **Contrast is a test.** Every text pairing must meet 4.5:1 and every control border or focus ring 3:1, in light and dark (WCAG 2.2 AA, PRD accessibility requirements).
- **Accessibility by construction.** Components require the information assistive technology needs: `Button` takes a `label` (visible and accessible), is at least 44×44 pt and reports disabled and busy; text scales to 200%; reduced motion is exposed through `useReducedMotion`. Lint rules (M0.12 part 2) enforce labels and translated text in screens. `eslint-plugin-react-native-a11y` supports ESLint 8 at most and `eslint-plugin-react` stops at ESLint 9, so we write small rules of our own and use `eslint-plugin-react-hooks`.
- **Two test runners, one for each job.** Vitest for pure TypeScript (tokens, contrast, catalogues, lint rules). Jest with `jest-expo` and React Native Testing Library for rendering React Native components, because that is the supported route for Expo and Vitest cannot run React Native's native modules. Jest is used only in `apps/mobile` and `packages/ui`.
- **Expo SDK 57 versions.** React, React Native and Expo modules are pinned to the versions `expo` bundles (React 19.2.3, React Native 0.86.3), not the latest on npm. Upgrade them together with the SDK. Component tests use `@testing-library/react-native` 13 with `react-test-renderer` 19.2.3; version 14 needs `test-renderer` and React 19.3.
- **React Native TypeScript preset.** `@chronos/tsconfig/react-native.json` (bundler module resolution, `jsx: react-native`). Source in React Native packages uses extension-less imports, because Metro does not map `.js` to `.ts`.
- **Shell scope.** Welcome and Settings only. Tabs, auth and health screens arrive with their tasks (M1.7, M2.8, M3.5).
- **No over-the-air updates yet.** `expo-updates` contacts Expo's servers. It stays off until an ADR approves it and restricts it to JavaScript-only fixes (spec section 9).
- **Query cache is never persisted.** Health views must not reach disk (ADR-0009), so the TanStack persistence packages are on the banned-dependency list.
