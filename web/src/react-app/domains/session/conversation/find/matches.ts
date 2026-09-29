/**
 * Which match is the active one, across a match list that keeps changing.
 *
 * The list is re-collected every time the transcript's DOM moves — a streaming
 * turn does that dozens of times a minute — and a match's *index* is worthless
 * across that: one new row above the active match and index 4 is now a
 * different sentence. So the active match is retained by **element identity**,
 * and the index is only the fallback for when the element genuinely went away.
 *
 * Pure, because "the active match survived a re-collect" is the property worth
 * testing and it needs no DOM to state.
 */

/** Wrap an index into `[0, total)`, for a list that navigates in a loop. */
export function wrapIndex(index: number, total: number): number {
  if (total <= 0) return -1
  return ((index % total) + total) % total
}

/**
 * The index the active match should take in a freshly collected list.
 *
 * In order: the same element if it is still there; otherwise the old position
 * clamped into the new list, which keeps the reader roughly where they were
 * rather than throwing them back to the first match; `-1` when there is nothing
 * to be active.
 */
export function retainedIndex(
  next: readonly Element[],
  active: Element | null,
  previousIndex: number,
): number {
  if (next.length === 0) return -1
  if (active !== null) {
    const found = next.indexOf(active)
    if (found !== -1) return found
  }
  if (previousIndex < 0) return -1
  return Math.min(previousIndex, next.length - 1)
}

/** The next / previous match, wrapping. From nothing active, next is 0 and previous is the last. */
export function stepIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1
  // Spelled out rather than left to the wrap: `-1 + -1` wraps to the
  // second-to-last match, which is not what "previous, from nothing" means.
  if (current < 0) return direction === 1 ? 0 : total - 1
  return wrapIndex(current + direction, total)
}
