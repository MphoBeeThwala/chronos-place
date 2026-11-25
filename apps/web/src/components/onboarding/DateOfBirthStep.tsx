'use client';

/**
 * Step 2 (ADR-0018): date of birth, in three labelled boxes (easier with screen readers and
 * keyboards than a date picker). It cannot be changed later and under 18 closes the account, so
 * the member confirms it first.
 */
import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { parseDateOfBirth } from '@/lib/onboarding';

interface Props {
  busy: boolean;
  onConfirm: (iso: string) => void;
}

const LONG_DATE = new Intl.DateTimeFormat('en-ZA', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

export function DateOfBirthStep({ busy, onConfirm }: Props) {
  const id = useId();
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState<string | undefined>();
  const muted = { color: 'var(--color-text-muted)' };
  const box =
    'h-11 rounded-lg border px-3 text-base bg-[var(--color-surface)] border-[var(--color-border-strong)]';

  if (pending) {
    return (
      <div className="space-y-5">
        <p>
          You entered <strong>{LONG_DATE.format(new Date(`${pending}T00:00:00Z`))}</strong>.
        </p>
        <p style={muted}>
          Please check it. Your date of birth cannot be changed later, and Chronos Place is only for
          people aged 18 or older.
        </p>
        <Button
          isLoading={busy}
          fullWidth
          onClick={() => {
            onConfirm(pending);
          }}
        >
          Yes, that&apos;s right
        </Button>
        <Button
          variant="secondary"
          fullWidth
          disabled={busy}
          onClick={() => {
            setPending(undefined);
          }}
        >
          Change it
        </Button>
      </div>
    );
  }

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    width: string,
    max: number,
    autoComplete: string,
  ) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-${label}`} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={`${id}-${label}`}
        className={`${box} ${width}`}
        inputMode="numeric"
        autoComplete={autoComplete}
        maxLength={max}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        onChange={(e) => {
          set(e.target.value);
        }}
      />
    </div>
  );

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        const result = parseDateOfBirth(day, month, year);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setError(undefined);
        setPending(result.iso);
      }}
    >
      <fieldset>
        <legend className="mb-1 font-semibold">What is your date of birth?</legend>
        <p id={`${id}-hint`} className="mb-3 text-sm" style={muted}>
          For example, 27 3 1990. Other members see only your age.
        </p>
        {error && (
          <p id={`${id}-error`} role="alert" className="mb-3 text-sm font-medium">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          {field('Day', day, setDay, 'w-16', 2, 'bday-day')}
          {field('Month', month, setMonth, 'w-16', 2, 'bday-month')}
          {field('Year', year, setYear, 'w-24', 4, 'bday-year')}
        </div>
      </fieldset>
      <Button type="submit" fullWidth>
        Continue
      </Button>
    </form>
  );
}
