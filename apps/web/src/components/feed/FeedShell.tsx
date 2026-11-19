'use client';

/**
 * Feed shell — discovery page.
 * M3.2 will populate this with real candidate profiles.
 * This shell demonstrates the accessible card structure with keyboard-navigable
 * Like/Pass buttons (WCAG: button alternatives to swipes, CLAUDE.md accessibility).
 */
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

interface CardProfile {
  id: string;
  displayName: string;
  age: number;
  areaLabel: string | null;
  /** Whole kilometres, never finer than 1 km (CLAUDE.md rule 8); null when location is hidden. */
  distanceKm: number | null;
  verified: boolean;
  bio: string;
}

/** Placeholder profile for shell demonstration. */
const PLACEHOLDER_PROFILE: CardProfile = {
  id: 'placeholder',
  displayName: 'Placeholder Profile',
  age: 28,
  areaLabel: 'Johannesburg North',
  distanceKm: 5,
  verified: true,
  bio: 'This is a placeholder. Real profiles will appear once M1 (identity + profiles) and M3 (discovery) are complete.',
};

export function FeedShell() {
  const profile = PLACEHOLDER_PROFILE;

  return (
    <section className="p-4 max-w-sm mx-auto" aria-label="Discover profiles">
      <h1 className="sr-only">Discover</h1>

      <Card raised className="relative overflow-hidden">
        {/* Photo placeholder */}
        <div
          className="w-full h-72 flex items-center justify-center"
          style={{ backgroundColor: 'var(--color-bg-muted)' }}
          role="img"
          aria-label={`${profile.displayName}'s profile photo — placeholder`}
        >
          <svg
            width="64"
            height="64"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            aria-hidden="true"
            style={{ color: 'var(--color-border-strong)' }}
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
          </svg>
        </div>

        {/* Profile info */}
        <div className="p-4">
          <div className="flex items-start justify-between mb-1">
            <div>
              <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
                {profile.displayName},{' '}
                <span style={{ color: 'var(--color-text-muted)' }}>{profile.age}</span>
              </h2>
              {profile.areaLabel && (
                <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                  {profile.areaLabel}
                  {profile.distanceKm !== null && <span> · {profile.distanceKm} km away</span>}
                </p>
              )}
            </div>
            {profile.verified && (
              <Badge variant="success" aria-label="Verified member">
                ✓ Verified
              </Badge>
            )}
          </div>

          {profile.bio && (
            <p className="mt-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {profile.bio}
            </p>
          )}
        </div>

        {/* Action buttons — always visible keyboard alternatives to swipe */}
        <div
          className="flex gap-3 px-4 pb-4"
          role="group"
          aria-label={`Actions for ${profile.displayName}`}
        >
          <Button
            variant="secondary"
            size="lg"
            className="flex-1"
            aria-label={`Pass on ${profile.displayName}'s profile`}
            onClick={() => {
              /* TODO(M3.1): call pass mutation */
            }}
          >
            <span aria-hidden="true">✕</span>
            <span className="ml-2">Pass</span>
          </Button>
          <Button
            variant="primary"
            size="lg"
            className="flex-1"
            aria-label={`Like ${profile.displayName}'s profile`}
            onClick={() => {
              /* TODO(M3.1): call like mutation */
            }}
          >
            <span aria-hidden="true">♥</span>
            <span className="ml-2">Like</span>
          </Button>
        </div>
      </Card>

      {/* Pagination hint */}
      <p
        className="mt-4 text-center text-xs"
        style={{ color: 'var(--color-text-subtle)' }}
        aria-live="polite"
      >
        Discovery feed — available in M3
      </p>
    </section>
  );
}
