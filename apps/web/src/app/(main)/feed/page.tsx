/**
 * Feed page — discovery.
 * M3.2 will populate this with real candidate data.
 * Shell shows the accessible card structure.
 */
import type { Metadata } from 'next';
import { FeedShell } from '@/components/feed/FeedShell.js';

export const metadata: Metadata = { title: 'Discover' };

export default function FeedPage() {
  return <FeedShell />;
}
