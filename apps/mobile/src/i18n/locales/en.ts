/**
 * English catalogue, and the shape every other language must match. Copy is person-first and
 * stigma-free (CLAUDE.md): `tests/copy.test.ts` rejects terms such as "infected" or "victim".
 */
export const en = {
  welcome: {
    title: 'Welcome',
    tagline: 'Dating and connection, on your terms.',
    privacyHeading: 'Your privacy comes first',
    promises: {
      hidden: 'Your health information stays hidden until you choose to share it.',
      control: 'You decide who sees what, and you can take it back at any time.',
      neverSold: 'We never sell your data.',
    },
    openSettings: 'Settings',
  },
  settings: {
    title: 'Settings',
    theme: {
      label: 'Theme',
      system: 'Follow my device',
      light: 'Light',
      dark: 'Dark',
    },
    language: { label: 'Language' },
    textSize: {
      heading: 'Text size',
      body: 'Text follows your device settings, up to twice the normal size.',
      sample: 'The quick brown fox jumps over the lazy dog.',
    },
  },
  common: { back: 'Back' },
} as const;

/** The shape every catalogue must have, with the literal English strings widened to `string`. */
type Widen<T> = { readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Catalogue = Widen<typeof en>;
