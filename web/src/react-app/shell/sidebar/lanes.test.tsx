/**
 * The two-rail system, measured off the rendered DOM.
 *
 * This file exists because the lane system cannot be reviewed. A row that
 * brings its own padding, or renders its glyph slot only when it has a glyph,
 * reads as completely ordinary in a diff and is visibly crooked — or worse,
 * jitters its own title as an indicator comes and goes. The only way to hold
 * the rule is to render the real sidebar and read the geometry back.
 *
 * What is measured, and the one thing that is asserted differently: jsdom has
 * no layout engine, so `measureRowLanes` accumulates the *declared* inline
 * geometry of the real elements (see `lane-measure.ts`). A lane smuggled in
 * through a utility class would therefore be invisible to it — so the last
 * test closes that gap directly, by asserting no row carries an inline-start
 * padding utility at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ROUTE_PATTERNS } from '@/app/routes'
import type { Project, SessionRow } from '@/app/types'
import { Sidebar } from '../sidebar'
import { SidebarLinkRow, SidebarSection } from './sidebar-row'
import { ROW_ATTR, measureAllRows, measureRowLanes } from './lane-measure'
import {
  SIDEBAR_GLYPH_LANE_PX,
  SIDEBAR_GLYPH_SIZE_PX,
  SIDEBAR_LABEL_LANE_PX,
  SIDEBAR_LANE_GAP_PX,
  SIDEBAR_ROW_BASE_PAD_PX,
  SIDEBAR_ROW_NEST_STEP_PX,
  SIDEBAR_SECTION_EDGE_PX,
} from './lane-metrics'

/**
 * The specification, written out.
 *
 * Every DOM assertion below is against these literals rather than against the
 * exported constants: measuring the rendered geometry and then comparing it to
 * the same constant the component used to draw it proves only that arithmetic
 * works. The numbers are the design.
 */
const GLYPH_LANE = 20
const LABEL_LANE = 44
const NEST_STEP = 16

function sessionRow(partial: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    project_id: 'alpha',
    title: partial.id,
    status: 'idle',
    created_at: '2026-07-31T10:00:00Z',
    updated_at: '2026-07-31T10:00:00Z',
    ...partial,
  }
}

const ROWS: SessionRow[] = [
  sessionRow({ id: 's-idle', title: 'Quiet session' }),
  sessionRow({ id: 's-running', title: 'Busy session', status: 'running' }),
]

const PROJECT: Project = {
  id: 'alpha',
  name: 'Alpha',
  directory: '/tmp/alpha',
  tier: 'local',
  default_model: null,
  default_effort: null,
  persona: null,
  memory_enabled: false,
}

vi.mock('@/react-app/domains/project/project-index', () => ({
  useProjectIndex: () => ({
    status: 'ready',
    projects: [PROJECT],
    fallbackProjectId: null,
    error: null,
  }),
}))

vi.mock('@/react-app/domains/session/queries/session-queries', () => ({
  useSessionRows: () => ({ data: ROWS, isLoading: false, error: null }),
  useCreateSession: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDeleteSession: () => ({ mutateAsync: vi.fn(async () => undefined) }),
}))

function renderSidebar() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/project/alpha/session/s-idle']}>
        <Routes>
          {/* The real pattern: the sidebar reads which project is open and
              which session is selected out of the URL, so a bare mount would
              measure a sidebar with no session rail at all. */}
          <Route path={ROUTE_PATTERNS.projectSession} element={<Sidebar />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return view.container.querySelector('aside') as HTMLElement
}

afterEach(cleanup)

describe('the two-rail lane system', () => {
  it('is 8 + 12 = 20 for the glyph lane and 20 + 16 + 8 = 44 for the label lane', () => {
    // The derivation, not the result: a change to any of the four inputs is a
    // change to where every row in the product sits.
    expect(SIDEBAR_SECTION_EDGE_PX).toBe(8)
    expect(SIDEBAR_ROW_BASE_PAD_PX).toBe(12)
    expect(SIDEBAR_GLYPH_SIZE_PX).toBe(16)
    expect(SIDEBAR_LANE_GAP_PX).toBe(8)
    expect(SIDEBAR_ROW_NEST_STEP_PX).toBe(NEST_STEP)
    expect(SIDEBAR_GLYPH_LANE_PX).toBe(GLYPH_LANE)
    expect(SIDEBAR_LABEL_LANE_PX).toBe(LABEL_LANE)
  })

  it('puts every glyph on 20px and every label on 44px', () => {
    const root = renderSidebar()
    const rows = measureAllRows(root)

    // Sanity: the fixture really did render rows to measure.
    expect(rows.length).toBeGreaterThan(3)
    for (const row of rows) {
      expect(row.glyphX).toBe(GLYPH_LANE)
      expect(row.labelX).toBe(LABEL_LANE)
    }
  })

  it('keeps the label lane identical whether or not the row has a glyph', () => {
    // The whole reason the glyph slot is rendered even when empty. One of
    // these rows is running and carries the activity dot-matrix, the other is
    // idle and carries nothing — and the title starts at the same x.
    const root = renderSidebar()

    const withGlyph = measureRowLanes(rowFor('Busy session'), root)
    const withoutGlyph = measureRowLanes(rowFor('Quiet session'), root)

    expect(withGlyph.hasGlyph).toBe(true)
    expect(withoutGlyph.hasGlyph).toBe(false)
    expect(withGlyph.labelX).toBe(withoutGlyph.labelX)
    expect(withoutGlyph.labelX).toBe(LABEL_LANE)
  })

  it('detects a row whose glyph slot is missing rather than measuring around it', () => {
    // Without this the file would be vacuous: a measurement that cannot fail
    // on the violation it exists to catch proves nothing.
    const root = document.createElement('div')
    const row = document.createElement('a')
    row.setAttribute(ROW_ATTR, '0')
    row.append(document.createElement('span'))
    root.append(row)

    expect(() => measureRowLanes(row, root)).toThrow(/first child/)
  })

  it('steps both lanes by 16px per depth, together', () => {
    render(
      <MemoryRouter>
        <SidebarSection title="Nesting">
          <SidebarLinkRow to="/" depth={1} label="child" />
          <SidebarLinkRow to="/" depth={2} label="grandchild" />
        </SidebarSection>
      </MemoryRouter>,
    )
    const root = document.body
    const [, child, grandchild] = measureAllRows(root)

    expect(child.glyphX).toBe(GLYPH_LANE + NEST_STEP)
    expect(child.labelX).toBe(LABEL_LANE + NEST_STEP)
    expect(grandchild.glyphX).toBe(GLYPH_LANE + 2 * NEST_STEP)
    expect(grandchild.labelX).toBe(LABEL_LANE + 2 * NEST_STEP)
    // The rails never converge: the gap between them is what a title is read
    // against, and it is the same at every depth.
    expect(grandchild.labelX - grandchild.glyphX).toBe(child.labelX - child.glyphX)
  })

  it('lets no row bring its own inline-start padding', () => {
    // The one thing the measurement above cannot see, because no stylesheet is
    // loaded in this environment: a lane smuggled in as a utility class.
    const root = renderSidebar()
    for (const row of root.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`)) {
      expect(row.className).not.toMatch(/(^|\s)-?(ps|pl|px|p)-/)
    }
  })
})

/** The lane-governed row that renders a given title. */
function rowFor(title: string): HTMLElement {
  const label = screen.getByText(title)
  const row = label.closest(`[${ROW_ATTR}]`)
  if (!(row instanceof HTMLElement)) throw new Error(`no lane-governed row for ${title}`)
  return row
}
