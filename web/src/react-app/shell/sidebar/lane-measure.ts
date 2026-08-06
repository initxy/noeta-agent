/**
 * Measuring where a rendered sidebar row actually puts its two lanes.
 *
 * This exists because the lane system is invisible in code review. A row that
 * renders its glyph slot conditionally, or brings its own padding, looks
 * completely reasonable in a diff and shifts every title beside it by 24px at
 * runtime. The only way to hold the rule is to read the geometry back off the
 * rendered tree, which is what `sidebar/lanes.test.tsx` does through here.
 *
 * **What it measures, and the one thing it cannot.** The test environment
 * (jsdom) has no layout engine: `getBoundingClientRect` is all zeroes and no
 * stylesheet is applied, so a real box-model measurement is not available.
 * What *is* available is the computed value of the inline geometry each row
 * declares — which is precisely why `lane-metrics.ts` declares it inline. So
 * this walks the real DOM from a row up to the sidebar root, accumulating the
 * inline-start padding of every ancestor, and reads the glyph slot's real
 * width and the row's real column gap off the elements that are actually
 * there. A missing glyph slot, a slot with the wrong width, an extra padded
 * wrapper, or a row at the wrong depth all move the numbers.
 *
 * The gap it cannot see is a lane expressed in a utility class, because no
 * stylesheet is loaded. `lanes.test.tsx` closes that one separately by
 * asserting no row carries an inline-start padding utility at all.
 */

/** The attribute a row's glyph slot is found by. Always the row's first child. */
export const GLYPH_SLOT_ATTR = 'data-sidebar-glyph-slot'

/** The attribute that marks a lane-governed row and carries its depth. */
export const ROW_ATTR = 'data-sidebar-row'

/** The attribute a row's label is found by. */
export const LABEL_ATTR = 'data-sidebar-label'

export interface RowLanes {
  /** The row's declared nesting depth. */
  depth: number
  /** x of the glyph lane, from the sidebar root's inner edge. */
  glyphX: number
  /** x of the label lane. */
  labelX: number
  /** Whether the glyph slot is currently holding anything. */
  hasGlyph: boolean
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function inlineStartPadding(element: Element): number {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (!style) return 0
  // `padding-inline-start` is what the row declares; `padding-left` is read as
  // the fallback so a future left-to-right-only row still measures.
  return pixels(style.paddingInlineStart || style.paddingLeft)
}

/**
 * Measure one row's two lanes, relative to `root`.
 *
 * Throws rather than returns a partial result when the row has no glyph slot
 * as its first child: that is the invariant this module exists to hold, and a
 * soft failure here would surface as an off-by-24px assertion somewhere else.
 */
export function measureRowLanes(row: HTMLElement, root: HTMLElement): RowLanes {
  const slot = row.firstElementChild
  if (!slot || !slot.hasAttribute(GLYPH_SLOT_ATTR)) {
    throw new Error(
      'sidebar row: the glyph slot must be the first child, even when it is empty',
    )
  }

  let offset = 0
  for (let node: Element | null = row; node && node !== root; node = node.parentElement) {
    offset += inlineStartPadding(node)
  }

  const view = row.ownerDocument.defaultView
  const slotStyle = view?.getComputedStyle(slot)
  const rowStyle = view?.getComputedStyle(row)
  const slotWidth = pixels(slotStyle?.inlineSize || slotStyle?.width || '')
  const gap = pixels(rowStyle?.columnGap || '')

  return {
    depth: Number.parseInt(row.getAttribute(ROW_ATTR) ?? '0', 10) || 0,
    glyphX: offset,
    labelX: offset + slotWidth + gap,
    hasGlyph: slot.childElementCount > 0,
  }
}

/** Measure every lane-governed row under `root`, in document order. */
export function measureAllRows(root: HTMLElement): RowLanes[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`)).map((row) =>
    measureRowLanes(row, root),
  )
}
