'use client';

/**
 * Finishing sign-up (TASKS M1.7). The step comes from the server's state, so a member who leaves
 * halfway returns to the same step. Each step's heading takes focus when it appears, so screen
 * reader users hear where they are.
 */
import { gql, useMutation, useQuery } from '@apollo/client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { OPERATIONS } from '@/graphql/operations.generated';
import { messageOf } from '@/lib/graphql-errors';
import { type AccountStatus, type OnboardingState, onboardingStep } from '@/lib/onboarding';
import { type ConsentChoice, ConsentStep } from './ConsentStep';
import { DateOfBirthStep } from './DateOfBirthStep';

const STATE = gql(OPERATIONS.OnboardingState.text);
const RECORD_CONSENT = gql(OPERATIONS.RecordConsent.text);
const SET_DATE_OF_BIRTH = gql(OPERATIONS.SetDateOfBirth.text);
const SIGN_OUT = gql(OPERATIONS.SignOut.text);

const TITLES = {
  consent: { step: 'Step 1 of 2', title: 'Before we begin' },
  dateOfBirth: { step: 'Step 2 of 2', title: 'Your date of birth' },
  ineligible: { step: undefined, title: 'Chronos Place is for adults' },
  closed: { step: undefined, title: 'This account is closed' },
  active: { step: undefined, title: 'You’re all set' },
} as const;

export function Onboarding() {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const [error, setError] = useState<string | undefined>();
  // Under 18 ends the session, so the answer is kept here rather than asked for again.
  const [finalStatus, setFinalStatus] = useState<AccountStatus | undefined>();
  const state = useQuery<OnboardingState>(STATE, { fetchPolicy: 'network-only' });
  const [recordConsent, { loading: recording }] = useMutation(RECORD_CONSENT);
  const [setDateOfBirth, { loading: saving }] = useMutation<{
    setDateOfBirth: { id: string; status: AccountStatus };
  }>(SET_DATE_OF_BIRTH);
  const [signOut] = useMutation(SIGN_OUT);

  const step =
    finalStatus === 'INELIGIBLE'
      ? 'ineligible'
      : state.data
        ? onboardingStep(state.data)
        : undefined;

  useEffect(() => {
    if (step === 'active') router.replace('/feed');
    else if (step) heading.current?.focus();
  }, [step, router]);

  if (state.error && !step) {
    return (
      <p role="alert">
        {messageOf(state.error)}{' '}
        <Button variant="secondary" onClick={() => void state.refetch()}>
          Try again
        </Button>
      </p>
    );
  }
  if (!step) return <p aria-live="polite">Loading…</p>;

  const accept = async (choices: ConsentChoice[]) => {
    setError(undefined);
    try {
      for (const input of choices) {
        await recordConsent({ variables: { input: { ...input, granted: true } } });
      }
      await state.refetch();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const confirmDateOfBirth = async (iso: string) => {
    setError(undefined);
    try {
      const { data } = await setDateOfBirth({ variables: { dateOfBirth: iso } });
      const status = data?.setDateOfBirth.status;
      if (status === 'INELIGIBLE') setFinalStatus(status);
      else await state.refetch();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const versions = Object.fromEntries(
    (state.data?.currentPolicies ?? []).map((p) => [p.type, p.version]),
  );
  const { step: progress, title } = TITLES[step];
  const muted = { color: 'var(--color-text-muted)' };

  return (
    <section aria-labelledby="onboarding-title" className="space-y-6">
      <header>
        {progress && (
          <p className="text-sm" style={muted}>
            {progress}
          </p>
        )}
        <h1
          id="onboarding-title"
          ref={heading}
          tabIndex={-1}
          className="text-2xl font-semibold focus:outline-none"
          style={{ color: 'var(--color-text)' }}
        >
          {title}
        </h1>
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-lg px-4 py-3 text-sm"
          style={{ backgroundColor: 'var(--color-bg-muted)' }}
        >
          {error}
        </p>
      )}

      {step === 'consent' && (
        <ConsentStep
          versions={versions}
          busy={recording}
          onAccept={(choices) => void accept(choices)}
        />
      )}
      {step === 'dateOfBirth' && (
        <DateOfBirthStep busy={saving} onConfirm={(iso) => void confirmDateOfBirth(iso)} />
      )}
      {step === 'ineligible' && (
        <p style={muted}>
          You need to be 18 or older to use Chronos Place, so we can&apos;t open an account for you.
          We have signed you out and did not keep your date of birth. Your phone number can no
          longer be read; we keep only a one-way code that stops it being used to sign up again.
        </p>
      )}
      {step === 'closed' && (
        <p style={muted}>
          This account has been closed or is being deleted, so it can&apos;t be used any more.
        </p>
      )}

      {(step === 'consent' || step === 'dateOfBirth' || step === 'closed') && (
        <Button
          variant="ghost"
          fullWidth
          onClick={() => {
            void signOut()
              .catch(() => undefined)
              .then(() => {
                router.replace('/sign-in');
              });
          }}
        >
          Sign out
        </Button>
      )}
    </section>
  );
}
