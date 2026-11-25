'use client';

/**
 * Sign-in form: phone number, then one-time code (TASKS M1.3, ADR-0018).
 * Sessions live in httpOnly cookies set by the gateway; this form never sees a token.
 */
import { gql, useMutation } from '@apollo/client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { OPERATIONS } from '@/graphql/operations.generated';
import { messageOf } from '@/lib/graphql-errors';

type Step = 'phone' | 'otp';

const REQUEST_OTP = gql(OPERATIONS.RequestOtp.text);
const VERIFY_OTP = gql(OPERATIONS.VerifyOtp.text);

interface RequestOtpData {
  requestOtp: { challengeId: string; expiresAt: string; retryAfterSeconds: number };
}
interface VerifyOtpData {
  verifyOtp: { account: { id: string; status: string } };
}

export function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [requestOtp, { loading: sending }] = useMutation<RequestOtpData>(REQUEST_OTP);
  const [verifyOtp, { loading: verifying }] = useMutation<VerifyOtpData>(VERIFY_OTP);

  async function handlePhoneSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    try {
      const { data } = await requestOtp({ variables: { phone } });
      if (!data) throw new Error('no data');
      setChallengeId(data.requestOtp.challengeId);
      setCode('');
      setStep('otp');
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function handleOtpSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    try {
      const { data } = await verifyOtp({ variables: { challengeId, code } });
      if (!data) throw new Error('no data');
      // A new member finishes signing up first (consents, then date of birth).
      router.push(data.verifyOtp.account.status === 'ACTIVE' ? '/feed' : '/onboarding');
    } catch (err) {
      setError(messageOf(err));
    }
  }

  const alert = error ? (
    <p
      role="alert"
      className="mb-5 rounded-lg px-4 py-3 text-sm"
      style={{
        backgroundColor: 'var(--color-bg-muted)',
        color: 'var(--color-danger, var(--color-text))',
      }}
    >
      {error}
    </p>
  ) : null;

  if (step === 'phone') {
    return (
      <form
        onSubmit={(e) => {
          void handlePhoneSubmit(e);
        }}
        noValidate
      >
        {alert}
        <div className="mb-5">
          <label
            htmlFor="phone"
            className="block text-sm font-medium mb-1.5"
            style={{ color: 'var(--color-text)' }}
          >
            Phone number
          </label>
          <input
            id="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            required
            placeholder="082 000 0000"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
            }}
            className="w-full rounded-lg border px-4 py-3 text-base transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1"
            style={{
              backgroundColor: 'var(--color-bg-muted)',
              borderColor: 'var(--color-border-strong)',
              color: 'var(--color-text)',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CSS custom props in style
              ['--tw-ring-color' as any]: 'var(--color-primary)',
            }}
            aria-required="true"
            aria-describedby="phone-hint"
          />
          <p
            id="phone-hint"
            className="mt-1.5 text-xs"
            style={{ color: 'var(--color-text-subtle)' }}
          >
            South African mobile numbers only for now. We&apos;ll send a one-time code.
          </p>
        </div>

        <Button type="submit" fullWidth isLoading={sending} disabled={sending}>
          Send code
        </Button>

        <p className="mt-5 text-xs text-center" style={{ color: 'var(--color-text-subtle)' }}>
          By continuing, you agree to our{' '}
          <a href="/terms" className="underline" style={{ color: 'var(--color-primary)' }}>
            Terms
          </a>{' '}
          and{' '}
          <a href="/privacy" className="underline" style={{ color: 'var(--color-primary)' }}>
            Privacy Policy
          </a>
          . You must be 18 or older.
        </p>
      </form>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        void handleOtpSubmit(e);
      }}
      noValidate
    >
      {alert}
      <button
        type="button"
        onClick={() => {
          setError(undefined);
          setStep('phone');
        }}
        className="mb-5 flex items-center gap-1 text-sm"
        style={{ color: 'var(--color-text-muted)' }}
        aria-label="Back to phone number entry"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M19 12H5M12 5l-7 7 7 7" />
        </svg>
        Back
      </button>

      <p className="mb-5 text-sm" style={{ color: 'var(--color-text-muted)' }}>
        We sent a 6-digit code to <strong style={{ color: 'var(--color-text)' }}>{phone}</strong>.
      </p>

      <div className="mb-5">
        <label
          htmlFor="otp"
          className="block text-sm font-medium mb-1.5"
          style={{ color: 'var(--color-text)' }}
        >
          One-time code
        </label>
        <input
          id="otp"
          type="text"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          placeholder="123456"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
          }}
          className="w-full rounded-lg border px-4 py-3 text-base text-center tracking-[0.5em] transition-colors focus:outline-none"
          style={{
            backgroundColor: 'var(--color-bg-muted)',
            borderColor: 'var(--color-border-strong)',
            color: 'var(--color-text)',
          }}
          aria-required="true"
          aria-describedby="otp-hint"
        />
        <p id="otp-hint" className="mt-1.5 text-xs" style={{ color: 'var(--color-text-subtle)' }}>
          The code expires in 5 minutes.
        </p>
      </div>

      <Button
        type="submit"
        fullWidth
        isLoading={verifying}
        disabled={verifying || code.length !== 6}
      >
        Verify
      </Button>
    </form>
  );
}
