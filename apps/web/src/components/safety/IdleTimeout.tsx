'use client';

/**
 * Idle sign-out (ADR-0017, TASKS M1.9): after 15 minutes without activity in any of the member's
 * open tabs, this device is signed out (approved 2026-11-26). A warning comes one minute before,
 * with a button to stay signed in (WCAG 2.2.1: a timeout can be extended). Tabs share activity in
 * memory only; nothing is stored on the device. Public pages are skipped.
 */
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { isPublicPath } from '@/lib/public-paths';
import { sendSignOut } from '@/lib/sign-out';
import { openTabChannel, type TabChannel } from '@/lib/tab-channel';

export const IDLE_MS = 15 * 60 * 1000;
export const WARNING_MS = 60 * 1000;
/** Activity is shared with other tabs at most this often. */
const SHARE_EVERY_MS = 5_000;
const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;

export function IdleTimeout() {
  const pathname = usePathname();
  const active = !isPublicPath(pathname);
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const lastActivity = useRef(Date.now());
  const channel = useRef<TabChannel | undefined>(undefined);
  const [secondsLeft, setSecondsLeft] = useState<number | undefined>();

  useEffect(() => {
    if (!active) return undefined;
    lastActivity.current = Date.now();
    let lastShared = 0;
    let signingOut = false;

    const goToSignIn = () => {
      window.location.replace('/sign-in');
    };
    channel.current = openTabChannel((message) => {
      if (message.type === 'activity')
        lastActivity.current = Math.max(lastActivity.current, message.at);
      if (message.type === 'signed-out') goToSignIn();
    });
    const touched = () => {
      const now = Date.now();
      lastActivity.current = now;
      if (now - lastShared >= SHARE_EVERY_MS) {
        lastShared = now;
        channel.current?.post({ type: 'activity', at: now });
      }
    };
    for (const event of ACTIVITY)
      window.addEventListener(event, touched, { passive: true, capture: true });
    // Marks the page once the timer is running, so tests know when the clock starts.
    document.documentElement.dataset['idleTimeout'] = 'on';

    const tick = window.setInterval(() => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= IDLE_MS) {
        if (signingOut) return;
        signingOut = true;
        void sendSignOut().then(() => {
          channel.current?.post({ type: 'signed-out' });
          goToSignIn();
        });
      } else if (idle >= IDLE_MS - WARNING_MS) {
        setSecondsLeft(Math.ceil((IDLE_MS - idle) / 1000));
      } else {
        setSecondsLeft(undefined);
      }
    }, 1000);

    return () => {
      window.clearInterval(tick);
      delete document.documentElement.dataset['idleTimeout'];
      for (const event of ACTIVITY) window.removeEventListener(event, touched, { capture: true });
      channel.current?.close();
    };
  }, [active]);

  const warning = secondsLeft !== undefined;
  // Move focus to the way out of the warning as soon as it appears.
  useEffect(() => {
    if (warning) dialog.current?.querySelector('button')?.focus();
  }, [warning]);

  if (!active || !warning) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgb(0 0 0 / 0.5)' }}
    >
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-text`}
        className="w-full max-w-sm space-y-4 rounded-2xl p-6 shadow-xl"
        style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)' }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          Are you still there?
        </h2>
        <p id={`${id}-text`} style={{ color: 'var(--color-text-muted)' }}>
          For your privacy, you will be signed out in {String(secondsLeft)} seconds because you
          haven&apos;t used Chronos Place for a while.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() => {
              const now = Date.now();
              lastActivity.current = now;
              channel.current?.post({ type: 'activity', at: now });
              setSecondsLeft(undefined);
            }}
          >
            Stay signed in
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void sendSignOut().then(() => {
                channel.current?.post({ type: 'signed-out' });
                window.location.replace('/sign-in');
              });
            }}
          >
            Sign out now
          </Button>
        </div>
      </div>
    </div>
  );
}
