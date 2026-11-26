'use client';

/**
 * Quick exit (ADR-0017, TASKS M1.9): a button on every screen, or Escape pressed twice, leaves for
 * Google at once. The current history entry is replaced, so Back does not return here. It also
 * signs this device out (approved 2026-11-26), sent as the page leaves so the exit never waits,
 * and every other open tab of the app leaves too.
 */
import { useEffect, useRef } from 'react';
import { sendSignOut } from '@/lib/sign-out';
import { openTabChannel, type TabChannel } from '@/lib/tab-channel';

export const QUICK_EXIT_URL = 'https://www.google.com/';
/** Two presses of Escape within this window. */
export const DOUBLE_ESCAPE_MS = 800;

function leave(channel: TabChannel | undefined, signOut: boolean) {
  if (signOut) void sendSignOut({ keepalive: true });
  channel?.post({ type: 'quick-exit' });
  window.location.replace(QUICK_EXIT_URL);
}

export function QuickExit() {
  const channel = useRef<TabChannel | undefined>(undefined);

  useEffect(() => {
    // Another tab already signed out; this one only needs to go.
    channel.current = openTabChannel((message) => {
      if (message.type === 'quick-exit') leave(undefined, false);
    });
    let lastEscape = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const now = Date.now();
      if (now - lastEscape <= DOUBLE_ESCAPE_MS) leave(channel.current, true);
      lastEscape = now;
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      channel.current?.close();
    };
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          leave(channel.current, true);
        }}
        aria-keyshortcuts="Escape Escape"
        aria-describedby="quick-exit-hint"
        className="fixed bottom-24 right-4 z-[70] min-h-[44px] min-w-[44px] rounded-full px-4 text-sm font-semibold shadow-lg"
        style={{
          backgroundColor: 'var(--color-surface)',
          color: 'var(--color-text)',
          border: '2px solid var(--color-border-strong)',
        }}
      >
        Quick exit
      </button>
      <span id="quick-exit-hint" className="sr-only">
        Leaves at once and signs you out. You can also press Escape twice.
      </span>
    </>
  );
}
