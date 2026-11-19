/**
 * Root page — immediately redirects.
 * Authenticated users → /feed; unauthenticated → /sign-in (via middleware).
 */
import { redirect } from 'next/navigation';

export default function RootPage() {
  redirect('/feed');
}
