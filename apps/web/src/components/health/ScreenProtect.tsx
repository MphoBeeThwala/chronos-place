'use client';

/**
 * ScreenProtect — web equivalent of Android FLAG_SECURE.
 *
 * On mobile browsers we cannot prevent screenshots, but we can:
 *   1. Apply CSS user-select: none to prevent text selection/copy.
 *   2. Listen for the visibilitychange event and blur content when the tab
 *      becomes hidden (reduces screenshot leakage on tab-switcher).
 *   3. Add a print stylesheet that replaces content with a warning.
 *   4. Set a data attribute so CSS can apply additional protections.
 *
 * This is a defence-in-depth measure, not a hard guarantee.
 * M2.8 will add server-side controls (no-cache headers, lease enforcement).
 */
import { useEffect, useRef } from 'react';

interface ScreenProtectProps {
  children: React.ReactNode;
}

export function ScreenProtect({ children }: ScreenProtectProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function handleVisibilityChange() {
      if (document.hidden && el) {
        el.setAttribute('data-screen-hidden', 'true');
      } else if (el) {
        el.removeAttribute('data-screen-hidden');
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return (
    <>
      {/* Print-only overlay that replaces health content on print/screenshot. */}
      <div
        aria-hidden="true"
        style={{
          display: 'none',
        }}
        className="health-print-warning"
      >
        This content is protected and cannot be printed.
      </div>

      <div
        ref={containerRef}
        data-screen-protect="true"
        style={{
          // Prevent text selection (reduces copy-paste leakage).
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        {/* Visible notice so the user knows the screen is protected. */}
        <div
          className="mb-4 rounded-lg px-4 py-2 text-sm flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
            backgroundColor: 'var(--color-indicator-bg)',
            color: 'var(--color-indicator)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>This screen is protected. Screenshots are not recommended.</span>
        </div>

        {children}
      </div>

      {/* Print stylesheet override. */}
      <style>{`
        @media print {
          [data-screen-protect="true"] { display: none !important; }
          .health-print-warning { display: block !important; font-size: 1rem; padding: 2rem; }
        }
        [data-screen-hidden="true"] [data-screen-protect="true"] > *:not([role="status"]) {
          filter: blur(8px);
          pointer-events: none;
        }
      `}</style>
    </>
  );
}
