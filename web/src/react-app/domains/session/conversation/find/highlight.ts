/**
 * Find-in-conversation, at the DOM level.
 *
 * Matches are marked by rewriting text nodes into `<mark>` elements, which is
 * the only way to get a match *list* in document order out of a transcript
 * whose text is spread across hundreds of components. Two consequences follow
 * and both are designed for rather than discovered:
 *
 * **`pre` and `code` are never highlighted.** Marking inside code splits
 * tokens, and the highlighted subtrees shiki produces are not ours to rewrite.
 * A reader searching for `useEffect` gets the prose hits; the code block is
 * reachable by the browser's own find.
 *
 * **The original text node is put back, not rebuilt.** React owns these nodes:
 * it updates text by writing `nodeValue` on the exact node it created, so
 * replacing that node with `[text][mark][text]` and later reconstructing a
 * *new* text node from the mark's content would freeze the row on whatever it
 * said when the search ran. So every rewrite remembers the node it displaced,
 * and clearing re-inserts that same node — carrying any value React wrote to it
 * in the meantime. `normalize()` is deliberately **not** used for the same
 * reason: it merges sibling text nodes React is still holding separately.
 *
 * A subtree may opt out entirely with `data-find-skip`, which the live
 * streaming preview does: its text nodes are replaced every animation frame, so
 * there is no stable node to displace.
 */

/** Shorter than this matches everything and helps nobody. */
export const MIN_QUERY_LENGTH = 2

export const MARK_SELECTOR = 'mark[data-find-hit="true"]'
export const ACTIVE_ATTR = 'data-find-active'

const BASE_CLASSES = ['rounded-sm', 'px-0.5', 'bg-warn-soft']
const ACTIVE_CLASSES = ['bg-warn', 'text-ink', 'ring-1', 'ring-warn']

/** Elements whose text is structural or not ours to rewrite. */
const EXCLUDED_TAGS = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'MARK'])

interface Rewrite {
  /** The node React created, kept so it can be put back rather than rebuilt. */
  original: Text
  /** What replaced it. */
  created: Node[]
}

const REWRITES = new WeakMap<Element, Rewrite[]>()

export interface Range {
  start: number
  end: number
}

/**
 * Non-overlapping, case-insensitive match ranges.
 *
 * A plain scan rather than a regex: the needle is user input, and building a
 * regex from it means escaping it correctly on every path forever.
 */
export function highlightRanges(text: string, needle: string): Range[] {
  if (needle === '') return []
  const haystack = text.toLowerCase()
  const target = needle.toLowerCase()
  const ranges: Range[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(target, from)
    if (at === -1) return ranges
    ranges.push({ start: at, end: at + target.length })
    from = at + target.length
  }
}

function isExcluded(node: Text): boolean {
  let element = node.parentElement
  while (element !== null) {
    if (EXCLUDED_TAGS.has(element.tagName)) return true
    if (element.hasAttribute('data-find-skip')) return true
    element = element.parentElement
  }
  return false
}

/** Every text node under `root` that contains the needle and may be rewritten. */
function candidates(root: Element, needle: string): Text[] {
  const target = needle.toLowerCase()
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue
      if (text === null || text.trim() === '') return NodeFilter.FILTER_REJECT
      if (!text.toLowerCase().includes(target)) return NodeFilter.FILTER_REJECT
      if (isExcluded(node as Text)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  // Collected before anything is replaced: mutating the tree under a live
  // walker skips nodes, and the skipped ones are silently unsearchable.
  const found: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    found.push(node as Text)
  }
  return found
}

function mark(document: Document, text: string): HTMLElement {
  const element = document.createElement('mark')
  element.setAttribute('data-find-hit', 'true')
  element.classList.add(...BASE_CLASSES)
  element.textContent = text
  return element
}

/**
 * Undo every rewrite, restoring the nodes React is still holding.
 *
 * Reversed so nested replacements come apart in the order they were made. A
 * rewrite whose nodes have since been unmounted is simply skipped: the parent
 * went with them, and there is nothing to restore into.
 */
