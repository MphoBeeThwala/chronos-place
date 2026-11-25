import { createHmac } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Secret } from '@chronos/config';
import { describe, expect, it } from 'vitest';
import {
  mapResultCode,
  SmileIdError,
  SmileIdProvider,
  smileSignature,
} from '../src/verification/smile-id.js';
import { zipStored } from '../src/verification/zip.js';
import { capture } from './support/verification-harness.js';

const PARTNER = '2468';
const API_KEY = 'synthetic-smile-api-key-for-tests';
const NOW = new Date('2026-11-25T10:00:00.123Z');
const REFERENCE = '5a1b6c2d-0000-4000-8000-00000000abcd';
const UPLOAD_URL = 'https://uploads.example.test/job/attachments.zip?sig=x';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for Smile ID's API, answering from a route table and recording every request. */
function fakeFetch(routes: Record<string, (body: unknown) => { status?: number; json?: unknown }>) {
  const requests: Recorded[] = [];
  const fn = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const raw = init?.body;
    const body: unknown =
      raw instanceof Uint8Array
        ? Buffer.from(raw)
        : JSON.parse(typeof raw === 'string' ? raw : '{}');
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body,
    });
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
    const answer = route ? route(body) : { status: 404 };
    return Promise.resolve(
      new Response(answer.json === undefined ? '' : JSON.stringify(answer.json), {
        status: answer.status ?? 200,
      }),
    );
  };
  return { fn: fn as typeof fetch, requests };
}

function provider(fetchFn: typeof fetch) {
  return new SmileIdProvider({
    partnerId: PARTNER,
    apiKey: new Secret(API_KEY),
    environment: 'sandbox',
    fetch: fetchFn,
    now: () => NOW,
  });
}

/** Reads a stored (uncompressed) zip and checks each entry's CRC. */
function unzipStored(zip: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    expect(zip.readUInt16LE(offset + 8)).toBe(0);
    const crc = zip.readUInt32LE(offset + 14);
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const data = zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    offset += 30 + nameLength + size;
  }
  expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  return files;
}

const signatureFor = (timestamp: string) =>
  createHmac('sha256', API_KEY).update(`${timestamp}${PARTNER}sid_request`).digest('base64');

describe('Smile ID signature', () => {
  it('is base64 HMAC-SHA256 of timestamp, partner id and "sid_request"', () => {
    expect(smileSignature(API_KEY, NOW.toISOString(), PARTNER)).toBe(
      signatureFor(NOW.toISOString()),
    );
  });
});

describe('submitting a capture', () => {
  it('sends only the images and the random reference, as a SmartSelfie registration', async () => {
    const fake = fakeFetch({
      'https://testapi.smileidentity.com/v1/upload': () => ({
        json: { upload_url: UPLOAD_URL, smile_job_id: '0000001', ref_id: 'r' },
      }),
      [UPLOAD_URL]: () => ({}),
    });
    const c = capture();
    expect(await provider(fake.fn).submit(REFERENCE, c)).toEqual({ jobId: REFERENCE });

    const [prep, put] = fake.requests;
    expect(prep?.method).toBe('POST');
    expect(prep?.body).toEqual({
      timestamp: NOW.toISOString(),
      signature: signatureFor(NOW.toISOString()),
      source_sdk: 'rest_api',
      source_sdk_version: '1.0.0',
      smile_client_id: PARTNER,
      partner_params: { job_id: REFERENCE, user_id: REFERENCE, job_type: 4 },
      model_parameters: {},
      callback_url: '',
    });

    expect(put).toMatchObject({ url: UPLOAD_URL, method: 'PUT' });
    expect(put?.headers['content-type']).toBe('application/zip');
    const files = unzipStored(put?.body as Buffer);
    expect([...files.keys()]).toEqual(['info.json']);
    const info = JSON.parse(files.get('info.json')?.toString() ?? '{}') as {
      id_info: object;
      images: { image_type_id: number; image: string }[];
    };
    expect(info.id_info).toEqual({});
    expect(info.images.map((i) => i.image_type_id)).toEqual([2, 6, 6, 6]);
    expect(Buffer.from(info.images[0]?.image ?? '', 'base64').equals(c.selfie)).toBe(true);
  });

  it('refuses an upload address that is not HTTPS and reports HTTP failures without bodies', async () => {
    const insecure = fakeFetch({
      'https://testapi.smileidentity.com/v1/upload': () => ({
        json: { upload_url: 'http://x.test/z' },
      }),
    });
    await expect(provider(insecure.fn).submit(REFERENCE, capture())).rejects.toBeInstanceOf(
      SmileIdError,
    );
    expect(insecure.requests).toHaveLength(1);

    const refused = fakeFetch({
      'https://testapi.smileidentity.com/v1/upload': () => ({
        status: 401,
        json: { error: REFERENCE },
      }),
    });
    const error = await provider(refused.fn)
      .submit(REFERENCE, capture())
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    expect(error?.message).toBe('Smile ID upload failed with HTTP 401');
  });
});

