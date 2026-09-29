/**
 * The sidebar's two-rail lane system.
 *
 * Two vertical rails, measured from the sidebar's own left edge:
 *
 * - **glyph lane, x = 20px** — the activity glyph, a disclosure chevron, a
 *   section's icon, and a section label when it is top-level.
 * - **label lane, x = 44px** — every row title, without exception.
 *
 * The numbers are not magic. They fall out of two composition rules, and
 * writing the derivation down is what stops the next row from inventing its
 * own padding:
 *
 * ```
 *   8px  section edge     SIDEBAR_SECTION_EDGE_PX
 * +12px  row lane         SIDEBAR_ROW_BASE_PAD_PX
 * ──────
 *  20px  GLYPH LANE       the glyph slot renders here, 16px wide
 * +16px  SIDEBAR_GLYPH_SIZE_PX
 * + 8px  SIDEBAR_LANE_GAP_PX
 * ──────
 *  44px  LABEL LANE
 * ```
 *
 * At tree depth *d* both rails step right by 16px, so glyph = 20 + 16d and
 * label = 44 + 16d.
 *
 * **Why these four values are inline styles rather than utility classes.**
 * They are the only geometry in the product that a test has to be able to read
 * back off the rendered tree: the jsdom test environment has no layout engine,
 * so a lane expressed as `ps-3` is invisible to any assertion and the system
 * degrades into four numbers nobody can check. Expressed inline, the whole
 * derivation is measurable from the DOM (see `lane-measure.ts`), which is what
 * makes `sidebar/lanes.test.tsx` a measurement rather than a restatement of
 * these constants. Everything that is *not* lane-governed — colours, radii,
 * hover states, trailing affordances — stays in utility classes.
 */

import type { CSSProperties } from 'react'

/** The section's own inset. A row's padding is measured from inside it. */
export const SIDEBAR_SECTION_EDGE_PX = 8

/** A depth-0 row's padding, inside the section edge. */
export const SIDEBAR_ROW_BASE_PAD_PX = 12

/** One step of nesting. Both rails move by it, so their spacing is invariant. */
export const SIDEBAR_ROW_NEST_STEP_PX = 16

/** The glyph slot: square, and the same size whether or not it holds a glyph. */
export const SIDEBAR_GLYPH_SIZE_PX = 16

/** Between the glyph slot and the label. */
export const SIDEBAR_LANE_GAP_PX = 8

/** x of the glyph lane at depth 0. */
export const SIDEBAR_GLYPH_LANE_PX = SIDEBAR_SECTION_EDGE_PX + SIDEBAR_ROW_BASE_PAD_PX

/** x of the label lane at depth 0. */
export const SIDEBAR_LABEL_LANE_PX =
  SIDEBAR_GLYPH_LANE_PX + SIDEBAR_GLYPH_SIZE_PX + SIDEBAR_LANE_GAP_PX

/**
 * A row's padding at depth *d*. Negative depths clamp to 0 rather than pulling
 * a row left of the lane — a bad depth should look ordinary, not broken.
 */
export function sidebarRowPaddingInlineStart(depth: number): number {
  return SIDEBAR_ROW_BASE_PAD_PX + Math.max(0, Math.trunc(depth)) * SIDEBAR_ROW_NEST_STEP_PX
}

/** Where the glyph lane sits at depth *d*, from the sidebar's left edge. */
export function sidebarGlyphLaneX(depth: number): number {
  return SIDEBAR_SECTION_EDGE_PX + sidebarRowPaddingInlineStart(depth)
}

/** Where the label lane sits at depth *d*, from the sidebar's left edge. */
export function sidebarLabelLaneX(depth: number): number {
  return sidebarGlyphLaneX(depth) + SIDEBAR_GLYPH_SIZE_PX + SIDEBAR_LANE_GAP_PX
}

/**
 * The inline half of a row's style. Every row in the sidebar takes it, and no
 * row anywhere sets its own inline-start padding.
 */
export function sidebarRowStyle(depth = 0): CSSProperties {
  return {
    paddingInlineStart: `${sidebarRowPaddingInlineStart(depth)}px`,
    columnGap: `${SIDEBAR_LANE_GAP_PX}px`,
  }
}

/** The inline half of the glyph slot's style: a fixed square, always. */
export function sidebarGlyphSlotStyle(): CSSProperties {
  return {
    inlineSize: `${SIDEBAR_GLYPH_SIZE_PX}px`,
    blockSize: `${SIDEBAR_GLYPH_SIZE_PX}px`,
  }
}

/** The inline half of a section's style: the 8px edge both lanes are cut from. */
export function sidebarSectionStyle(): CSSProperties {
  return {
    paddingInlineStart: `${SIDEBAR_SECTION_EDGE_PX}px`,
    paddingInlineEnd: `${SIDEBAR_SECTION_EDGE_PX}px`,
  }
}
