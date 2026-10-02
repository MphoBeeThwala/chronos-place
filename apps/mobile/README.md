# @chronos/mobile

The member app: Expo SDK 57, Expo Router, TanStack Query, Zustand, i18next and `@chronos/ui`.

```sh
pnpm install
pnpm --filter @chronos/mobile start         # Metro for a development build (expo-dev-client)
pnpm --filter @chronos/mobile ios           # build and run on the iOS simulator (macOS)
pnpm --filter @chronos/mobile android       # build and run on an Android emulator or device
pnpm --filter @chronos/mobile bundle:check  # compile the iOS and Android JavaScript bundles
pnpm --filter @chronos/mobile test          # Vitest (pure logic) then Jest (screens)
maestro test apps/mobile/.maestro           # end-to-end flows on a running simulator or emulator
```

## What is here

- **Welcome** (`app/index.tsx`): the privacy promise, shown before anything asks for health information. Sign-up joins it in M1.7.
- **Settings** (`app/settings.tsx`): theme (follow device, light, dark), language (appears once a second catalogue exists) and a text-size preview. Preferences persist; nothing else does.
- **Providers** (`app/_layout.tsx`): theme, i18n and TanStack Query. The splash screen stays until stored preferences are loaded, so the first frame has the right theme and language. Screen transitions are off when the device asks for reduced motion.
- **Languages** (`src/i18n`): English now; add isiZulu, isiXhosa, Afrikaans and Sesotho as catalogues in `src/i18n/locales` and register them in `catalogues`. Tests require every language to have exactly the keys English has, and reject stigmatising wording.
- **Query cache** (`src/query/client.ts`): in memory only, short lifetimes. Persisting it is banned (ADR-0009).

## Rules enforced by lint and tests

- Every pressable, input, switch and image carries an accessible label (and pressables a role). Text in screens comes from `t()`. See `@chronos/eslint-config`.
- Buttons and options are at least 44×44 pt, and text scales to 200%.
- No analytics, ads, attribution or session-replay SDKs, no query-cache persistence and no `expo-updates` (`pnpm check:deps`, ADR-0017).
- Maestro flows may only refer to test ids that exist in the app (`tests/maestro.test.ts`).

## Provisional

The name, icon (`assets/`), bundle id and colours are placeholders until branding and the Figma design system are final. The PRD also asks for a neutral name and icon option so the app is not identifiable on a lock screen. Cloud builds use EAS (`eas.json`) and need an Expo account.

## Not verified in this repository's CI environment

Bundling for iOS and Android is checked (`bundle:check`) and the screens render under Jest, but running on a simulator or emulator and the Maestro flows need a macOS machine (iOS) or Android with hardware virtualisation.
