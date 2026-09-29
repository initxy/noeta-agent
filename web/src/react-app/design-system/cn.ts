import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge class names, letting the caller's utilities win over a component's
 * defaults. Without the tailwind-aware merge, `className="p-4"` on a component
 * that already sets `p-2` produces two conflicting rules decided by stylesheet
 * order rather than by the caller.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
