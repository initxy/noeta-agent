/**
 * A value that only settles once the changes stop.
 *
 * This is the piece the interaction reference is missing, and its absence is
 * not a performance nicety there: the mention menu re-queries on every
 * `mentionQuery` change, so typing `@src/app` fires eight searches and the
 * results the user sees are whichever of them happened to return last.
 *
 * Ours sits in front of the query key, so a burst of keystrokes settles into
 * **one** request and the menu can never be showing the answer to a prefix.
 */

import { useEffect, useState } from 'react'

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)

  // The equality guard is what terminates the loop: the settle re-runs this
  // effect, finds nothing left to do, and arms no timer. Without it every
  // settle would schedule the next one.
  useEffect(() => {
    if (Object.is(settled, value)) return
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, settled, delayMs])

  return settled
}
