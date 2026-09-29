import { describe, expect, it } from 'vitest'
import { retainedIndex, stepIndex, wrapIndex } from './matches'

/**
 * The match list is rebuilt under the reader every time the transcript moves.
 * What is pinned here is that the *element* decides where they are, and the
 * index only decides where they land when the element is gone.
 */

const elements = (count: number) =>
  Array.from({ length: count }, () => document.createElement('mark'))

describe('retaining the active match', () => {
  it('follows the element when the list shifts around it', () => {
    // A row streamed in above the active match: index 1 is now index 3, and
    // taking the index would move the reader to a different sentence.
    const [a, b, c] = elements(3)
    const before = [a, b]
    const after = [c, ...before]

    expect(retainedIndex(after, before[1], 1)).toBe(2)
  })

  it('clamps into range when the element is gone', () => {
    const next = elements(2)

    expect(retainedIndex(next, document.createElement('mark'), 5)).toBe(1)
  })

  it('has nothing to retain in an empty list', () => {
    expect(retainedIndex([], document.createElement('mark'), 2)).toBe(-1)
  })

  it('stays inactive when nothing was active', () => {
    expect(retainedIndex(elements(3), null, -1)).toBe(-1)
  })
})

describe('stepping through matches', () => {
  it('wraps forwards and backwards', () => {
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(2)
  })

  it('starts at the first match going forwards and the last going backwards', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0)
    expect(stepIndex(-1, 3, -1)).toBe(2)
  })

  it('has nowhere to go in an empty list', () => {
    expect(stepIndex(-1, 0, 1)).toBe(-1)
    expect(wrapIndex(3, 0)).toBe(-1)
  })
})
