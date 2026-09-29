import type { ButtonHTMLAttributes } from 'react'
import { X } from 'lucide-react'
import { cn } from './cn'

/**
 * The one close control.
 *
 * A dismiss "✕" was hand-rolled at five call sites — modal, panel dock, artifact
 * header, tab, find bar — each with its own size, radius, hover, and focus ring,
 * and each spelling the glyph as a bare character. This is that button, once: a
 * lucide `X` (so it matches the icon language of the rest of the chrome rather
 * than a typeset multiplication sign), the shared hover and focus-ring, and a
 * default accessible name.
 *
 * It forwards every native button prop, so a caller that needs a specific label
 * (`Close ${tab.label}`) or a handler (a tab stops `pointerDown` from starting a
 * drag) passes it through; and `className` is merged last, so a caller can size
 * it (`size-5`) or restyle it without fighting the defaults.
 */
export interface CloseButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The rendered glyph size. The hit target is set by the button's own size. */
  iconClassName?: string
}

export function CloseButton({
  className,
  iconClassName,
  type = 'button',
  'aria-label': ariaLabel = 'Close',
  ...props
}: CloseButtonProps) {
  return (
    <button
      type={type}
      aria-label={ariaLabel}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3',
        'transition-colors outline-none hover:bg-surface-2 hover:text-ink',
        'focus-visible:ring-2 focus-visible:ring-accent',
        className,
      )}
      {...props}
    >
      <X className={cn('size-3.5', iconClassName)} aria-hidden="true" />
    </button>
  )
}
