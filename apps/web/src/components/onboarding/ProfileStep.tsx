'use client';

/**
 * Step 4 (TASKS M1.7, ADR-0023): the first profile save. A display name and what the member is
 * looking for are required; everything else is optional. Location is optional and is rounded
 * to about 1 km in the browser before it is sent.
 */
import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  blurCoordinate,
  INTENTS,
  type Intent,
  PROFILE_LIMITS,
  visibleLength,
} from '@/lib/onboarding';

export interface ProfileDraft {
  displayName: string;
  intent: Intent;
  bio?: string;
  pronouns?: string;
  gender?: string;
  areaLabel?: string;
  location?: { latitude: number; longitude: number };
}

type Field = 'displayName' | 'bio' | 'pronouns' | 'gender' | 'areaLabel';
type LocationState =
  | { kind: 'off' }
  | { kind: 'asking' }
  | { kind: 'on'; latitude: number; longitude: number }
  | { kind: 'failed' };

const box =
  'w-full rounded-lg border px-3 py-2 text-base bg-[var(--color-surface)] border-[var(--color-border-strong)]';

export function ProfileStep({
  busy,
  onSave,
}: {
  busy: boolean;
  onSave: (draft: ProfileDraft) => void;
}) {
  const id = useId();
  const [values, setValues] = useState<Record<Field, string>>({
    displayName: '',
    bio: '',
    pronouns: '',
    gender: '',
    areaLabel: '',
  });
  const [intent, setIntent] = useState<Intent | undefined>();
  const [errors, setErrors] = useState<Partial<Record<Field | 'intent', string>>>({});
  const [location, setLocation] = useState<LocationState>({ kind: 'off' });
  const muted = { color: 'var(--color-text-muted)' };

  const set = (field: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValues({ ...values, [field]: e.target.value });
  };

  const shareLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocation({ kind: 'failed' });
      return;
    }
    setLocation({ kind: 'asking' });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          kind: 'on',
          latitude: blurCoordinate(position.coords.latitude),
          longitude: blurCoordinate(position.coords.longitude),
        });
      },
      () => {
        setLocation({ kind: 'failed' });
      },
      // Coarse is enough: it is rounded to about 1 km anyway.
      { enableHighAccuracy: false, maximumAge: 10 * 60 * 1000, timeout: 15_000 },
    );
  };

  const submit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const found: typeof errors = {};
    const name = values.displayName.trim();
    if (!name) found.displayName = 'Enter the name you want others to see.';
    if (!intent) found.intent = 'Choose what you are looking for.';
    for (const field of Object.keys(PROFILE_LIMITS) as Field[]) {
      if (visibleLength(values[field].trim()) > PROFILE_LIMITS[field]) {
        found[field] = `Keep this to ${String(PROFILE_LIMITS[field])} characters or fewer.`;
      }
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !intent) return;
    const optional = (field: Field) => {
      const v = values[field].trim();
      return v ? { [field]: v } : {};
    };
    onSave({
      displayName: name,
      intent,
      ...optional('bio'),
      ...optional('pronouns'),
      ...optional('gender'),
      ...optional('areaLabel'),
      ...(location.kind === 'on'
        ? { location: { latitude: location.latitude, longitude: location.longitude } }
        : {}),
    });
  };

  const described = (field: Field | 'intent', hint?: string) =>
    [errors[field] ? `${id}-${field}-error` : undefined, hint].filter(Boolean).join(' ') ||
    undefined;
  const error = (field: Field | 'intent') =>
    errors[field] && (
      <p id={`${id}-${field}-error`} role="alert" className="text-sm font-medium">
        {errors[field]}
      </p>
    );
  const text = (field: Field, label: string, opts: { optional?: boolean; hint?: string } = {}) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-${field}`} className="font-medium">
        {label}
        {opts.optional && (
          <span className="font-normal" style={muted}>
            {' '}
            (optional)
          </span>
        )}
      </label>
      {opts.hint && (
        <p id={`${id}-${field}-hint`} className="text-sm" style={muted}>
          {opts.hint}
        </p>
      )}
      {error(field)}
      {field === 'bio' ? (
        <textarea
          id={`${id}-${field}`}
          className={`${box} min-h-28`}
          value={values[field]}
          onChange={set(field)}
          aria-invalid={errors[field] ? true : undefined}
          aria-describedby={described(field, opts.hint ? `${id}-${field}-hint` : undefined)}
        />
      ) : (
        <input
          id={`${id}-${field}`}
          className={`${box} h-11`}
          value={values[field]}
          onChange={set(field)}
          autoComplete={field === 'displayName' ? 'given-name' : 'off'}
          aria-invalid={errors[field] ? true : undefined}
          aria-describedby={described(field, opts.hint ? `${id}-${field}-hint` : undefined)}
        />
      )}
    </div>
  );

  return (
    <form noValidate onSubmit={submit} className="space-y-6">
      <p style={muted}>
        This is what other members see. You can change any of it later. Health details are not part
        of your profile: they have their own private section.
      </p>

      {text('displayName', 'Your name', { hint: 'A first name or nickname is fine.' })}

      <fieldset aria-describedby={described('intent')} className="space-y-2">
        <legend className="mb-1 font-medium">What are you looking for?</legend>
        {error('intent')}
        {INTENTS.map((option) => (
          <div key={option.value} className="flex items-center gap-3">
            <input
              type="radio"
              id={`${id}-intent-${option.value}`}
              name={`${id}-intent`}
              className="h-5 w-5"
              checked={intent === option.value}
              onChange={() => {
                setIntent(option.value);
              }}
            />
            <label htmlFor={`${id}-intent-${option.value}`} className="py-2">
              {option.label}
            </label>
          </div>
        ))}
      </fieldset>

      {text('bio', 'About you', {
        optional: true,
        hint: 'Everyone who sees your profile can read this, so keep health details for your private section.',
      })}
      {text('pronouns', 'Pronouns', { optional: true })}
      {text('gender', 'Gender', { optional: true })}
      {text('areaLabel', 'Your area', {
        optional: true,
        hint: 'A suburb or town, as you would like it shown.',
      })}

      <div className="space-y-2">
        <p className="font-medium">
          Distance{' '}
          <span className="font-normal" style={muted}>
            (optional)
          </span>
        </p>
        <p className="text-sm" style={muted}>
          Let others see roughly how far away you are, never closer than 1 km. We never show your
          location itself.
        </p>
        <div aria-live="polite">
          {location.kind === 'on' ? (
            <p className="text-sm font-medium">Your approximate distance will be shown.</p>
          ) : location.kind === 'failed' ? (
            <p className="text-sm font-medium">
              We could not get your location. You can turn it on later in your profile.
            </p>
          ) : null}
        </div>
        {location.kind === 'on' ? (
          <Button
            variant="secondary"
            onClick={() => {
              setLocation({ kind: 'off' });
            }}
          >
            Don&apos;t show my distance
          </Button>
        ) : (
          <Button
            variant="secondary"
            isLoading={location.kind === 'asking'}
            onClick={shareLocation}
          >
            Show my approximate distance
          </Button>
        )}
      </div>

      <Button type="submit" isLoading={busy} fullWidth>
        Save and continue
      </Button>
    </form>
  );
}
