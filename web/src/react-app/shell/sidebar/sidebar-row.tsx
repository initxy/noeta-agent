/**
 * The sidebar's row primitives — the only things allowed to draw a row.
 *
 * Three rules, and the second one is the whole reason this file exists:
 *
 * 1. Compose a row from `sidebarRowStyle(depth)`; never an ad-hoc padding.
 * 2. **Render the glyph slot as the first child even when there is no glyph.**
 *    A slot that appears with its glyph moves every title beside it by 24px,
 *    so a session going idle → running would jitter its own title. Reserving
 *    the box unconditionally is what makes an indicator appear *in* a row
 *    rather than reflow it.
 * 3. Put a section label on the glyph lane; put every title on the label lane.
 *
 * The primitives are deliberately two concrete components rather than one
 * polymorphic one: the sidebar has exactly two kinds of row — a link that
 * navigates and a button that toggles — and a generic `as` prop would buy
 * nothing but type ceremony.
 *
 * Trailing affordances (counts, chevrons, hover actions, the outcome dot) are
 * **not** lane-governed. They live at the row's trailing edge and are free to
 * size themselves.
 */

import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { cn } from '@/react-app/design-system'
import { GLYPH_SLOT_ATTR, LABEL_ATTR, ROW_ATTR } from './lane-measure'
import { sidebarGlyphSlotStyle, sidebarRowStyle, sidebarSectionStyle } from './lane-metrics'

/**
 * The reserved 16px box at the head of every row.
 *
 * `aria-hidden` when empty, because an empty box is not something to announce;
 * a glyph placed inside it brings its own role and label.
 */
export function SidebarGlyphSlot({ children }: { children?: ReactNode }) {
  return (
    <span
      {...{ [GLYPH_SLOT_ATTR]: '' }}
      aria-hidden={children ? undefined : true}
      className="flex shrink-0 items-center justify-center"
      style={sidebarGlyphSlotStyle()}
    >
      {children}
    </span>
  )
}

const ROW_BASE =
  'group/row relative flex w-full items-center rounded-md py-1.5 pe-2 text-left text-sm ' +
  'text-ink-2 transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 ' +
  'focus-visible:ring-accent'

function RowBody({
  glyph,
  label,
  trailing,
}: {
  glyph?: ReactNode
  label: ReactNode
  trailing?: ReactNode
}) {
  return (
    <>
      <SidebarGlyphSlot>{glyph}</SidebarGlyphSlot>
      <span {...{ [LABEL_ATTR]: '' }} className="min-w-0 flex-1 truncate">
        {label}
      </span>
      {trailing}
    </>
  )
}

/**
 * The list a run of rows lives in.
 *
 * The reset is inline and not decorative: a browser's default stylesheet
 * indents `ul` by **40px**, which would silently push every row in it off both
 * lanes. Tailwind's preflight already zeroes it, but the lanes are absolute
 * measurements and must not depend on a stylesheet being loaded — pinning it
 * here is what makes the geometry true of the markup itself.
 */
export function SidebarRowList({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <ul
      className={cn('flex flex-col gap-0.5', className)}
      style={{ paddingInlineStart: 0, marginBlock: 0, listStyle: 'none' }}
    >
      {children}
    </ul>
  )
}

export interface SidebarRowProps {
  depth?: number
  glyph?: ReactNode
  label: ReactNode
  trailing?: ReactNode
  className?: string
  title?: string
}

export interface SidebarLinkRowProps extends SidebarRowProps {
  to: string
  onClick?: () => void
  'aria-label'?: string
}

/** A row that navigates. Active state comes from the URL, never from a store. */
export function SidebarLinkRow({
  to,
  depth = 0,
  glyph,
  label,
  trailing,
  className,
  title,
  onClick,
  'aria-label': ariaLabel,
}: SidebarLinkRowProps) {
  return (
    <NavLink
      to={to}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      style={sidebarRowStyle(depth)}
      {...{ [ROW_ATTR]: String(depth) }}
      className={({ isActive }) =>
        cn(ROW_BASE, isActive && 'bg-surface-2 text-ink', className)
      }
    >
      <RowBody glyph={glyph} label={label} trailing={trailing} />
    </NavLink>
  )
}

export interface SidebarButtonRowProps extends SidebarRowProps {
  onClick?: () => void
  expanded?: boolean
  disabled?: boolean
}

/** A row that toggles or acts. Same lanes, same glyph slot, no navigation. */
export function SidebarButtonRow({
  depth = 0,
  glyph,
  label,
  trailing,
  className,
  title,
  onClick,
  expanded,
  disabled,
}: SidebarButtonRowProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      style={sidebarRowStyle(depth)}
      {...{ [ROW_ATTR]: String(depth) }}
      className={cn(ROW_BASE, 'disabled:pointer-events-none disabled:opacity-50', className)}
    >
      <RowBody glyph={glyph} label={label} trailing={trailing} />
    </button>
  )
}

/**
 * A sidebar section: the 8px edge both lanes are cut from.
 *
 * The heading is a row like any other — same glyph slot, same lanes — so a
 * section title lines up with the titles underneath it. A section label could
 * instead sit on the *glyph* lane; that allowance is dropped here on purpose,
 * because "every label is on the label lane" is one rule instead of two and
 * there is nothing in this sidebar deep enough to need the distinction.
 */
export function SidebarSection({
  title,
  glyph,
  trailing,
  children,
}: {
  title: string
  glyph?: ReactNode
  trailing?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="py-2" style={sidebarSectionStyle()}>
      <div
        style={sidebarRowStyle(0)}
        {...{ [ROW_ATTR]: '0' }}
        className="flex items-center py-1"
      >
        <SidebarGlyphSlot>{glyph}</SidebarGlyphSlot>
        <h2
          {...{ [LABEL_ATTR]: '' }}
          className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-ink-3 uppercase"
        >
          {title}
        </h2>
        {trailing}
      </div>
      {children}
    </section>
  )
}
