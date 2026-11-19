'use client';

import { useEffect } from 'react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Log to Sentry (self-hosted, server-side) in production.
    // Client-side error boundary — no health data should ever reach here
    // but we log conservatively: no message, no stack.
    if (process.env['NODE_ENV'] === 'production') {
      // TODO(M5): capture to self-hosted Sentry with PII scrubbing.
      void Promise.resolve(error.digest);
    }
  }, [error]);

  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center"
      style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text)' }}
    >
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p style={{ color: 'var(--color-text-muted)' }}>
        An unexpected error occurred. Please try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="touch-target inline-flex items-center justify-center rounded-lg px-5 py-2 font-semibold transition-colors"
        style={{
          backgroundColor: 'var(--color-primary)',
          color: 'var(--color-text-on-brand)',
        }}
      >
        Try again
      </button>
    </main>
  );
}
