import type { Metadata } from 'next';
import { Onboarding } from '@/components/onboarding/Onboarding';

export const metadata: Metadata = { title: 'Finish signing up' };

/** Where a new member lands after the code check (TASKS M1.7, ADR-0020). */
export default function OnboardingPage() {
  return (
    <main id="main-content" className="mx-auto max-w-md p-6">
      <Onboarding />
    </main>
  );
}
