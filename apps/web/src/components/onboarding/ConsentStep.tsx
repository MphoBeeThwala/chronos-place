'use client';

/**
 * Step 1 (ADR-0020): terms and privacy, each its own choice. Updates and news are optional and
 * off. Health processing is not asked here; it comes right before the first health question.
 */
import Link from 'next/link';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { isDraftVersion } from '@/lib/onboarding';

export interface ConsentChoice {
  type: 'TERMS' | 'PRIVACY' | 'MARKETING';
  policyVersion: string;
}

interface Props {
  versions: Partial<Record<string, string>>;
  busy: boolean;
  onAccept: (choices: ConsentChoice[]) => void;
}

function Choice({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        className="mt-1 h-6 w-6 shrink-0"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
      <label htmlFor={id}>{children}</label>
    </div>
  );
}

export function ConsentStep({ versions, busy, onAccept }: Props) {
  const id = useId();
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const muted = { color: 'var(--color-text-muted)' };
  const link = 'underline';
  // Not offered while its text is still a draft awaiting counsel.
  const offerMarketing = !isDraftVersion(versions['MARKETING']);
  const termsVersion = versions['TERMS'];
  const privacyVersion = versions['PRIVACY'];

  const submit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!terms || !privacy || !termsVersion || !privacyVersion) return;
    const choices: ConsentChoice[] = [
      { type: 'TERMS', policyVersion: termsVersion },
      { type: 'PRIVACY', policyVersion: privacyVersion },
    ];
    const marketingVersion = versions['MARKETING'];
    if (offerMarketing && marketing && marketingVersion) {
      choices.push({ type: 'MARKETING', policyVersion: marketingVersion });
    }
    onAccept(choices);
  };

  return (
    <form onSubmit={submit} className="space-y-5" aria-describedby={`${id}-intro`}>
      <p id={`${id}-intro`} style={muted}>
        Chronos Place is a space for people living with or beyond chronic health conditions. Your
        health information is yours: you decide who sees it and when. We never ask about your health
        during sign-up.
      </p>
      <fieldset className="space-y-4">
        <legend className="mb-2 font-semibold">To continue, please agree to both</legend>
        <Choice id={`${id}-terms`} checked={terms} onChange={setTerms}>
          I agree to the{' '}
          <Link href="/terms" className={link} target="_blank">
            Terms of Service (opens in a new tab)
          </Link>
          .
        </Choice>
        <Choice id={`${id}-privacy`} checked={privacy} onChange={setPrivacy}>
          I have read the{' '}
          <Link href="/privacy" className={link} target="_blank">
            Privacy Policy (opens in a new tab)
          </Link>{' '}
          and agree to Chronos Place using my information as it describes.
        </Choice>
      </fieldset>
      {offerMarketing && (
        <fieldset className="space-y-2">
          <legend className="mb-2 font-semibold">Optional</legend>
          <Choice id={`${id}-marketing`} checked={marketing} onChange={setMarketing}>
            Send me occasional product updates and community news. I can stop them at any time.
          </Choice>
        </fieldset>
      )}
      <Button type="submit" disabled={!terms || !privacy} isLoading={busy} fullWidth>
        Agree and continue
      </Button>
    </form>
  );
}
