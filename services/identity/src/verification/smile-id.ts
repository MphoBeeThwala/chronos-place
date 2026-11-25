import { createHmac } from 'node:crypto';
import type { Secret } from '@chronos/config';
import type { LivenessCapture } from './capture.js';
import type { LivenessProvider, ProviderResult } from './provider.js';
import { zipStored } from './zip.js';

/**
 * Smile ID SmartSelfie registration (job type 4) over its REST API (ADR-0022). Server to server:
 * the browser never talks to Smile ID.
 *
 * - The random attempt reference is both the job id and the user id, so Smile ID never sees our
 *   account id, and one attempt maps to one Smile ID "user" that can be deleted on its own.
 * - Nothing but the images and that reference is sent: no name, phone, date of birth or health
 *   data, and no callback URL (we ask for results instead, ADR-0022 decision 7).
 * - Errors carry the HTTP status only, never response bodies, which could echo request data.
 */
export const SMILE_ID_BASE_URLS = {
  sandbox: 'https://testapi.smileidentity.com',
  production: 'https://api.smileidentity.com',
} as const;
export type SmileIdEnvironment = keyof typeof SMILE_ID_BASE_URLS;

const JOB_TYPE_SMARTSELFIE_REGISTRATION = 4;
const SELFIE_BASE64 = 2;
const LIVENESS_BASE64 = 6;
const TIMEOUT_MS = 15_000;

/** Registration result codes (Smile ID SmartSelfie docs). Anything else is "unavailable". */
const PASSED = new Set(['0840', '1240']);
const IN_REVIEW = new Set(['0844', '0846']);
const POOR_QUALITY = new Set(['0941', '0942', '1241']);
const NOT_CONFIRMED = new Set(['0841', '1242']);

export class SmileIdError extends Error {
  constructor(step: string, status: number) {
    super(`Smile ID ${step} failed with HTTP ${String(status)}`);
    this.name = 'SmileIdError';
  }
}

export interface SmileIdOptions {
  partnerId: string;
  apiKey: Secret;
  environment: SmileIdEnvironment;
  /** Tests point this at a local fake. */
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Smile ID's request signature: base64 HMAC-SHA256 of timestamp + partner id + "sid_request". */
export function smileSignature(apiKey: string, timestamp: string, partnerId: string): string {
  return createHmac('sha256', apiKey)
    .update(timestamp, 'utf8')
    .update(partnerId, 'utf8')
    .update('sid_request', 'utf8')
    .digest('base64');
}

export function mapResultCode(code: string | undefined): ProviderResult {
  if (code === undefined) return { state: 'unavailable' };
  if (PASSED.has(code)) return { state: 'passed' };
  if (IN_REVIEW.has(code)) return { state: 'pending' };
  if (POOR_QUALITY.has(code)) return { state: 'failed', failure: 'poor_quality' };
  if (NOT_CONFIRMED.has(code)) return { state: 'failed', failure: 'not_confirmed' };
  return { state: 'unavailable' };
}

export class SmileIdProvider implements LivenessProvider {
  readonly name = 'smile-id';
  readonly #o: Required<Omit<SmileIdOptions, 'baseUrl'>> & { baseUrl: string };

  constructor(options: SmileIdOptions) {
    this.#o = {
      fetch: (...args) => fetch(...args),
      now: () => new Date(),
      ...options,
      baseUrl: options.baseUrl ?? SMILE_ID_BASE_URLS[options.environment],
    };
  }

  #signed() {
    const timestamp = this.#o.now().toISOString();
    return {
      timestamp,
      signature: smileSignature(this.#o.apiKey.reveal(), timestamp, this.#o.partnerId),
    };
  }

  async #post(step: string, path: string, body: object, headers: Record<string, string> = {}) {
    const response = await this.#o.fetch(`${this.#o.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new SmileIdError(step, response.status);
    return (await response.json()) as Record<string, unknown>;
  }

  async submit(reference: string, capture: LivenessCapture): Promise<{ jobId: string }> {
    const prep = await this.#post('upload', '/v1/upload', {
      ...this.#signed(),
      source_sdk: 'rest_api',
      source_sdk_version: '1.0.0',
      smile_client_id: this.#o.partnerId,
      partner_params: {
        job_id: reference,
        user_id: reference,
        job_type: JOB_TYPE_SMARTSELFIE_REGISTRATION,
      },
      model_parameters: {},
      callback_url: '',
    });
    const uploadUrl = prep['upload_url'];
    if (typeof uploadUrl !== 'string' || !uploadUrl.startsWith('https://')) {
      throw new SmileIdError('upload', 502);
    }

    const info = {
      package_information: { apiVersion: { buildNumber: 0, majorVersion: 2, minorVersion: 0 } },
      id_info: {},
      images: [
        { image_type_id: SELFIE_BASE64, image: capture.selfie.toString('base64') },
        ...capture.frames.map((f) => ({
          image_type_id: LIVENESS_BASE64,
          image: f.toString('base64'),
        })),
      ],
    };
    const zip = zipStored([{ name: 'info.json', data: Buffer.from(JSON.stringify(info)) }]);
    const put = await this.#o.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/zip' },
      body: zip,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!put.ok) throw new SmileIdError('zip upload', put.status);
    return { jobId: reference };
  }

  async result(jobId: string): Promise<ProviderResult> {
    const status = await this.#post('job status', '/v1/job_status', {
      ...this.#signed(),
      partner_id: this.#o.partnerId,
      user_id: jobId,
      job_id: jobId,
      image_links: false,
      history: false,
    });
    if (status['job_complete'] !== true) return { state: 'pending' };
    const result = status['result'] as { ResultCode?: unknown } | undefined;
    return mapResultCode(typeof result?.ResultCode === 'string' ? result.ResultCode : undefined);
  }

  async forget(jobId: string): Promise<void> {
    const { timestamp, signature } = this.#signed();
    const response = await this.#o.fetch(`${this.#o.baseUrl}/v2/block-user`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'smileid-partner-id': this.#o.partnerId,
        'smileid-request-signature': signature,
        'smileid-timestamp': timestamp,
      },
      body: JSON.stringify({ deleted: true, user_id: jobId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 404: Smile ID has no such user (never enrolled, or already deleted). Deletion is idempotent.
    if (!response.ok && response.status !== 404) throw new SmileIdError('delete', response.status);
  }
}
