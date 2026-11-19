import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center"
      style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text)' }}
    >
      <h1 className="text-4xl font-bold" style={{ color: 'var(--color-primary)' }}>
        404
      </h1>
      <p className="text-lg" style={{ color: 'var(--color-text-muted)' }}>
        Page not found.
      </p>
      <Link
        href="/"
        className="touch-target inline-flex items-center justify-center rounded-lg px-5 py-2 font-semibold transition-colors"
        style={{
          backgroundColor: 'var(--color-primary)',
          color: 'var(--color-text-on-brand)',
        }}
      >
        Go home
      </Link>
    </main>
  );
}
