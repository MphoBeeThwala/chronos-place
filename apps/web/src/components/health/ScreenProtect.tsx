'use client';

/**
 * Screen protection for health screens (ADR-0017, TASKS M2.8): the web stand-in for Android
 * FLAG_SECURE and the iOS app-switcher blur. Browsers cannot block screenshots, so the page says
 * so plainly. It blurs while the tab is hidden, and printing shows a placeholder, never the content
 * (styles in globals.css). Text selection is off to discourage copying.
 */
import { useEffect, useRef } from 'react';

export const SCREENSHOT_NOTICE =
  "Your browser can't stop screenshots, so anyone who can see this page could capture it. We blur it when you switch tabs, and printing shows a blank placeholder.";

export function ScreenProtect({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const el = containerRef.current;
      if (!el) return;
      if (document.hidden) el.setAttribute('data-screen-hidden', 'true');
      else el.removeAttribute('data-screen-hidden');
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return (
    <>
      {/* Printed instead of the page. */}
      <div aria-hidden="true" className="screen-protect-print">
        Chronos Place
      </div>
      <div ref={containerRef} data-screen-protect="true">
        <p
          className="mb-4 rounded-lg px-4 py-2 text-sm"
          style={{ backgroundColor: 'var(--color-indicator-bg)', color: 'var(--color-indicator)' }}
        >
          {SCREENSHOT_NOTICE}
        </p>
        {children}
      </div>
    </>
  );
}
