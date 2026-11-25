import type { Metadata } from 'next';
import { VerifySelfie } from '@/components/verification/VerifySelfie';

export const metadata: Metadata = { title: 'Verify your profile' };

/** Selfie verification (TASKS M1.4). The only route where the camera is allowed. */
export default function VerifyPage() {
  return (
    <section className="mx-auto max-w-md p-4">
      <h1 className="mb-4 text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
        Verify your profile
      </h1>
      <VerifySelfie />
    </section>
  );
}
