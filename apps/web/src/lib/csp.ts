/**
 * The Content Security Policy (ADR-0017, TASKS M1.9), built per request with a fresh nonce.
 * Scripts run only when they carry this request's nonce, or are loaded by one that does
 * ('strict-dynamic'), so an injected inline script never runs. No 'unsafe-inline' scripts.
 *
 * Styles keep 'unsafe-inline': the app sets colours through inline style attributes, which a
 * nonce cannot cover, and styles cannot run code.
 */
export interface CspOptions {
  nonce: string;
  /** Photo storage origin (ADR-0024): images load from it and uploads go to it. */
  storage?: string | undefined;
  /** Next.js development needs eval for hot reload; never set in production. */
  development?: boolean;
}

export function buildCsp({ nonce, storage, development = false }: CspOptions): string {
  const extra = storage ? ` ${storage}` : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // The app and the media store only: no other site can be loaded as an image.
    `img-src 'self' data: blob:${extra}`,
    "font-src 'self'",
    `connect-src 'self'${extra}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** 128 random bits, base64: unguessable, and different on every request. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** The request header the middleware uses to hand the nonce to server components. */
export const NONCE_HEADER = 'x-nonce';
