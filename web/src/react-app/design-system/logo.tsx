import { cn } from './cn'

/**
 * The brand mark: a node inside an orbit, beside the wordmark.
 *
 * The ring is the track and the filled centre is the node — the same signal the
 * product uses everywhere else for "something is running" (see
 * `activity-indicators.tsx` and `tool-line.tsx`). Both draw in `currentColor`,
 * so the whole mark inherits the accent token and follows the theme.
 *
 * `running` pulses the node, reusing the product's one live glyph rather than
 * inventing a second. It is off by default and gated behind `motion-safe`, so a
 * reader who asked for less motion sees a still mark; here in the logo it is
 * static unless a caller opts in, so it never competes for the eye with the
 * pulsing indicators where work is actually happening.
 *
 * Presentational only — no link, no store. The sidebar wraps it in the `Link`
 * to home, because "where the logo goes" is the shell's decision, not the
 * mark's.
 */
export function Logo({
  className,
  running = false,
}: {
  className?: string
  running?: boolean
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-semibold text-ink', className)}>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="size-[1.15em] shrink-0 text-accent"
        fill="none"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.9" />
        <circle
          cx="8"
          cy="8"
          r="2.6"
          fill="currentColor"
          className={cn(running && 'motion-safe:animate-pulse')}
        />
      </svg>
      <span className="tracking-tight">Noeta</span>
    </span>
  )
}
