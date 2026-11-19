/**
 * Badge — small status indicator.
 * Uses stigma-free indicator colour for health-related badges.
 */
import { cn } from '@/lib/cn';

type BadgeVariant = 'default' | 'indicator' | 'success' | 'warning' | 'muted';

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, React.CSSProperties> = {
  default: { backgroundColor: 'var(--color-primary-subtle)', color: 'var(--color-primary)' },
  indicator: { backgroundColor: 'var(--color-indicator-bg)', color: 'var(--color-indicator)' },
  success: { backgroundColor: 'var(--color-success-bg)', color: 'var(--color-success)' },
  warning: { backgroundColor: 'var(--color-warning-bg)', color: 'var(--color-warning)' },
  muted: { backgroundColor: 'var(--color-bg-muted)', color: 'var(--color-text-muted)' },
};

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        className,
      )}
      style={variantStyles[variant]}
    >
      {children}
    </span>
  );
}
