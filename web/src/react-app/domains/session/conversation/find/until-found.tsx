/**
 * A collapsed panel whose text is still there.
 *
 * `hidden="until-found"` is the whole point. A panel that unmounts its body
 * when closed — the obvious way to write a disclosure — makes every word inside
 * it unsearchable: the browser's own find-in-page cannot see it, and neither
 * can ours, because both walk the DOM. `until-found` keeps the content in the
 * tree, visually hidden, and the browser reveals it when a find hits inside,
 * firing `beforematch` so the owning component can move its own state to
 * "open" instead of fighting the browser on the next render.
 *
 * `beforematch` is attached imperatively rather than as a prop because it is
 * not in React's event system, and the attribute is written the same way for
 * the same reason — `hidden` is a boolean prop, and the string value is the
 * only one that means anything here.
 *
 * Content-visibility is left to the attribute: a panel hidden this way is not
 * laid out, so a long collapsed transcript costs no more than an unmounted one.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'

export function UntilFound({
  open,
  onReveal,
  children,
  // Everything else lands on the body element. `data-scrollable` is the one
  // that matters today: a collapsed panel that scrolls internally has to tell
  // the scroll controller so, or scrolling a tool's output detaches the whole
  // transcript from the bottom.
  ...rest
}: {
  open: boolean
  /** The browser found a match inside; the owner should open itself. */
  onReveal: () => void
  children: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement | null>(null)
  const revealRef = useRef(onReveal)
  revealRef.current = onReveal

  // Layout, not passive: `useEffect` runs *after* paint, so every collapsed
  // panel would render visible for one frame on mount — a transcript of folded
  // turns flashing its whole contents open on every navigation.
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (open) element.removeAttribute('hidden')
    else element.setAttribute('hidden', 'until-found')
  }, [open])

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const onBeforeMatch = () => revealRef.current()
    element.addEventListener('beforematch', onBeforeMatch)
    return () => element.removeEventListener('beforematch', onBeforeMatch)
  }, [])

  return (
    <div ref={ref} {...rest}>
      {children}
    </div>
  )
}