describe('results', () => {
  it('asks for the job by reference, without image links or history', async () => {
    const fake = fakeFetch({
      'https://testapi.smileidentity.com/v1/job_status': () => ({
        json: { job_complete: true, job_success: true, result: { ResultCode: '0840' } },
      }),
    });
    expect(await provider(fake.fn).result(REFERENCE)).toEqual({ state: 'passed' });
    expect(fake.requests[0]?.body).toEqual({
      timestamp: NOW.toISOString(),
      signature: signatureFor(NOW.toISOString()),
      partner_id: PARTNER,
      user_id: REFERENCE,
      job_id: REFERENCE,
      image_links: false,
      history: false,
    });
  });

  it('waits while the job is not complete', async () => {
    const fake = fakeFetch({
      'https://testapi.smileidentity.com/v1/job_status': () => ({ json: { job_complete: false } }),
    });
    expect(await provider(fake.fn).result(REFERENCE)).toEqual({ state: 'pending' });
  });

  it('maps registration result codes to coarse outcomes only', () => {
    expect(mapResultCode('0840')).toEqual({ state: 'passed' });
    expect(mapResultCode('1240')).toEqual({ state: 'passed' });
    expect(mapResultCode('0844')).toEqual({ state: 'pending' });
    expect(mapResultCode('0941')).toEqual({ state: 'failed', failure: 'poor_quality' });
    expect(mapResultCode('0942')).toEqual({ state: 'failed', failure: 'poor_quality' });
    expect(mapResultCode('1241')).toEqual({ state: 'failed', failure: 'poor_quality' });
    expect(mapResultCode('0841')).toEqual({ state: 'failed', failure: 'not_confirmed' });
    expect(mapResultCode('1242')).toEqual({ state: 'failed', failure: 'not_confirmed' });
    expect(mapResultCode('2201')).toEqual({ state: 'unavailable' });
    expect(mapResultCode(undefined)).toEqual({ state: 'unavailable' });
  });
});

describe('deleting the vendor copy', () => {
  it('permanently deletes the per-attempt Smile ID user, and treats "not found" as done', async () => {
    const fake = fakeFetch({
      'https://testapi.smileidentity.com/v2/block-user': () => ({ json: {} }),
    });
    await provider(fake.fn).forget(REFERENCE);
    const [request] = fake.requests;
    expect(request?.body).toEqual({ deleted: true, user_id: REFERENCE });
    expect(request?.headers).toMatchObject({
      'smileid-partner-id': PARTNER,
      'smileid-timestamp': NOW.toISOString(),
      'smileid-request-signature': signatureFor(NOW.toISOString()),
    });

    const missing = fakeFetch({
      'https://testapi.smileidentity.com/v2/block-user': () => ({ status: 404 }),
    });
    await expect(provider(missing.fn).forget(REFERENCE)).resolves.toBeUndefined();
    const down = fakeFetch({
      'https://testapi.smileidentity.com/v2/block-user': () => ({ status: 503 }),
    });
    await expect(provider(down.fn).forget(REFERENCE)).rejects.toBeInstanceOf(SmileIdError);
  });
});

describe('zip writer', () => {
  it('writes entries that read back intact', () => {
    const data = Buffer.from('{"hello":"world"}');
    const files = unzipStored(zipStored([{ name: 'info.json', data }]));
    expect(files.get('info.json')?.equals(data)).toBe(true);
  });
});
