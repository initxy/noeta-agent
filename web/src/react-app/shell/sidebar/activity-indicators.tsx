/**
 * The two indicators, rendered.
 *
 * `row-signals.ts` decides *which* of them a row gets; this file is only how
 * they look. Neither component decides anything, which is what keeps the
 * mutual exclusion in one testable function instead of spread across two
 * components that each think they are the exception.
 */

import { useEffect, useState } from 'react'
import { cn } from '@/react-app/design-system'
import type { RowOutcome } from './row-signals'

/** ms between dot-matrix frames. Slow enough to read as breathing, not spinning. */
export const DOT_MATRIX_FRAME_MS = 180

/**
 * Four hand-placed 3×3 frames. Hand-placed rather than generated because the
 * point is a mark that looks *alive* — a rotating pattern reads as a spinner,
 * and a spinner is what the rest of the web already means by "blocked".
 */
const FRAMES = [
  [1, 0, 0, 1, 1, 0, 1, 0, 1],
  [0, 1, 0, 1, 0, 1, 0, 1, 1],
  [0, 0, 1, 0, 1, 1, 1, 1, 0],
  [1, 1, 0, 0, 1, 0, 1, 0, 1],
] as const

/**
 * Whether the viewer asked for less motion.
 *
 * Read live rather than once: a user who turns the preference on mid-session
 * means it now, and `matchMedia` is checked for existence because the test
 * environment does not implement it.
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return reduced
}

/**
 * The activity mark: the app's single "living" glyph, on the glyph lane.
 *
 * Under `prefers-reduced-motion` there is **no interval at all** — the frame
 * is static. Rendering the animation and hiding it behind CSS would keep a
 * timer running per row for a user who asked for the opposite.
 */
export function SessionDotMatrix({ label = 'Running' }: { label?: string }) {
  const reduced = useReducedMotion()
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (reduced) return
    const timer = window.setInterval(
      () => setFrame((current) => (current + 1) % FRAMES.length),
      DOT_MATRIX_FRAME_MS,
    )
    return () => window.clearInterval(timer)
  }, [reduced])

  const dots = FRAMES[reduced ? 0 : frame]

  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      data-session-activity-indicator=""
      className="inline-grid size-3.5 grid-cols-3 grid-rows-3 gap-px text-accent"
    >
      {dots.map((lit, index) => (
        <span
          // The index is the identity here: a 3x3 grid of anonymous cells has
          // no other key, and the list is fixed-length and never reordered.
          key={index}
          className={cn('rounded-sm bg-current', lit ? 'opacity-90' : 'opacity-25')}
        />
      ))}
    </span>
  )
}

const OUTCOME_CLASS: Record<Exclude<RowOutcome, null>, string> = {
  // "needs you" — the same warn token the composer's question panel uses.
  waiting: 'bg-warn',
  // "finished while you were elsewhere" — the accent, because it is a result.
  unread: 'bg-accent',
}

/**
 * The trailing state slot.
 *
 * **Always rendered**, for the same reason the glyph slot always is: a dot
 * that appears and disappears must not resize the title beside it. It carries
 * the row's single accessible state name whether or not it is showing a dot —
 * an idle row still has a state, and a screen reader that only hears about
 * sessions needing attention cannot tell "idle" from "not rendered".
 *
 * It is `aria-hidden` while the dot-matrix is up, because the glyph is already
 * announcing that row's state and two names on one row is worse than none.
 */
export function SessionStateSlot({
  outcome,
  label,
  silent = false,
}: {
  outcome: RowOutcome
  label: string
  silent?: boolean
}) {
  return (
    <span
      role={silent ? undefined : 'img'}
      aria-label={silent ? undefined : label}
      aria-hidden={silent ? true : undefined}
      title={silent ? undefined : label}
      data-session-outcome-indicator={outcome ?? ''}
      className="flex size-2 shrink-0 items-center justify-center"
    >
      {outcome ? (
        <span className={cn('size-2 rounded-full', OUTCOME_CLASS[outcome])} />
      ) : null}
    </span>
  )
}
