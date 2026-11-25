import type { Metadata } from 'next';
import { PolicyPage } from '@/components/legal/PolicyPage';
import { TERMS } from '@/legal/policies';

export const metadata: Metadata = { title: TERMS.title };

export default function TermsPage() {
  return <PolicyPage policy={TERMS} />;
}
