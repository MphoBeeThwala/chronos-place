import { phoneHint } from './phone.js';

/**
 * Sends one-time codes. The text is fixed and never names the app, a condition or a health term,
 * so a message on a lock screen does not out the member (ADR-0006).
 */
export interface OtpSender {
  send(phoneE164: string, code: string): Promise<void>;
}

export function otpMessage(code: string): string {
  return `Your code is ${code}`;
}

export interface MailpitOtpSenderOptions {
  /** Mailpit's HTTP API base, e.g. http://127.0.0.1:8025 (tools/docker-compose.yml). */
  baseUrl: string;
  fetch?: typeof fetch;
}

/**
 * Local development only: delivers the SMS text to the Mailpit inbox instead of a phone, so codes
 * never go to logs. The real SMS provider is pending its commercial terms (ADR-0006).
 */
export class MailpitOtpSender implements OtpSender {
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(options: MailpitOtpSenderOptions) {
    this.#url = new URL('/api/v1/send', options.baseUrl).toString();
    this.#fetch = options.fetch ?? fetch;
  }

  async send(phoneE164: string, code: string): Promise<void> {
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        From: { Email: 'sms@chronos.local', Name: 'SMS (local)' },
        To: [{ Email: 'sms@chronos.local' }],
        // The last two digits are enough to tell test sign-ins apart.
        Subject: `SMS to ${phoneHint(phoneE164)}`,
        Text: otpMessage(code),
      }),
    });
    if (!response.ok) throw new Error('local SMS delivery failed');
  }
}
