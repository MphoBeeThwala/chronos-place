/**
 * Sign-in page — OTP phone verification.
 * M1.1 (identity service) will wire the actual OTP mutations.
 * This shell shows the structure and consent notice; the form is a placeholder.
 */
import type { Metadata } from 'next';
import { SignInForm } from '@/components/auth/SignInForm';
import { Logo } from '@/components/brand/Logo';

export const metadata: Metadata = {
  title: 'Sign in',
};

export default function SignInPage() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center p-6"
      style={{ backgroundColor: 'var(--color-bg)' }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-8 shadow-lg"
        style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        <h1 className="mb-2">
          <Logo size={44} />
        </h1>
        <p className="mb-8 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          A space for people living with or beyond chronic health conditions.
        </p>

        <SignInForm />
      </div>
    </main>
  );
}
