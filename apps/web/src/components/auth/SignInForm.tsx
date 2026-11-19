'use client';

/**
 * Sign-in form — OTP phone verification.
 * M1.1 will wire the actual requestOtp / verifyOtp GraphQL mutations.
 * This is the accessible form shell with correct ARIA structure.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/Button.js';

type Step = 'phone' | 'otp';

export function SignInForm() {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');

  function handlePhoneSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // TODO(M1.1): call requestOtp mutation.
    setStep('otp');
  }

  function handleOtpSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // TODO(M1.1): call verifyOtp mutation, set session cookie, redirect.
  }

  if (step === 'phone') {
    return (
      <form onSubmit={handlePhoneSubmit} noValidate>
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
            placeholder="+27 81 234 5678"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
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
          <p id="phone-hint" className="mt-1.5 text-xs" style={{ color: 'var(--color-text-subtle)' }}>
            We&apos;ll send a one-time code. Standard rates may apply.
          </p>
        </div>

        <Button type="submit" fullWidth>
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
    <form onSubmit={handleOtpSubmit} noValidate>
      <button
        type="button"
        onClick={() => setStep('phone')}
        className="mb-5 flex items-center gap-1 text-sm"
        style={{ color: 'var(--color-text-muted)' }}
        aria-label="Back to phone number entry"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
          The code expires in 10 minutes.
        </p>
      </div>

      <Button type="submit" fullWidth>
        Verify
      </Button>
    </form>
  );
}
