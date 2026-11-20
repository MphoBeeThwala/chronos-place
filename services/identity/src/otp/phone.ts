/**
 * South African mobile numbers only at launch (ADR-0018): +27 followed by 9 digits starting
 * 6, 7 or 8. Accepts the common ways people type them and returns E.164, or undefined.
 */
const SOUTH_AFRICAN_MOBILE = /^\+27[6-8]\d{8}$/;

export function parseSouthAfricanMobile(input: string): string | undefined {
  if (input.length > 32) return undefined;
  const compact = input.replace(/[\s\-().]/g, '');
  let e164: string;
  if (compact.startsWith('+')) e164 = compact;
  else if (compact.startsWith('0027')) e164 = `+${compact.slice(2)}`;
  else if (compact.startsWith('27')) e164 = `+${compact}`;
  else if (compact.startsWith('0')) e164 = `+27${compact.slice(1)}`;
  else return undefined;
  return SOUTH_AFRICAN_MOBILE.test(e164) ? e164 : undefined;
}

/** Last two digits only, the most a log line may show (ADR-0006). */
export function phoneHint(e164: string): string {
  return `••${e164.slice(-2)}`;
}
