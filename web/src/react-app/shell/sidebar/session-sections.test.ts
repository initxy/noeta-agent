import { describe, expect, it } from 'vitest'
import type { SessionRow } from '@/app/types'
import { sessionSections, sidebarEntries } from './session-sections'
import type { SidebarSessionEntry } from './session-sections'

function row(
  id: string,
  updatedAt = '2026-07-31T10:00:00Z',
  extra: Partial<SessionRow> = {},
): SessionRow {
  return {
    id,
    project_id: 'p1',
    title: id,
    status: 'idle',
    created_at: '2026-07-30T10:00:00Z',
    updated_at: updatedAt,
    ...extra,
  }
}

function entry(
  id: string,
  organisation: Partial<Omit<SidebarSessionEntry, 'row'>> = {},
  updatedAt?: string,
  rowExtra: Partial<SessionRow> = {},
): SidebarSessionEntry {
  return {
    row: row(id, updatedAt, rowExtra),
    pinned: false,
    archived: false,
    unread: false,
    depth: 0,
    ...organisation,
  }
}

const ids = (entries: SidebarSessionEntry[]) => entries.map((e) => e.row.id)
const shape = (entries: SidebarSessionEntry[]) =>
  entries.map((e) => [e.row.id, e.depth] as const)

describe('the sidebar sections', () => {
  it('files an archived session under Archived even when it is pinned', () => {
    // Archive is the verb for "out of the way". A pin that survived it would
    // leave a row the user explicitly filed away sitting at the very top.
    const sections = sessionSections([entry('a', { pinned: true, archived: true })])
    expect(sections.map((s) => s.id)).toEqual(['sessions', 'archived'])
    expect(ids(sections[1].entries)).toEqual(['a'])
  })

  it('shows a session in exactly one section', () => {
    const sections = sessionSections([
      entry('pinned', { pinned: true }),
      entry('plain'),
      entry('filed', { archived: true }),
    ])
    const everywhere = sections.flatMap((section) => ids(section.entries))
    expect(everywhere).toEqual(['pinned', 'plain', 'filed'])
    expect(new Set(everywhere).size).toBe(everywhere.length)
  })

  it('orders each section by recency, on the same comparator', () => {
    const sections = sessionSections([
      entry('pin-old', { pinned: true }, '2026-07-01T00:00:00Z'),
      entry('pin-new', { pinned: true }, '2026-07-20T00:00:00Z'),
      entry('old', {}, '2026-07-02T00:00:00Z'),
      entry('new', {}, '2026-07-21T00:00:00Z'),
    ])
    expect(ids(sections[0].entries)).toEqual(['pin-new', 'pin-old'])
    expect(ids(sections[1].entries)).toEqual(['new', 'old'])
  })

  it('always keeps the Sessions section, and drops the empty ones', () => {
    // `Sessions` is the section that has to say "no sessions yet"; a heading
    // for an empty archive is a label for a feature, not for content.
    const sections = sessionSections([])
    expect(sections.map((s) => s.id)).toEqual(['sessions'])
  })

  it('joins the server rows with what the sidebar derived', () => {
    const entries = sidebarEntries(
      [row('a'), row('b')],
      (candidate) => ({ pinned: candidate.id === 'a', archived: false }),
      new Set(['b']),
    )
    expect(entries.map((e) => [e.row.id, e.pinned, e.unread])).toEqual([
      ['a', true, false],
      ['b', false, true],
    ])
  })

  it('nests a fork under its source and indents it', () => {
    // The child rides its parent's position rather than its own recency, so a
    // busy fork does not drag its family to the top.
    const sections = sessionSections([
      entry('parent', {}, '2026-07-10T00:00:00Z'),
      entry('other', {}, '2026-07-20T00:00:00Z'),
      entry('fork', {}, '2026-07-25T00:00:00Z', { parent_session_id: 'parent' }),
    ])
    // `other` is newer than `parent`, so it sorts first; the fork follows its
    // parent at depth 1 regardless of its own recency.
    expect(shape(sections[0].entries)).toEqual([
      ['other', 0],
      ['parent', 0],
      ['fork', 1],
    ])
  })

  it('leaves a fork at top level when its source is not in the same section', () => {
    // Parent archived, child active: the child has no anchor in the Sessions
    // section, so it reads as an ordinary top-level session there.
    const sections = sessionSections([
      entry('parent', { archived: true }),
      entry('fork', {}, undefined, { parent_session_id: 'parent' }),
    ])
    const sessionsSection = sections.find((s) => s.id === 'sessions')!
    expect(shape(sessionsSection.entries)).toEqual([['fork', 0]])
  })

  it('caps nesting at one visible level for a fork of a fork', () => {
    const sections = sessionSections([
      entry('root'),
      entry('child', {}, undefined, { parent_session_id: 'root' }),
      entry('grandchild', {}, undefined, { parent_session_id: 'child' }),
    ])
    expect(shape(sections[0].entries)).toEqual([
      ['root', 0],
      ['child', 1],
      ['grandchild', 1],
    ])
  })
})
