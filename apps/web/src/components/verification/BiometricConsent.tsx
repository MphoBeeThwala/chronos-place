'use client';

/**
 * The separate consent asked right before the camera opens (ADR-0022, decision 10).
 * DRAFT text: see docs/legal/biometric-verification-consent-draft.md. Counsel must approve it
 * before a real vendor can run.
 */
import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';

export function BiometricConsent({ onAgree, busy }: { onAgree: () => void; busy: boolean }) {
  const [checked, setChecked] = useState(false);
  const checkboxId = useId();
  const muted = { color: 'var(--color-text-muted)' };

  return (
    <section aria-labelledby={`${checkboxId}-title`} className="space-y-4">
      <h2 id={`${checkboxId}-title`} className="text-lg font-semibold">
        Before you take a selfie
      </h2>
      <p style={muted}>
        We ask every member to take a short selfie check. It shows other members you are a real
        person, and you need it before you can send messages. You can still use the rest of Chronos
        Place without it.
      </p>
      <ul className="list-disc space-y-2 pl-5" style={muted}>
        <li>
          <strong>What we take:</strong> a selfie and a few photos from a short video, taken with
          your camera. We do not ask for an ID document.
        </li>
        <li>
          <strong>Who checks it:</strong> our verification provider, Smile ID, checks the photos for
          us. They receive only the photos and a random code. They do not receive your name, phone
          number or anything about your health.
        </li>
        <li>
          <strong>How long we keep it:</strong> we keep the photos locked (encrypted) for up to 30
          days, so a person can review them if the automatic check does not work for you. Then we
          delete them and ask Smile ID to delete their copy. We keep only whether the check passed.
        </li>
        <li>
          <strong>Your choice:</strong> you can withdraw this consent at any time. We then delete
          the photos straight away, ask Smile ID to delete their copy and remove your verified
          badge.
        </li>
      </ul>
      <div className="flex items-start gap-3">
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-1 h-6 w-6"
          checked={checked}
          onChange={(e) => {
            setChecked(e.target.checked);
          }}
        />
        <label htmlFor={checkboxId}>I agree to the selfie check as described above.</label>
      </div>
      <Button disabled={!checked} isLoading={busy} onClick={onAgree} fullWidth>
        Continue
      </Button>
    </section>
  );
}
