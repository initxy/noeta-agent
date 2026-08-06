/**
 * What a paste means — decided once, in one place, before anything is inserted.
 *
 * The policy is **three branches with no fallthrough guessing**:
 *
 * ```
 * 1. clipboard carries files       → attach them
 * 2. clipboard carries text/uri-list → treat them as links
 * 3. anything else                 → plain text, and the editor owns it
 * ```
 *
 * The ordering is the contract, and so is the absence of a fourth "…or if the
 * text *looks* like a path / is long enough" branch. An earlier generation of
 * this composer hijacked any paste that merely *contained* something resembling
 * an absolute path, and any paste past a line count. The result was a composer
 * where pasting a code block silently lost its newlines and pasting a log line
 * did nothing at all, with no way for the user to tell which branch had eaten
 * it. Branch 3 must reach the editor untouched.
 *
 * Collapsing a long paste to a chip is a *separate* decision layered on top of
 * branch 3, and it is **measured, not counted**: the two signals are how tall
 * the text renders in this editor at this width, and how many lines it has.
 * Never a character count — a 4000-character single line is one visual line in
 * a wrapping box on a wide screen and eight on a narrow one, and a threshold
 * that cannot tell those apart collapses the wrong pastes on every screen but
 * the one it was tuned on.
 *
 * DOM types appear here without dragging in a framework: `DataTransfer` and
 * `HTMLElement` are platform, not React, and the policy is pure enough to test
 * without mounting anything.
 */

/** The three branches, as data. */
export type PasteIntent =
  | { kind: 'files'; files: File[] }
  | { kind: 'links'; links: string[] }
  | { kind: 'text'; text: string }

const FILE_URL = /^file:\/\//i
const HTTP_URL = /^https?:\/\//i

/**
 * How many lines a paste may have before it collapses to a chip when the
 * rendered height cannot be measured.
 *
 * Roughly the editor's own maximum height in lines. It is a backstop, not the
 * primary rule: see `shouldCollapsePaste`.
 */
export const MAX_INLINE_PASTE_LINES = 10

/**
 * The links in a `text/uri-list` payload, in order, without duplicates.
 *
 * The format is RFC 2483: one URI per line, `#` comments allowed. Anything
 * that is not a `file:` or `http(s):` URL is dropped rather than guessed at —
 * a `text/uri-list` full of `data:` blobs is not a link drop.
 */
export function parseUriList(raw: string): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const links: string[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    const candidate = line.trim()
    if (candidate === '' || candidate.startsWith('#')) continue
    if (!FILE_URL.test(candidate) && !HTTP_URL.test(candidate)) continue
    // `encodeURI` and not `encodeURIComponent`: a dragged filename with a space
    // must become `%20` while the `://` separators survive.
    const link = encodeURI(candidate)
    if (seen.has(link)) continue
    seen.add(link)
    links.push(link)
  }
  return links
}

function readTransfer(transfer: DataTransfer, format: string): string {
  // A synthetic DataTransfer in a test, and some engines' paste events, hand
  // over an object with no `getData` at all. Reading a format is best-effort;
  // failing to read one must not take down the paste.
  if (typeof transfer.getData !== 'function') return ''
  try {
    return transfer.getData(format) ?? ''
  } catch {
    return ''
  }
}

/**
 * Which of the three branches this paste belongs to.
 *
 * A null `DataTransfer` classifies as empty text rather than throwing: the
 * browser hands one to paste events that carry nothing, and an exception
 * raised inside an event listener is invisible — the paste just silently
 * stops working.
 */
export function classifyPaste(transfer: DataTransfer | null | undefined): PasteIntent {
  if (!transfer) return { kind: 'text', text: '' }

  const files = transfer.files ? Array.from(transfer.files) : []
  if (files.length > 0) return { kind: 'files', files }

  const links = parseUriList(readTransfer(transfer, 'text/uri-list'))
  if (links.length > 0) return { kind: 'links', links }

  return { kind: 'text', text: readTransfer(transfer, 'text/plain') }
}

/**
 * A single whitespace-free http(s) URL — the standalone-link exemption.
 *
 * A pasted link should stay a link. Collapsing one to a "pasted text" chip
 * hides the one part of it the user needs to see, and long URLs are exactly
 * the ones long enough to trip an overflow threshold.
 */