export function clearHighlights(root: Element): void {
  const rewrites = REWRITES.get(root)
  REWRITES.delete(root)
  if (rewrites !== undefined) {
    for (let i = rewrites.length - 1; i >= 0; i -= 1) {
      const { original, created } = rewrites[i]
      const anchor = created[0]
      const parent = anchor?.parentNode ?? null
      if (parent !== null) parent.insertBefore(original, anchor)
      for (const node of created) node.parentNode?.removeChild(node)
    }
  }
  // Anything left is a mark whose bookkeeping was lost — a re-render that
  // moved it, most likely. Unwrap it rather than leaving it highlighted
  // forever; the text it carries is the best available.
  for (const stray of root.querySelectorAll(MARK_SELECTOR)) {
    stray.replaceWith(root.ownerDocument.createTextNode(stray.textContent ?? ''))
  }
}

/**
 * Mark every occurrence of `needle` under `root`, replacing whatever was
 * marked before. A needle under the minimum length only clears.
 */
export function applyHighlights(root: Element, needle: string): void {
  clearHighlights(root)
  if (needle.trim().length < MIN_QUERY_LENGTH) return
  markMatches(root, needle)
}

/**
 * Mark what is not marked yet, leaving existing marks — and therefore the
 * active one — exactly where they are.
 *
 * This is what runs when the transcript moves under an open search. Clearing
 * and re-marking would be simpler and would destroy the reader's active match
 * on every streamed row, because the element it is held by would no longer
 * exist. Incremental works because a marked region cannot match again: `MARK`
 * is excluded from the walk, and the plain text left either side of a mark has
 * had every occurrence of the needle taken out of it.
 */
export function refreshHighlights(root: Element, needle: string): void {
  if (needle.trim().length < MIN_QUERY_LENGTH) {
    clearHighlights(root)
    return
  }
  markMatches(root, needle)
}

function markMatches(root: Element, needle: string): void {
  const document = root.ownerDocument
  const rewrites: Rewrite[] = REWRITES.get(root) ?? []

  for (const node of candidates(root, needle)) {
    const text = node.nodeValue ?? ''
    const ranges = highlightRanges(text, needle)
    if (ranges.length === 0) continue

    const created: Node[] = []
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const range of ranges) {
      if (range.start > cursor) created.push(document.createTextNode(text.slice(cursor, range.start)))
      created.push(mark(document, text.slice(range.start, range.end)))
      cursor = range.end
    }
    if (cursor < text.length) created.push(document.createTextNode(text.slice(cursor)))
    for (const child of created) fragment.append(child)

    node.parentNode?.replaceChild(fragment, node)
    rewrites.push({ original: node, created })
  }

  if (rewrites.length > 0) REWRITES.set(root, rewrites)
}

/** Every mark under `root`, in document order — which is also visual order. */
export function collectMarks(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(MARK_SELECTOR)]
}

export function setMarkActive(element: HTMLElement, active: boolean): void {
  if (active) {
    element.setAttribute(ACTIVE_ATTR, 'true')
    element.classList.remove('bg-warn-soft')
    element.classList.add(...ACTIVE_CLASSES)
    return
  }
  element.removeAttribute(ACTIVE_ATTR)
  element.classList.remove(...ACTIVE_CLASSES)
  element.classList.add('bg-warn-soft')
}

/**
 * Make a match reachable: open every collapsed ancestor above it.
 *
 * Collapsed panels are rendered with `hidden="until-found"` so their text stays
 * in the DOM and stays searchable. The browser reveals such a panel by firing
 * `beforematch` on it and then unhiding it, so **this fires the same event**
 * rather than only stripping the attribute: the panel's own listener is what
 * moves its React state to open, and without that the next render puts the
 * attribute straight back and the reader is scrolled to something invisible.
 * The attribute is dropped as well so the reveal is immediate — the scroll
 * happens on the next line, not after a commit.
 */
export function revealMatch(element: Element): void {
  let node: Element | null = element
  while (node !== null) {
    if (node.hasAttribute('hidden')) {
      node.dispatchEvent(new Event('beforematch'))
      node.removeAttribute('hidden')
    }
    if (node instanceof HTMLDetailsElement) node.open = true
    node = node.parentElement
  }
}
