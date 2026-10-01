/**
 * Mandatory redaction lists. Callers can add keys (`extraRedactKeys`) but never remove these.
 *
 * Keys are normalised (lower-case, letters and digits only) before matching, so
 * `health_profile`, `HealthProfile` and `health-profile` are the same key.
 */

/** Any key containing one of these fragments is redacted. Fragments are long enough to avoid false hits. */
export const REDACT_KEY_FRAGMENTS: readonly string[] = [
  // credentials and tokens
  'password',
  'passcode',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'credential',
  'privatekey',
  'signature',
  // personal identifiers
  'phone',
  'email',
  'dateofbirth',
  'birthdate',
  'selfie',
  // location
  'latitude',
  'longitude',
  'coordinate',
  'geolocation',
  'geohash',
  // health data and anything that implies it (CLAUDE.md rule 3)
  'health',
  'condition',
  'diagnos',
  'medication',
  'treatment',
  'disclosure',
  'visibility',
  'grant',
  'taxonomy',
  // cryptographic material and ciphertext
  'ciphertext',
  'plaintext',
  'wrappeddek',
  'datakey',
  'nonce',
  // message content
  'messagebody',
  'messagetext',
];

/** Short keys that need an exact match because they would false-positive as fragments. */
export const REDACT_KEY_EXACT: readonly string[] = [
  'hiv',
  'dob',
  'otp',
  'pin',
  'code',
  'lat',
  'lng',
  'lon',
  'note',
  'notes',
  'freetext',
  'body',
  'content',
  'text',
  'dek',
  'ct',
  'jwt',
  'bio',
  'location',
  'address',
  'status',
  'payload',
  'evidence',
  'filter',
  'filters',
  'preferences',
];

/** Fields that are always safe and identify the event, not the member. */
export const ALLOWLIST_BASE_FIELDS: readonly string[] = [
  'level',
  'time',
  'service',
  'env',
  'msg',
  'event',
  'requestId',
  'traceId',
  'spanId',
  'durationMs',
  'statusCode',
  'method',
  'route',
  'errType',
  'errCode',
  'droppedFields',
  'count',
  'attempt',
  'v',
  'pid',
  'hostname',
];

export const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');