export function isStandaloneHttpUrl(text: string): boolean {
  const candidate = text.trim()
  return candidate !== '' && !/\s/.test(candidate) && HTTP_URL.test(candidate)
}

/** Where a paste would land, and how much room it has there. */
export interface PasteFit {
  /** The live editor element. Its width and typography are copied to measure. */
  editor: HTMLElement | null
  /** How tall that editor may grow before it scrolls instead, in CSS pixels. */
  maxHeightPx: number
}

/** The two signals the collapse decision is allowed to use. */
export interface PastedTextMeasure {
  lines: number
  /** Rendered height in CSS pixels, or `0` when it could not be measured. */
  heightPx: number
  maxHeightPx: number
}

/**
 * Copied from the editor so the probe wraps exactly where the editor wraps.
 *
 * Wrapping is copied rather than forced: a box that does not break long words
 * renders a 4000-character token as one line, and a probe that broke it anyway
 * would collapse pastes the editor would have shown inline.
 */
const MEASURED_STYLES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'line-height',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'text-indent',
  'word-spacing',
  'overflow-wrap',
  'word-break',
  'tab-size',
] as const

/**
 * How tall `text` would render inside `editor`, or `0` if that is unknowable.
 *
 * A detached probe rather than the live element: measuring by inserting the
 * text and reading back would flash the full paste into the composer before
 * collapsing it, and would leave the editor dirty if anything below threw.
 *
 * Returning `0` for "cannot measure" is deliberate and load-bearing. Under
 * jsdom, inside a `display:none` panel, and before first paint, every layout
 * read is `0` — a measurement that reported `0` as *fits* would silently
 * disable collapsing wherever layout is unavailable. `0` means "no answer",
 * and the caller falls back to the line count.
 */
export function renderedHeightPx(text: string, editor: HTMLElement | null): number {
  if (editor === null || typeof document === 'undefined') return 0
  const width = editor.clientWidth
  if (width <= 0) return 0

  let probe: HTMLDivElement | null = null
  try {
    const computed = window.getComputedStyle(editor)
    probe = document.createElement('div')
    for (const property of MEASURED_STYLES) {
      probe.style.setProperty(property, computed.getPropertyValue(property))
    }
    probe.style.position = 'fixed'
    probe.style.left = '-10000px'
    probe.style.top = '0'
    probe.style.visibility = 'hidden'
    probe.style.height = 'auto'
    probe.style.minHeight = '0'
    probe.style.maxHeight = 'none'
    probe.style.overflow = 'visible'
    // `clientWidth` is content + padding and excludes the border, so a
    // border-box probe of exactly that width with no border of its own has the
    // same content width as the editor — and its `scrollHeight` is then the
    // element height the editor would need, in the same units as the budget.
    probe.style.boxSizing = 'border-box'
    probe.style.border = '0'
    probe.style.width = `${width}px`
    // The one property that is *not* copied blindly. A `white-space` that
    // collapses newlines would render a 40-line paste as one long line and
    // measure it as fitting — the exact paste this function exists to catch.
    const whiteSpace = computed.whiteSpace
    probe.style.whiteSpace = whiteSpace.startsWith('pre') ? whiteSpace : 'pre-wrap'
    probe.textContent = text
    document.body.appendChild(probe)
    return probe.scrollHeight
  } catch {
    return 0
  } finally {
    probe?.remove()
  }
}

/** Lines as a person counts them: `\n` separated, `\r\n` tolerated. */
export function countPastedLines(text: string): number {
  return text.split(/\r?\n/).length
}

export function measurePastedText(text: string, fit: PasteFit): PastedTextMeasure {
  return {
    lines: countPastedLines(text),
    heightPx: renderedHeightPx(text, fit.editor),
    maxHeightPx: fit.maxHeightPx,
  }
}

/**
 * Whether a plain-text paste becomes a chip instead of editor content.
 *
 * Rendered size decides when layout answered; the line count decides when it
 * did not. A standalone URL is exempt from both.
 */
export function shouldCollapsePaste(text: string, measure: PastedTextMeasure): boolean {
  if (text.trim() === '') return false
  if (isStandaloneHttpUrl(text)) return false
  if (measure.heightPx > 0 && measure.heightPx > measure.maxHeightPx) return true
  return measure.lines > MAX_INLINE_PASTE_LINES
}
