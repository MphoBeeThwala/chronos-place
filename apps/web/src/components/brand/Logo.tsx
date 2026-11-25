/**
 * The Chronos Place logo (brand/mark.svg): two embracing arms forming a heart around an
 * hourglass. `decorative` hides it from screen readers when the name is written beside it.
 */
interface Props {
  size?: number;
  decorative?: boolean;
  className?: string;
}

export function LogoMark({ size = 48, decorative = false, className }: Props) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : 'Chronos Place'}
      focusable="false"
    >
      <path
        d="M30 56 C 19 47, 6 37, 6 23 C 6 13.5, 13 7, 21 7 C 25 7, 28.5 9, 30.5 12"
        fill="none"
        stroke="var(--logo-left, #4b223d)"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M34 56 C 45 47, 58 37, 58 23 C 58 13.5, 51 7, 43 7 C 39 7, 35.5 9, 33.5 12"
        fill="none"
        stroke="var(--logo-right, #d45b6a)"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <g stroke="var(--logo-left, #4b223d)" strokeWidth="2.4" strokeLinecap="round" fill="none">
        <path d="M24 19 H40 M24 47 H40" />
        <path d="M26.5 19 C26.5 27, 31 29, 31 33 C31 37, 26.5 39, 26.5 47" />
        <path d="M37.5 19 C37.5 27, 33 29, 33 33 C33 37, 37.5 39, 37.5 47" />
      </g>
      <path
        d="M28.6 23 H35.4 C34.8 26.5, 33 28.2, 32 29.6 C31 28.2, 29.2 26.5, 28.6 23 Z"
        fill="var(--logo-right, #d45b6a)"
      />
      <path
        d="M28.2 45 C29.2 41.8, 30.8 40.6, 32 40.6 C33.2 40.6, 34.8 41.8, 35.8 45 Z"
        fill="var(--logo-right, #d45b6a)"
      />
    </svg>
  );
}

/** Mark and wordmark together, as on the brand board. */
export function Logo({ size = 48 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-3">
      <LogoMark size={size} decorative />
      <span
        className="text-2xl font-bold tracking-tight"
        style={{ color: 'var(--color-text)', fontFamily: 'Georgia, "Times New Roman", serif' }}
      >
        Chronos Place
      </span>
    </span>
  );
}
