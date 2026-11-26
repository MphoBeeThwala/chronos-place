import type { Metadata } from 'next';
import Link from 'next/link';
import { YourData } from '@/components/account/YourData';

export const metadata: Metadata = { title: 'Your data and account' };

/**
 * Download or delete (TASKS M1.8, ADR-0025). Outside the main layout on purpose, so a member who
 * has not finished onboarding can use it without the app's navigation.
 */
export default function AccountPage() {
  return (
    <main id="main-content" className="mx-auto max-w-md space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Your data and account</h1>
      <YourData />
      <p className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link href="/profile" className="touch-target inline-flex items-center underline">
          Back to your profile
        </Link>
        <Link href="/onboarding" className="touch-target inline-flex items-center underline">
          Back to signing up
        </Link>
        <Link href="/privacy" className="touch-target inline-flex items-center underline">
          Privacy Policy
        </Link>
      </p>
    </main>
  );
}
