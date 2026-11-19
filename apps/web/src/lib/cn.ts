/**
 * Class name helper: merges Tailwind classes safely.
 * Thin wrapper around clsx + tailwind-merge.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
