/**
 * The two-mode scroll machine, as a pure decision.
 *
 * A transcript that grows while you read it has exactly two states, and every
 * bug in this area is the machine picking the wrong one:
 *
 * - **sticky** — the reader is at the bottom and wants to stay there. New
 *   content re-anchors to the bottom.
 * - **manual** — the reader has scrolled away. Nothing may move the viewport
 *   until they ask, however much content arrives above them.
 *
 * The transition is hard because a scroll event does not say who caused it.
 * The browser fires the same event for a wheel flick, for our own
 * `scrollTop = scrollHeight`, and for scroll anchoring nudging the position as
 * content grows above. So the machine reads three inputs it *can* trust — a
 * recent input gesture, our own programmatic flag, and the sign and size of the
 * delta — and every constant below is a scar:
 *
 * - `GESTURE_WINDOW_MS = 600`. A single wheel flick between two programmatic
 *   scrolls was being missed at 250 ms. Widening the window is what makes "the
 *   user touched something recently" survive a burst of streaming re-anchors.
 * - `MANUAL_UPWARD_THRESHOLD_PX = 16`. Scroll anchoring and sub-pixel layout
 *   shifts routinely move the position up by a few pixels while content
 *   settles. Treating any upward delta as intent detaches the transcript from
 *   the bottom during a stream, for nobody.
 * - `EXACT_BOTTOM_GAP_PX = 1`. Re-arming sticky demands *exactly* the bottom,
 *   not "close enough": fractional heights mean a container is routinely a
 *   fraction of a pixel short, and a generous tolerance re-arms sticky under a
 *   reader who deliberately parked one line up.
 *
 * The whole thing is a function of numbers so the transitions can be tested
 * without a layout engine, which is the only way this stays honest — jsdom does
 * not scroll.
 */

/** "At the bottom" tolerance, in CSS pixels. */
export const EXACT_BOTTOM_GAP_PX = 1

/** How long an input gesture keeps counting as recent. */
export const GESTURE_WINDOW_MS = 600

/** Below this, an upward delta is anchoring jitter rather than intent. */
export const MANUAL_UPWARD_THRESHOLD_PX = 16

export type ScrollMode = 'sticky' | 'manual'

export interface ScrollSignals {
  /** `scrollTop` now minus `scrollTop` at the last event. Negative is upward. */
  delta: number
  /** A wheel / touch / scrollbar gesture landed inside the window. */
  gestured: boolean
  /** A scroll we asked for is still in flight. */
  programmatic: boolean
  /** The container is at its exact bottom. */
  atBottom: boolean
}

export type ScrollDecision =
  /** The reader escaped a scroll we were driving: abandon it and save where they are. */
  | 'abandon-programmatic'
  /** Our own scroll, uncontested. Refresh derived state and change nothing. */
  | 'ignore'
  /** Nothing but layout settling; re-arm sticky because the bottom is where we are. */
  | 'rearm-sticky'
  /** Nothing but layout settling, away from the bottom. Leave the mode alone. */
  | 'hold'
  /** Deliberate movement: record where the reader put themselves. */
  | 'save'

/**
 * Decide what one scroll event means.
 *
 * The order of the branches is the design. `abandon-programmatic` has to come
 * first: it is what lets the reader escape the tail *while* content growth is
 * still re-anchoring, and any other ordering makes a streaming turn feel like
 * it is fighting the wheel.
 */
export function decideScroll({
  delta,
  gestured,
  programmatic,
  atBottom,
}: ScrollSignals): ScrollDecision {
  const scrolledUp = delta <= -MANUAL_UPWARD_THRESHOLD_PX
  if (programmatic) return gestured || scrolledUp ? 'abandon-programmatic' : 'ignore'
  if (!gestured && !scrolledUp) return atBottom ? 'rearm-sticky' : 'hold'
  return 'save'
}

/** Whether a gesture stamped at `at` still counts at time `now`. */
export function gestureIsRecent(at: number | null, now: number): boolean {
  return at !== null && now - at < GESTURE_WINDOW_MS
}

export interface Metrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function isExactlyAtBottom({ scrollTop, scrollHeight, clientHeight }: Metrics): boolean {
  return scrollHeight - scrollTop - clientHeight <= EXACT_BOTTOM_GAP_PX
}

/**
 * The mode a saved position should carry.
 *
 * Deriving it from geometry rather than from which handler ran means the two
 * ways a reader reaches the bottom — scrolling there, and being taken there —
 * cannot disagree about what mode they left the session in.
 */
export function modeFor(metrics: Metrics): ScrollMode {
  return isExactlyAtBottom(metrics) ? 'sticky' : 'manual'
}

/**
 * `overflow-anchor` for a mode.
 *
 * `none` while sticky: we control the anchor, and the browser's own anchoring
 * fights our `scrollTop` writes. `auto` while manual: the browser holding the
 * reading position as content grows *above* is exactly what a reader browsing
 * history wants, and it is far smoother than anything we could do from a scroll
 * handler.
 */
export function overflowAnchorFor(mode: ScrollMode): 'none' | 'auto' {
  return mode === 'sticky' ? 'none' : 'auto'
}
