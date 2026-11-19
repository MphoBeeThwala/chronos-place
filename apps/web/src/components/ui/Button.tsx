/**
 * Button component — primary interactive element.
 * WCAG 2.2: minimum 44×44 CSS px touch target, visible focus ring.
 * Uses design tokens from @chronos/ui.
 */
import { cn } from '@/lib/cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  isLoading?: boolean;
}

const baseStyles =
  'inline-flex items-center justify-center font-semibold rounded-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 touch-target';

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-primary)] text-[var(--color-text-on-brand)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-[var(--color-primary)] active:bg-[var(--color-primary-active)]',
  secondary:
    'bg-[var(--color-bg-muted)] text-[var(--color-text)] border border-[var(--color-border-strong)] hover:bg-[var(--color-bg-subtle)]',
  ghost:
    'bg-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]',
  destructive:
    'bg-[var(--color-destructive)] text-white hover:opacity-90 focus-visible:outline-[var(--color-destructive)]',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-5 text-base',
  lg: 'h-12 px-6 text-base',
};

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  isLoading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        baseStyles,
        variantStyles[variant],
        sizeStyles[size],
        fullWidth && 'w-full',
        className,
      )}
      disabled={disabled ?? isLoading}
      aria-busy={isLoading}
      {...props}
    >
      {isLoading ? (
        <>
          <Spinner className="mr-2" />
          <span aria-live="polite">Loading…</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
