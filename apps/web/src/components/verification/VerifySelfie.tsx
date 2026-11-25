'use client';

/**
 * Selfie verification (TASKS M1.4, ADR-0022): consent, capture, upload, then the result.
 * Results are polled while a check runs. The photos go only to our gateway.
 */
import { gql, useMutation, useQuery } from '@apollo/client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { OPERATIONS } from '@/graphql/operations.generated';
import { refreshSession } from '@/lib/session';
import {
  BIOMETRIC_CONSENT,
  biometricConsent,
  type CaptureBody,
  failureText,
  uploadCapture,
  type VerificationView,
} from '@/lib/verification';
import { BiometricConsent } from './BiometricConsent';
import { SelfieCamera } from './SelfieCamera';

const VERIFICATION = gql(OPERATIONS.Verification.text);
const CONSENT = gql(OPERATIONS.VerificationConsent.text);
const RECORD_CONSENT = gql(OPERATIONS.RecordConsent.text);
const REQUEST_REVIEW = gql(OPERATIONS.RequestVerificationReview.text);
const POLL_MS = 3_000;

interface ConsentData {
  consents: { type: string; policyVersion: string; granted: boolean }[];
  currentPolicies: { type: string; version: string }[];
}

const muted = { color: 'var(--color-text-muted)' };

export function VerifySelfie() {
  const router = useRouter();
  const verification = useQuery<{ verification: VerificationView }>(VERIFICATION, {
    fetchPolicy: 'network-only',
  });
  const consent = useQuery<ConsentData>(CONSENT, { fetchPolicy: 'network-only' });
  const [recordConsent, { loading: recording }] = useMutation(RECORD_CONSENT);
  const [requestReview, { loading: requesting }] = useMutation(REQUEST_REVIEW);
  const [camera, setCamera] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const view = verification.data?.verification;
  const pending = view?.status === 'PENDING';
  const { startPolling, stopPolling } = verification;
  // Poll only while a check runs.
  useEffect(() => {
    if (pending) startPolling(POLL_MS);
    else stopPolling();
    return stopPolling;
  }, [pending, startPolling, stopPolling]);

  if (verification.loading || consent.loading) return <p style={muted}>Loading…</p>;
  if (!view || !consent.data) {
    return <p role="alert">Something went wrong. Please reload the page.</p>;
  }
  const { version, granted } = biometricConsent(
    consent.data.consents,
    consent.data.currentPolicies,
  );

  const setConsent = async (agree: boolean) => {
    setMessage(undefined);
    await recordConsent({
      variables: { input: { type: BIOMETRIC_CONSENT, policyVersion: version, granted: agree } },
    });
    await Promise.all([consent.refetch(), verification.refetch()]);
  };

  const submit = async (body: CaptureBody) => {
    setCamera(false);
    setUploading(true);
    setMessage(undefined);
    const result = await uploadCapture(body, refreshSession);
    setUploading(false);
    if (result.ok) {
      await verification.refetch();
      return;
    }
    if (result.signedOut) {
      router.push('/sign-in');
      return;
    }
    setMessage(result.message);
  };

  let content: React.ReactNode;
  if (view.status === 'VERIFIED') {
    content = (
      <>
        <p>Your profile is verified. Other members will see your verified badge.</p>
        <Button variant="secondary" isLoading={recording} onClick={() => void setConsent(false)}>
          Withdraw consent and delete my photos
        </Button>
      </>
    );
  } else if (pending || uploading) {
    content = <p>Checking your photos. This usually takes a few seconds.</p>;
  } else if (view.status === 'IN_REVIEW') {
    content = <p>A person will review your check. We will let you know when it is done.</p>;
  } else if (!granted) {
    content = <BiometricConsent busy={recording} onAgree={() => void setConsent(true)} />;
  } else if (camera) {
    content = (
      <SelfieCamera
        onCapture={(body) => void submit(body)}
        onCancel={() => {
          setCamera(false);
        }}
        onInvalid={() => {
          setCamera(false);
          setMessage('The photos could not be used. Please try again.');
        }}
      />
    );
  } else {
    content = (
      <>
        {view.status === 'FAILED' && <p>{failureText(view.failure)}</p>}
        {view.attemptsRemaining > 0 ? (
          <Button
            fullWidth
            onClick={() => {
              setCamera(true);
            }}
          >
            {view.status === 'FAILED' ? 'Try again' : 'Start the selfie check'}
          </Button>
        ) : (
          <p>You have used all your attempts for now. Please try again later.</p>
        )}
        {view.reviewAvailable && (
          <Button
            variant="secondary"
            fullWidth
            isLoading={requesting}
            onClick={() => void requestReview().then(() => verification.refetch())}
          >
            Ask a person to review my check
          </Button>
        )}
        <p className="text-sm" style={muted}>
          You will need good light and a camera. The check takes under a minute.
        </p>
      </>
    );
  }

  return (
    <div className="space-y-4">
      {/* Announces state changes (checking, result) to screen readers. */}
      <div aria-live="polite" className="space-y-4">
        {content}
      </div>
      {message && (
        <p role="alert" style={{ color: 'var(--color-destructive)' }}>
          {message}
        </p>
      )}
    </div>
  );
}
