import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MARK_SELECTOR,
  applyHighlights,
  clearHighlights,
  collectMarks,
  highlightRanges,
  refreshHighlights,
  revealMatch,
  setMarkActive,
} from './highlight'

/**
 * Two properties carry this module: code is never marked, and clearing puts
 * back the exact text node React is still holding. Everything else is
 * bookkeeping around those.
 */

function surface(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('match ranges', () => {
  it('finds every non-overlapping occurrence, case-insensitively', () => {
    expect(highlightRanges('Fold the fold', 'fold')).toEqual([
      { start: 0, end: 4 },
      { start: 9, end: 13 },
    ])
  })

  it('does not treat the needle as a pattern', () => {
    // The needle is user input; building a regex from it means escaping it
    // correctly on every path, forever.
    expect(highlightRanges('a.b', '.')).toEqual([{ start: 1, end: 2 }])
    expect(highlightRanges('ab', '.')).toEqual([])
  })

  it('does not overlap itself', () => {
    expect(highlightRanges('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })
})

describe('applying highlights', () => {
  it('marks matching prose', () => {
    const root = surface('<p>the fold is pure</p>')
    applyHighlights(root, 'fold')

    const marks = collectMarks(root)
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toBe('fold')
    expect(root.textContent).toBe('the fold is pure')
  })

  it('never marks inside pre or code', () => {
    // Marking inside code splits tokens, and a highlighted subtree is not ours
    // to rewrite.
    const root = surface('<p>fold</p><pre><code>fold</code></pre><code>fold</code>')
    applyHighlights(root, 'fold')

    expect(collectMarks(root)).toHaveLength(1)
    expect(root.querySelector('pre')?.querySelector(MARK_SELECTOR)).toBeNull()
  })

  it('never marks a subtree that opted out', () => {
    // The live streaming preview replaces its text nodes every frame; there is
    // no stable node to displace.
    const root = surface('<div data-find-skip="true"><span>fold</span></div><p>fold</p>')
    applyHighlights(root, 'fold')

    expect(collectMarks(root)).toHaveLength(1)
  })

  it('ignores a needle under the minimum length', () => {
    const root = surface('<p>aaa</p>')
    applyHighlights(root, 'a')

    expect(collectMarks(root)).toHaveLength(0)
  })

  it('puts the original text node back on clear, not a copy of it', () => {
    // React updates text by writing `nodeValue` on the node it created. If
    // clearing rebuilt a *new* node, a row that changed while highlighted
    // would be frozen on whatever it said when the search ran.
    const root = surface('<p>the fold is pure</p>')
    const paragraph = root.querySelector('p') as HTMLElement
    const original = paragraph.firstChild as Text

    applyHighlights(root, 'fold')
    expect(paragraph.firstChild).not.toBe(original)

    // React writes to the node it still holds, while it is detached.
    original.nodeValue = 'the fold was rewritten'
    clearHighlights(root)

    expect(paragraph.firstChild).toBe(original)
    expect(root.textContent).toBe('the fold was rewritten')
  })

  it('unwraps a mark whose bookkeeping was lost', () => {
    const root = surface('<p>x</p>')
    const stray = document.createElement('mark')
    stray.setAttribute('data-find-hit', 'true')
    stray.textContent = 'orphan'
    root.append(stray)

    clearHighlights(root)

    expect(collectMarks(root)).toHaveLength(0)
    expect(root.textContent).toBe('xorphan')
  })

  it('replaces the previous query rather than layering on it', () => {
    const root = surface('<p>fold and hold</p>')
    applyHighlights(root, 'fold')
    applyHighlights(root, 'hold')

    const marks = collectMarks(root)
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toBe('hold')
    expect(root.textContent).toBe('fold and hold')
  })
})

describe('refreshing highlights', () => {
  it('marks new content and leaves existing marks alone', () => {
    // This is what the active match is held by: a full re-mark would destroy
    // the element and the reader would lose their place on every streamed row.
    const root = surface('<p>fold one</p>')
    applyHighlights(root, 'fold')
    const first = collectMarks(root)[0]

    const arrival = document.createElement('p')
    arrival.textContent = 'fold two'
    root.append(arrival)
    refreshHighlights(root, 'fold')

    const marks = collectMarks(root)
    expect(marks).toHaveLength(2)
    expect(marks[0]).toBe(first)
  })

  it('does not re-mark text it already marked', () => {
    const root = surface('<p>fold</p>')
    applyHighlights(root, 'fold')
    refreshHighlights(root, 'fold')

    expect(collectMarks(root)).toHaveLength(1)
  })
})

describe('the active mark', () => {
  it('swaps its classes and is fully reversible', () => {
    const root = surface('<p>fold</p>')
    applyHighlights(root, 'fold')
    const element = collectMarks(root)[0]
    const before = element.className

    setMarkActive(element, true)
    expect(element.getAttribute('data-find-active')).toBe('true')
    expect(element.classList.contains('bg-warn-soft')).toBe(false)

    setMarkActive(element, false)
    expect(element.getAttribute('data-find-active')).toBeNull()
    expect(element.className.split(' ').sort()).toEqual(before.split(' ').sort())
  })
})

describe('revealing a match', () => {
  it('opens every collapsed ancestor', () => {
    // Collapsed panels keep their text in the DOM with `hidden="until-found"`
    // precisely so a match inside one is reachable.
    const root = surface('<div hidden="until-found"><details><p>fold</p></details></div>')
    applyHighlights(root, 'fold')
    revealMatch(collectMarks(root)[0])

    expect(root.querySelector('[hidden]')).toBeNull()
    expect((root.querySelector('details') as HTMLDetailsElement).open).toBe(true)
  })

  it('fires beforematch so the panel opens itself', () => {
    // Stripping the attribute alone is not enough: the panel is a React
    // component, and its next render puts the attribute straight back over a
    // match the reader was just scrolled to.
    const root = surface('<div hidden="until-found"><p>fold</p></div>')
    const panel = root.firstElementChild as HTMLElement
    const opened = vi.fn()
    panel.addEventListener('beforematch', opened)

    applyHighlights(root, 'fold')
    revealMatch(collectMarks(root)[0])

    expect(opened).toHaveBeenCalledTimes(1)
  })
})
