/**
 * How a project's sessions are grouped into the sidebar's sections.
 *
 * Three sections, in this order: **Pinned**, **Sessions**, **Archived**.
 *
 * Two rules decide which one a session lands in, and the first one is not
 * obvious:
 *
 * - **Archived wins over pinned.** An archived session never joins the active
 *   list, not even a pinned one — archiving is the verb for "out of the way",
 *   and a pin that survived it would leave a row the user explicitly filed
 *   away sitting at the very top. The two columns stay independent in the
 *   store (unarchiving restores the pin), and they are reconciled here, in the
 *   one place that has to answer "where does this row go".
 * - **Pinned rows leave the main list.** A row is in exactly one section, so
 *   the sidebar never shows the same session twice.
 *
 * Within a section the order is recency, which is `session-order.ts`'s
 * comparator — one definition of "most recently touched" for the whole rail —
 * except that a **fork nests under its source**: a child session is emitted
 * directly beneath its parent and indented, so lineage reads at a glance. The
 * nesting is capped at one visible level; a fork of a fork is still placed
 * under its parent but not indented further.
 */

import type { SessionRow } from '@/app/types'
import { compareSessionRecency } from '../session-order'

export type SectionId = 'pinned' | 'sessions' | 'archived'

/** One row as the sidebar draws it: the server row plus what the sidebar knows. */
export interface SidebarSessionEntry {
  row: SessionRow
  pinned: boolean
  archived: boolean
  unread: boolean
  /** 0 for a top-level session, 1 for a fork nested under its source. */
  depth: number
}

export interface SidebarSection {
  id: SectionId
  title: string
  entries: SidebarSessionEntry[]
}

const TITLES: Record<SectionId, string> = {
  pinned: 'Pinned',
  sessions: 'Sessions',
  archived: 'Archived',
}

/**
 * Order a section's rows by recency, then nest each fork under its source.
 *
 * A child is spliced in directly after its parent and marked `depth: 1`. This
 * only fires when the parent is in the **same section**: a fork whose parent
 * was archived (or pinned, or lives in another project entirely) has no anchor
 * here, so it stays at top level and reads as an ordinary session — the honest
 * rendering of "its source is not in this list". Recency still orders the
 * top-level rows; a child rides its parent's position rather than its own, so
 * a busy fork does not drag its whole family to the top.
 *
 * One visible level only: a fork of a fork is placed under its parent but not
 * indented past `depth: 1`, because a rail that indents arbitrarily deep is a
 * tree nobody asked the sidebar to be.
 */
function nestForks(entries: SidebarSessionEntry[]): SidebarSessionEntry[] {
  const byRecency = (a: SidebarSessionEntry, b: SidebarSessionEntry) =>
    compareSessionRecency(a.row, b.row)
  const present = new Set(entries.map((entry) => entry.row.id))
  const childrenOf = new Map<string, SidebarSessionEntry[]>()
  const roots: SidebarSessionEntry[] = []

  for (const entry of entries) {
    const parent = entry.row.parent_session_id
    // A child anchors under its parent only when the parent is in this same
    // section; otherwise it is a root here.
    if (parent && present.has(parent)) {
      const bucket = childrenOf.get(parent)
      if (bucket) bucket.push(entry)
      else childrenOf.set(parent, [entry])
    } else {
      roots.push(entry)
    }
  }

  const ordered: SidebarSessionEntry[] = []
  const emit = (entry: SidebarSessionEntry, depth: number) => {
    ordered.push(depth === entry.depth ? entry : { ...entry, depth })
    const children = childrenOf.get(entry.row.id)
    if (!children) return
    // Capped at one visible level: a child's own children indent no further.
    for (const child of children.sort(byRecency)) emit(child, Math.min(depth + 1, 1))
  }
  for (const root of roots.sort(byRecency)) emit(root, 0)
  return ordered
}

/**
 * Partition and order.
 *
 * `Sessions` is always returned, even empty, because it is the section that
 * has to say "no sessions yet". The other two are omitted when empty: an empty
 * `Archived` heading is a label for a thing that does not exist.
 */
export function sessionSections(entries: readonly SidebarSessionEntry[]): SidebarSection[] {
  const pinned: SidebarSessionEntry[] = []
  const active: SidebarSessionEntry[] = []
  const archived: SidebarSessionEntry[] = []

  for (const entry of entries) {
    if (entry.archived) archived.push(entry)
    else if (entry.pinned) pinned.push(entry)
    else active.push(entry)
  }

  const sections: SidebarSection[] = []
  if (pinned.length > 0) {
    sections.push({ id: 'pinned', title: TITLES.pinned, entries: nestForks(pinned) })
  }
  sections.push({ id: 'sessions', title: TITLES.sessions, entries: nestForks(active) })
  if (archived.length > 0) {
    sections.push({ id: 'archived', title: TITLES.archived, entries: nestForks(archived) })
  }
  return sections
}

/** The rows a project's sidebar renders, with everything the sidebar derived. */
export function sidebarEntries(
  rows: readonly SessionRow[],
  organisation: (row: SessionRow) => { pinned: boolean; archived: boolean },
  unread: ReadonlySet<string>,
): SidebarSessionEntry[] {
  return rows.map((row) => {
    const { pinned, archived } = organisation(row)
    return { row, pinned, archived, unread: unread.has(row.id), depth: 0 }
  })
}
