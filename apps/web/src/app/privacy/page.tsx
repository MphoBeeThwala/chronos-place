import type { Metadata } from 'next';
import { PolicyPage } from '@/components/legal/PolicyPage';
import { PRIVACY } from '@/legal/policies';

export const metadata: Metadata = { title: PRIVACY.title };

export default function PrivacyPage() {
  return <PolicyPage policy={PRIVACY} />;
}
