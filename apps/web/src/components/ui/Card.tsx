/**
 * Card — base surface component. Used for profile cards, match cards, etc.
 */
import { cn } from '@/lib/cn.js';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  raised?: boolean;
}

export function Card({ raised = false, className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border overflow-hidden',
        raised && 'shadow-md',
        className,
      )}
      style={{
        backgroundColor: raised ? 'var(--color-surface-raised)' : 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
      {...props}
    >
      {children}
    </div>
  );
}
