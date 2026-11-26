'use client';

/**
 * Your data and account (TASKS M1.8, ADR-0025): download everything we hold, or delete the
 * account. Deletion needs a fresh code to the member's own number and cannot be undone.
 * Open to members who have not finished onboarding too: their rights don't wait.
 */
import { gql, useApolloClient, useMutation } from '@apollo/client';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { OPERATIONS } from '@/graphql/operations.generated';
import { messageOf } from '@/lib/graphql-errors';

const EXPORT = gql(OPERATIONS.MyDataExport.text);
const REQUEST_CODE = gql(OPERATIONS.RequestAccountDeletionCode.text);
const DELETE = gql(OPERATIONS.DeleteAccount.text);

/** The download's file name: no name or number in it, just the date. */
export function exportFileName(generatedAt: string): string {
  return `chronos-place-my-data-${generatedAt.slice(0, 10)}.json`;
}

type Step = 'idle' | 'confirm' | 'code';

export function YourData() {
  const client = useApolloClient();
  const router = useRouter();
  const id = useId();
  const codeInput = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState('');
  const [downloadError, setDownloadError] = useState<string | undefined>();
  const [step, setStep] = useState<Step>('idle');
  const [challengeId, setChallengeId] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [requestCode, { loading: sending }] = useMutation<{
    requestAccountDeletionCode: { challengeId: string };
  }>(REQUEST_CODE);
  const [deleteAccount, { loading: deleting }] = useMutation(DELETE);
  const muted = { color: 'var(--color-text-muted)' };

  const download = async () => {
    setDownloadError(undefined);
    setDownloadStatus('');
    setDownloading(true);
    try {
      // Never cached in the browser: the file holds the member's number and date of birth.
      const { data } = await client.query<{
        myDataExport: { generatedAt: string; json: string };
      }>({ query: EXPORT, fetchPolicy: 'no-cache' });
      const blob = new Blob([data.myDataExport.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(data.myDataExport.generatedAt);
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDownloadStatus('Your file has downloaded. Keep it somewhere safe: it holds your number.');
    } catch (err) {
      setDownloadError(messageOf(err));
    } finally {
      setDownloading(false);
    }
  };

  const sendCode = async () => {
    setDeleteError(undefined);
    try {
      const { data } = await requestCode();
      if (!data) return;
      setChallengeId(data.requestAccountDeletionCode.challengeId);
      setCode('');
      setStep('code');
      // After the code field renders.
      setTimeout(() => codeInput.current?.focus(), 0);
    } catch (err) {
      setDeleteError(messageOf(err));
    }
  };

  const confirmDelete = async () => {
    if (!challengeId) return;
    setDeleteError(undefined);
    try {
      await deleteAccount({ variables: { challengeId, code } });
      await client.clearStore();
      router.replace('/account-deleted');
    } catch (err) {
      setDeleteError(messageOf(err));
    }
  };

  const cancel = () => {
    setStep('idle');
    setChallengeId(undefined);
    setCode('');
    setDeleteError(undefined);
  };

  return (
    <div className="space-y-10">
      <section aria-labelledby={`${id}-download`} className="space-y-3">
        <h2 id={`${id}-download`} className="text-lg font-semibold">
          Download my data
        </h2>
        <p style={muted}>
          Get a copy of everything we hold about you: your number, date of birth, consents,
          sign-ins, profile, preferences, approximate location and photos. It comes as one file you
          can open in any text editor. Photo links in it work for 24 hours.
        </p>
        <Button
          variant="secondary"
          isLoading={downloading}
          disabled={downloading}
          onClick={() => void download()}
        >
          Download my data
        </Button>
        <p aria-live="polite" className="text-sm">
          {downloadStatus}
        </p>
        {downloadError && (
          <p role="alert" className="rounded-lg px-4 py-3 text-sm" style={alertStyle}>
            {downloadError}
          </p>
        )}
      </section>

      <section aria-labelledby={`${id}-delete`} className="space-y-3">
        <h2 id={`${id}-delete`} className="text-lg font-semibold">
          Delete my account
        </h2>
        <p style={muted}>If you delete your account:</p>
        <ul className="list-disc space-y-1 pl-5" style={muted}>
          <li>You are signed out everywhere, and nobody can see your profile from then on.</li>
          <li>Any health information is made unreadable straight away.</li>
          <li>Everything else is deleted within 30 days.</li>
          <li>
            It cannot be undone. You can join again later with the same number, as a new member.
          </li>
        </ul>
        <p style={muted}>You may want to download your data first.</p>

        {step === 'idle' && (
          <Button
            variant="destructive"
            onClick={() => {
              setStep('confirm');
            }}
          >
            Delete my account
          </Button>
        )}

        {step === 'confirm' && (
          <div className="space-y-3">
            <p>To make sure it is you, we will text a code to your number.</p>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="destructive"
                isLoading={sending}
                disabled={sending}
                onClick={() => void sendCode()}
              >
                Send the code
              </Button>
              <Button variant="ghost" onClick={cancel}>
                Keep my account
              </Button>
            </div>
          </div>
        )}

        {step === 'code' && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void confirmDelete();
            }}
          >
            <div>
              <label htmlFor={`${id}-code`} className="mb-1.5 block text-sm font-medium">
                Code from the text message
              </label>
              <input
                ref={codeInput}
                id={`${id}-code`}
                type="text"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                aria-required="true"
                aria-describedby={`${id}-code-hint`}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                }}
                className="w-full rounded-lg border px-4 py-3 text-center text-base tracking-[0.5em] focus:outline-none"
                style={{
                  backgroundColor: 'var(--color-bg-muted)',
                  borderColor: 'var(--color-border-strong)',
                  color: 'var(--color-text)',
                }}
              />
              <p id={`${id}-code-hint`} className="mt-1.5 text-xs" style={muted}>
                The code expires in 5 minutes.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                variant="destructive"
                isLoading={deleting}
                disabled={deleting || code.length !== 6}
              >
                Delete my account permanently
              </Button>
              <Button variant="ghost" onClick={cancel}>
                Keep my account
              </Button>
            </div>
          </form>
        )}

        {deleteError && (
          <p role="alert" className="rounded-lg px-4 py-3 text-sm" style={alertStyle}>
            {deleteError}
          </p>
        )}
      </section>
    </div>
  );
}

const alertStyle = { backgroundColor: 'var(--color-bg-muted)' };
