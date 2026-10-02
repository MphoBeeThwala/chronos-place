import { describe, expect, it } from 'vitest';
import { MarkerSet, scanStructure, scanText } from '../src/index.js';

const markers = new MarkerSet('scan-tests');
const text = markers.healthText();
const code = markers.conditionCode();
const phone = markers.phone();
const email = markers.email();
const secret = markers.secret();
const found = (haystack: string) =>
  scanText('test', haystack, markers.all()).map((f) => `${f.marker?.value ?? ''}:${f.form ?? ''}`);

describe('scanText finds a marker however it was encoded', () => {
  it('raw, and in any case', () => {
    expect(found(`prefix ${text} suffix`)).toContain(`${text}:raw`);
    expect(found(text.toLowerCase())).toContain(`${text}:raw`);
    expect(found(code.toUpperCase())).toContain(`${code}:raw`);
  });

  it('percent-encoded and form-encoded in a URL', () => {
    expect(found(`/feed?note=${encodeURIComponent(phone)}`)).toContain(`${phone}:percent-encoded`);
    expect(found(`/feed?note=${encodeURIComponent(phone).replace(/%20/g, '+')}`).join()).toContain(
      phone,
    );
  });

  it('hex', () => {
    expect(found(Buffer.from(email).toString('hex'))).toContain(`${email}:hex`);
  });

  it('JSON-escaped inside a string', () => {
    const payload = JSON.stringify({ message: `he said "${text}"` });
    expect(found(payload)).toContain(`${text}:raw`);
  });

  it('digits only, for phone numbers', () => {
    expect(found(`call ${phone.replace(/\D/g, '')} now`)).toContain(`${phone}:digits-only`);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('base64 embedded after %i leading bytes', (leading) => {
    for (const value of [text, code, email, secret]) {
      const embedded = Buffer.from(`${'-'.repeat(leading)}${value}-trailing`).toString('base64');
      expect(found(embedded).join(), `${value} after ${String(leading)}`).toContain(
        `${value}:base64`,
      );
    }
  });

  it('base64url', () => {
    const embedded = Buffer.from(`ab${secret}cd`).toString('base64url');
    expect(found(embedded).join()).toContain(`${secret}:base64`);
  });
});

describe('scanText does not cry wolf', () => {
  it.each([
    'a normal log line: service started on port 8080',
    '123e4567-e89b-12d3-a456-426614174000 at 2026-10-02T10:00:00.000Z',
    JSON.stringify({ status: 'ok', checks: { database: 'up' } }),
    'x'.repeat(5000),
    Buffer.from('some unrelated base64 payload with no markers in it').toString('base64'),
    new MarkerSet('another-run').healthText(),
  ])('finds nothing in %s', (haystack) => {
    expect(found(haystack)).toEqual([]);
  });

  it('shows a short excerpt, not the whole payload', () => {
    const [finding] = scanText(
      'logs',
      `${'a'.repeat(500)}${text}${'b'.repeat(500)}`,
      markers.all(),
    );
    expect(finding?.excerpt?.length).toBeLessThanOrEqual(120);
    expect(finding?.sink).toBe('logs');
  });
});

describe('scanStructure', () => {
  it('flags sensitive field names that carry unredacted values, at any depth', () => {
    const findings = scanStructure('logs', {
      msg: 'x',
      user: { conditions: ['something'], contacts: [{ phoneNumber: '123' }] },
      meta: { dateOfBirth: '1990-01-01' },
    });
    expect(findings.map((f) => f.detail)).toEqual([
      expect.stringContaining('"conditions"'),
      expect.stringContaining('"phoneNumber"'),
      expect.stringContaining('"dateOfBirth"'),
    ]);
    expect(findings.every((f) => f.type === 'unredacted-field')).toBe(true);
  });

  it('accepts redacted, empty and ordinary fields', () => {
    expect(
      scanStructure('logs', {
        conditions: '[REDACTED]',
        email: '',
        token: null,
        status: 'ok',
        code: 5,
        text: 'hello',
        checks: { database: 'up' },
        droppedFields: 2,
        blob: '[binary 32 bytes]',
        requestId: 'req-123',
      }),
    ).toEqual([]);
  });

  it('copes with cycles-free deep input and non-objects', () => {
    expect(scanStructure('x', 'string')).toEqual([]);
    expect(scanStructure('x', null)).toEqual([]);
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(scanStructure('x', deep)).toEqual([]);
  });
});
