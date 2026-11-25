'use client';

/**
 * Step 3 (TASKS M1.7, PRD "health disclosure and consent"): how health privacy works, before
 * anything about health is ever asked. Three short screens; the health screens (M2) show it
 * again before the first health question.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';

interface Screen {
  title: string;
  body: React.ReactNode;
}

const SCREENS: Screen[] = [
  {
    title: 'Your health information stays hidden',
    body: (
      <>
        <p>
          Nothing about your health is shown to anyone unless you choose. You can use Chronos Place
          without ever adding any.
        </p>
        <p>
          If you do add it, we keep it apart from the rest of your profile, locked with a key that
          belongs to you alone. It never appears in notifications, emails or text messages.
        </p>
      </>
    ),
  },
  {
    title: 'You choose who sees it',
    body: (
      <>
        <p>For your health details, you pick one of these, and can change it at any time:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <strong>Nobody.</strong> This is where everyone starts.
          </li>
          <li>
            <strong>People you match with.</strong>
          </li>
          <li>
            <strong>One person you choose,</strong> in a chat.
          </li>
          <li>
            <strong>Anyone who views your profile.</strong>
          </li>
        </ul>
        <p>Taking access away works straight away.</p>
      </>
    ),
  },
  {
    title: 'You stay in control',
    body: (
      <>
        <p>
          You can see who has viewed your health details, and when. You can delete them at any time,
          and deleting your account deletes everything.
        </p>
        <p>
          One thing we cannot stop: someone could photograph their screen. Our rules forbid sharing
          another member&apos;s health information, and you can report it to us as urgent.
        </p>
      </>
    ),
  },
];

export function PrivacyWalkthrough({ onDone }: { onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  // The screen last given focus; React runs effects twice in development, so compare indexes.
  const shown = useRef(0);
  const screen = SCREENS[index] ?? SCREENS[0];
  const last = index === SCREENS.length - 1;

  // Moving between screens puts focus on the new heading (not on first show: the step heading
  // above already has it).
  useEffect(() => {
    if (shown.current === index) return;
    shown.current = index;
    heading.current?.focus();
  }, [index]);

  if (!screen) return null;
  return (
    <section aria-labelledby="walkthrough-title" className="space-y-5">
      <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        {String(index + 1)} of {String(SCREENS.length)}
      </p>
      <h2
        id="walkthrough-title"
        ref={heading}
        tabIndex={-1}
        className="text-xl font-semibold focus:outline-none"
      >
        {screen.title}
      </h2>
      <div className="space-y-3">{screen.body}</div>
      <div className="flex gap-3">
        {index > 0 && (
          <Button
            variant="secondary"
            onClick={() => {
              setIndex(index - 1);
            }}
          >
            Back
          </Button>
        )}
        <Button
          fullWidth
          onClick={() => {
            if (last) onDone();
            else setIndex(index + 1);
          }}
        >
          {last ? 'Got it, continue' : 'Next'}
        </Button>
      </div>
    </section>
  );
}
