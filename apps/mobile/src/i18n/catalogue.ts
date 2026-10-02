type Tree = { readonly [key: string]: string | Tree };

/** Dotted paths of every string in a catalogue, e.g. `welcome.promises.hidden`. */
export function flattenKeys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : flattenKeys(value, `${prefix}${key}.`),
  );
}

/** Every string in a catalogue, with its path. */
export function flattenEntries(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]): [string, string][] =>
    typeof value === 'string'
      ? [[`${prefix}${key}`, value]]
      : flattenEntries(value, `${prefix}${key}.`),
  );
}

/** Keys the reference has that the candidate lacks. A translation with any of these would show a raw key. */
export function missingKeys(reference: Tree, candidate: Tree): string[] {
  const have = new Set(flattenKeys(candidate));
  return flattenKeys(reference).filter((key) => !have.has(key));
}

/** Keys the candidate has that the reference lacks (stale or misspelt). */
export function extraKeys(reference: Tree, candidate: Tree): string[] {
  return missingKeys(candidate, reference);
}

/**
 * Words and phrases that stigmatise people living with a condition or disability. The catalogues
 * must use person-first language ("living with HIV", "a person with diabetes").
 */
const STIGMA_TERMS = [
  'infected',
  'infectious person',
  'victim',
  'victims',
  'suffer',
  'suffers',
  'suffering',
  'sufferer',
  'sufferers',
  'afflicted',
  'aids patient',
  'aids patients',
  'diabetics',
  'epileptics',
  'handicapped',
  'wheelchair-bound',
  'confined to a wheelchair',
  'cripple',
  'crippled',
  'normal people',
  'clean',
  'dirty',
  'risky',
] as const;

/** Stigmatising terms found in `text`, matched as whole words, ignoring case. */
export function findStigmaTerms(text: string): string[] {
  return STIGMA_TERMS.filter((term) =>
    new RegExp(
      `(?<![\\p{L}-])${term.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\p{L}-])`,
      'iu',
    ).test(text),
  );
}
