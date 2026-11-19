'use client';

import Link from 'next/link';
import { ThemeToggle } from './ThemeToggle.js';

export function TopNav() {
  return (
    <header
      className="sticky top-0 z-40 flex h-14 items-center justify-between border-b px-4"
      style={{
        backgroundColor: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
      role="banner"
    >
      <Link
        href="/feed"
        className="text-lg font-bold"
        style={{ color: 'var(--color-primary)' }}
        aria-label="Chronos Place — go to feed"
      >
        Chronos Place
      </Link>

      <nav aria-label="Quick actions">
        <ul className="flex items-center gap-2 list-none m-0 p-0">
          <li>
            <ThemeToggle />
          </li>
          <li>
            <Link
              href="/profile"
              className="touch-target inline-flex items-center justify-center rounded-full p-2 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              aria-label="Go to your profile"
            >
              {/* Profile icon */}
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
            </Link>
          </li>
        </ul>
      </nav>
    </header>
  );
}
