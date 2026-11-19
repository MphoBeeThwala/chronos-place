'use client';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// Error reporting to self-hosted Sentry (with scrubbing) arrives in M5. The error itself is not
// used or logged here: error text can echo input, and the browser console is not a safe sink.
export default function GlobalError({ reset }: ErrorProps) {
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
