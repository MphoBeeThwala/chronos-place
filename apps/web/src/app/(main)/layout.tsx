/**
 * Authenticated shell layout — wraps feed, matches, profile.
 * Renders the top navigation and the bottom tab bar.
 */
import { TopNav } from '@/components/layout/TopNav.js';
import { BottomNav } from '@/components/layout/BottomNav.js';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-screen flex-col"
      style={{ backgroundColor: 'var(--color-bg)' }}
    >
      <TopNav />
      <main id="main-content" className="flex-1 overflow-y-auto pb-20">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
